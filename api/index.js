require("dotenv").config();

const express   = require("express");
const { Pool }  = require("pg");
const fetch     = require("node-fetch");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");

const { buscarCargas }      = require("./ccee-abertos/cargas");
const { buscarMesRecente }  = require("./ccee-abertos/mcp");

const app = express();

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : "*"
}));

app.use(express.json());

// ─── Rate limiting ────────────────────────────────────────────────────────────

const isTest = process.env.NODE_ENV === "test";

// Limite geral: 60 req/min por IP (leitura normal do banco)
const limiteGeral = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  skip: () => isTest,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas requisições. Tente novamente em alguns segundos." }
});

// Limite estrito: 10 req/min por IP (endpoints que podem acionar o Power BI)
const limitePowerBI = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  skip: () => isTest,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Limite de consultas atingido. Aguarde 1 minuto." }
});

app.use(limiteGeral);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on("error", (err) => {
  console.error("Erro no pool de conexões:", err.message);
});

// Estimativa do mês de referência baseada na data atual
// Usada apenas como fallback quando não há dados históricos disponíveis
// O valor real sempre vem do último mês do histórico retornado pelo Power BI
function mesReferencia() {
  const hoje = new Date();
  const offset = hoje.getDate() <= 5 ? 3 : 2;
  const ref = new Date(hoje.getFullYear(), hoje.getMonth() - offset, 1);
  const ano = ref.getFullYear();
  const mes = String(ref.getMonth() + 1).padStart(2, "0");
  return `${ano}-${mes}`;
}

// Remove sufixos jurídicos, espaços extras e converte para maiúsculo
function normalizarAgente(nome) {
  return nome
    .replace(/\s*(LTDA\.?|S\.?A\.?|ME|EPP|EIRELI)\s*$/i, "")
    .trim()
    .toUpperCase();
}

// Converte "YYYY-MM" → "YYYY/MM" para o filtro do Power BI
function filtroMesAno(mes) {
  return mes === mesReferencia() ? "'(mais recente)'" : `'${mes.replace("-", "/")}'`;
}

// ─── Mapeamento de resultados ──────────────────────────────────────────────────

// json.jobIds[i] sempre corresponde à query i, independente da ordem em results[]
// Retorna { financeiro, historico, metadados } com o result correto para cada query
function mapearResultados(json) {
  const jobIds  = json?.jobIds  || [];
  const results = json?.results || [];

  const porJobId = {};
  results.forEach(r => { porJobId[r.jobId] = r; });

  return {
    financeiro:       porJobId[jobIds[0]] || null, // Query 0
    historico:        porJobId[jobIds[1]] || null, // Query 1
    metadados:        porJobId[jobIds[2]] || null, // Query 2
    recursoRequisito: porJobId[jobIds[3]] || null  // Query 3
  };
}

// ─── Extratores DSR ────────────────────────────────────────────────────────────

// Extrai dados financeiros — estrutura PH[1].DM1 com DS_ACR/VL_ACR
function extrairDados(result, agente, mes) {
  const dsr = result?.result?.data?.dsr?.DS?.[0];
  if (!dsr) throw new Error("Resposta inválida do Power BI: sem DSR (dados)");

  const dm = dsr?.PH?.[1]?.DM1;
  if (!dm || !Array.isArray(dm)) throw new Error("Resposta inválida do Power BI: sem DM1");

  const map = {};
  dm.forEach(x => {
    if (Array.isArray(x.C) && x.C.length >= 2) {
      map[x.C[0]] = x.C[1];
    }
  });

  return {
    agente,
    consumo:            Number(map["Consumo"])               || 0,
    compra:             Number(map["Compra"])                || 0,
    mcp:                Number(map["MCP"])                   || 0,
    resultado:          Number(map["Resultado com Ajustes"]) || 0,
    resultado_mcp:      Number(map["Resultado do MCP"])      || 0,
    balanco_energetico: Number(map["Balanço Energético"])    || 0,
    mes
  };
}

// Extrai série histórica genérica — estrutura PH[0].DM0 com delta compression + ValueDicts
// Colunas: [ANO, MES_NOME(D0), MES_ANO(D1), campoA, campoB]
// O último item tem o mês mais recente disponível no Power BI
function extrairSerieDSR(result, agente, campoA, campoB) {
  const dsr = result?.result?.data?.dsr?.DS?.[0];
  if (!dsr) return [];

  const dm = dsr?.PH?.[0]?.DM0;
  if (!dm || !Array.isArray(dm)) return [];

  const meses = dsr?.ValueDicts?.D1 || [];
  const rows  = [];
  let prev    = [];

  for (const item of dm) {
    const R    = typeof item.R === "number" ? item.R : 0;
    const C    = item.C || [];
    const full = [...prev.slice(0, R), ...C];
    prev = full;

    const mesVal = typeof full[2] === "number" ? meses[full[2]] : full[2];
    if (!mesVal || typeof mesVal !== "string") continue;

    const mes = mesVal.replace("/", "-");
    if (!/^\d{4}-\d{2}$/.test(mes)) continue;

    rows.push({ agente, mes, [campoA]: Number(full[3]) || 0, [campoB]: Number(full[4]) || 0 });
  }

  return rows;
}

// Merge de duas séries históricas por mês
function mergeHistorico(serieA, serieB) {
  const map = {};
  serieA.forEach(r => { map[r.mes] = { ...r }; });
  serieB.forEach(r => {
    if (map[r.mes]) Object.assign(map[r.mes], r);
    else map[r.mes] = { ...r };
  });
  return Object.values(map).sort((a, b) => a.mes.localeCompare(b.mes));
}

// Extrai metadados estáticos — estrutura PH[0].DM0 com ValueDicts (G0-G4 + M0)
function extrairMetadados(result, agente) {
  const dsr = result?.result?.data?.dsr?.DS?.[0];
  if (!dsr) {
    console.warn("Metadados não retornados pelo Power BI");
    return null;
  }

  const dm = dsr?.PH?.[0]?.DM0;
  if (!dm || !Array.isArray(dm) || dm.length === 0) return null;

  const row   = dm[0];
  const C     = row.C || [];
  const dicts = dsr.ValueDicts || {};

  // Power BI pode retornar valor direto (string) ou índice numérico no ValueDict
  const d = (key, idx) => {
    if (typeof idx === "string") return idx;
    return dicts[key] ? (dicts[key][idx] ?? null) : null;
  };

  return {
    agente,
    classe:         d("D0", C[0]) || null,
    razao_social:   d("D1", C[1]) || null,
    sigla:          d("D2", C[2]) || null,
    cnpj:           d("D3", C[3]) || null,
    situacao:       d("D4", C[4]) || null,
    capital_social: Number(C[5])  || 0
  };
}

// ─── Power BI ─────────────────────────────────────────────────────────────────

async function buscarPowerBI(agente, mes) {
  mes = mes || mesReferencia();
  console.log("Buscando no Power BI:", agente, "| mês:", mes);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  const body = {
    version: "1.0.0",
    queries: [
      // Query 0 — dados financeiros do mês (Consumo, Compra, MCP, Resultado...)
      {
        Query: {
          Commands: [{
            SemanticQueryDataShapeCommand: {
              Query: {
                Version: 2,
                From: [
                  { Name: "s", Entity: "SEGURANCA_MERCADO", Type: 0 },
                  { Name: "t", Entity: "TabelaBusca",       Type: 0 },
                  { Name: "c", Entity: "CALENDARIO",        Type: 0 }
                ],
                Select: [
                  { Column:      { Expression: { SourceRef: { Source: "s" } }, Property: "DS_ACR" } },
                  { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Source: "s" } }, Property: "VL_ACR" } }, Function: 0 } }
                ],
                Where: [
                  { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Valor"       } }], Values: [[{ Literal: { Value: `'${agente}'`       } }]] } } },
                  { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Tipo"        } }], Values: [[{ Literal: { Value: "'Agente'"           } }]] } } },
                  { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "c" } }, Property: "FiltroMesAno"} }], Values: [[{ Literal: { Value: filtroMesAno(mes)   } }]] } } }
                ]
              }
            }
          }]
        }
      },
      // Query 1 — histórico mensal (Balanço Energético + MCP, ~2 anos)
      {
        Query: {
          Commands: [{
            SemanticQueryDataShapeCommand: {
              Query: {
                Version: 2,
                From: [
                  { Name: "c", Entity: "CALENDARIO",        Type: 0 },
                  { Name: "m", Entity: "MEDIDAS_CALCULADAS", Type: 0 },
                  { Name: "t", Entity: "TabelaBusca",        Type: 0 }
                ],
                Select: [
                  { Column:      { Expression: { SourceRef: { Source: "c" } }, Property: "ANO"                 } },
                  { Column:      { Expression: { SourceRef: { Source: "c" } }, Property: "MES_NOME"             } },
                  { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Source: "c" } }, Property: "MES_ANO_FORMATADO" } }, Function: 3 } },
                  { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "Balanco_Energetico"   } },
                  { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "MCP"                  } }
                ],
                Where: [
                  { Condition: { In:      { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Tipo"  } }], Values: [[{ Literal: { Value: "'Agente'"    } }]] } } },
                  { Condition: { In:      { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Valor" } }], Values: [[{ Literal: { Value: `'${agente}'` } }]] } } },
                  { Condition: { Between: {
                    Expression:  { Column: { Expression: { SourceRef: { Source: "c" } }, Property: "DATA" } },
                    LowerBound:  { DateSpan: { Expression: { DateAdd: { Expression: { DateAdd: { Expression: { Now: {} }, Amount: 1, TimeUnit: 0 } }, Amount: -2, TimeUnit: 3 } }, TimeUnit: 0 } },
                    UpperBound:  { DateSpan: { Expression: { Now: {} }, TimeUnit: 0 } }
                  } } }
                ],
                OrderBy: [{ Direction: 1, Expression: { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Source: "c" } }, Property: "MES_ANO_FORMATADO" } }, Function: 3 } } }]
              },
              Binding: {
                Primary: { Groupings: [{ Projections: [0, 1, 2, 3, 4] }] },
                DataReduction: { DataVolume: 4, Primary: { Window: { Count: 1000 } } },
                SuppressedJoinPredicates: [2],
                Version: 1
              }
            }
          }]
        }
      },
      // Query 2 — metadados estáticos (CNPJ, razão social, classe, situação)
      {
        Query: {
          Commands: [{
            SemanticQueryDataShapeCommand: {
              Query: {
                Version: 2,
                From: [
                  { Name: "s", Entity: "SEGURANCA_MERCADO",  Type: 0 },
                  { Name: "m", Entity: "MEDIDAS_CALCULADAS", Type: 0 },
                  { Name: "t", Entity: "TabelaBusca",        Type: 0 },
                  { Name: "c", Entity: "CALENDARIO",         Type: 0 }
                ],
                Select: [
                  { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "NM_CSSE"        } },
                  { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "NM_RZOA_SOCI"   } },
                  { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "SG_AGEN"        } },
                  { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "CNPJ_Formatado" } },
                  { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "DS_STAT_AGEN"   } },
                  { Measure: { Expression: { SourceRef: { Source: "m" } }, Property: "Capital Social" } }
                ],
                Where: [
                  { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Tipo"        } }], Values: [[{ Literal: { Value: "'Agente'"         } }]] } } },
                  { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "c" } }, Property: "FiltroMesAno"} }], Values: [[{ Literal: { Value: "'(mais recente)'" } }]] } } },
                  { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Valor"       } }], Values: [[{ Literal: { Value: `'${agente}'`      } }]] } } }
                ]
              },
              Binding: {
                Primary: { Groupings: [{ Projections: [0, 1, 2, 3, 4, 5] }] },
                DataReduction: { DataVolume: 3, Primary: { Window: { Count: 500 } } },
                Version: 1
              }
            }
          }]
        }
      },
      // Query 3 — histórico mensal (Recurso=Compra + Requisito=Consumo, ~2 anos)
      {
        Query: {
          Commands: [{
            SemanticQueryDataShapeCommand: {
              Query: {
                Version: 2,
                From: [
                  { Name: "c", Entity: "CALENDARIO",         Type: 0 },
                  { Name: "m", Entity: "MEDIDAS_CALCULADAS", Type: 0 },
                  { Name: "t", Entity: "TabelaBusca",        Type: 0 }
                ],
                Select: [
                  { Column:      { Expression: { SourceRef: { Source: "c" } }, Property: "ANO"                 } },
                  { Column:      { Expression: { SourceRef: { Source: "c" } }, Property: "MES_NOME"             } },
                  { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Source: "c" } }, Property: "MES_ANO_FORMATADO" } }, Function: 3 } },
                  { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "Recurso"              } },
                  { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "Requisito"            } }
                ],
                Where: [
                  { Condition: { In:      { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Tipo"  } }], Values: [[{ Literal: { Value: "'Agente'"    } }]] } } },
                  { Condition: { In:      { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Valor" } }], Values: [[{ Literal: { Value: `'${agente}'` } }]] } } },
                  { Condition: { Between: {
                    Expression:  { Column: { Expression: { SourceRef: { Source: "c" } }, Property: "DATA" } },
                    LowerBound:  { DateSpan: { Expression: { DateAdd: { Expression: { DateAdd: { Expression: { Now: {} }, Amount: 1, TimeUnit: 0 } }, Amount: -2, TimeUnit: 3 } }, TimeUnit: 0 } },
                    UpperBound:  { DateSpan: { Expression: { Now: {} }, TimeUnit: 0 } }
                  } } }
                ],
                OrderBy: [{ Direction: 1, Expression: { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Source: "c" } }, Property: "MES_ANO_FORMATADO" } }, Function: 3 } } }]
              },
              Binding: {
                Primary: { Groupings: [{ Projections: [0, 1, 2, 3, 4] }] },
                DataReduction: { DataVolume: 4, Primary: { Window: { Count: 1000 } } },
                SuppressedJoinPredicates: [2],
                Version: 1
              }
            }
          }]
        }
      }
    ],
    modelId: Number(process.env.POWERBI_MODEL_ID)
  };

  try {
    const res = await fetch(
      "https://wabi-brazil-south-b-primary-api.analysis.windows.net/public/reports/querydata?synchronous=true",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PowerBI-ResourceKey": process.env.POWERBI_RESOURCE_KEY
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );

    clearTimeout(timer);

    if (!res.ok) throw new Error(`Power BI retornou HTTP ${res.status}`);

    const json = await res.json();
    console.log("Resposta Power BI recebida | results:", json?.results?.length);

    const { financeiro, historico, metadados, recursoRequisito } = mapearResultados(json);

    const serieBalMcp    = extrairSerieDSR(historico,        agente, "balanco_energetico", "mcp");
    const serieCompCons  = extrairSerieDSR(recursoRequisito, agente, "compra",             "consumo");
    const hist           = mergeHistorico(serieBalMcp, serieCompCons);

    // Usa o último mês do histórico como mês de referência real
    // Mais confiável do que calcular pelo dia de hoje
    const mesEfetivo = (hist.length > 0 && mes === mesReferencia())
      ? hist[hist.length - 1].mes
      : mes;

    const dados = extrairDados(financeiro, agente, mesEfetivo);
    const meta  = extrairMetadados(metadados, agente);

    return { dados, historico: hist, metadados: meta };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error("Timeout ao buscar Power BI (>15s)");
    throw err;
  }
}

// Busca apenas Q0 (financeiro) + Q2 (metadados) — usado quando a linha já existe
// no banco mas resultado IS NULL (histórico salvo, dados financeiros ainda faltam)
async function buscarPowerBISimples(agente, mes) {
  console.log("Buscando Q0+Q2 no Power BI:", agente, "| mês:", mes);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  const body = {
    version: "1.0.0",
    queries: [
      // Query 0 — dados financeiros do mês
      {
        Query: {
          Commands: [{
            SemanticQueryDataShapeCommand: {
              Query: {
                Version: 2,
                From: [
                  { Name: "s", Entity: "SEGURANCA_MERCADO", Type: 0 },
                  { Name: "t", Entity: "TabelaBusca",       Type: 0 },
                  { Name: "c", Entity: "CALENDARIO",        Type: 0 }
                ],
                Select: [
                  { Column:      { Expression: { SourceRef: { Source: "s" } }, Property: "DS_ACR" } },
                  { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Source: "s" } }, Property: "VL_ACR" } }, Function: 0 } }
                ],
                Where: [
                  { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Valor"       } }], Values: [[{ Literal: { Value: `'${agente}'`     } }]] } } },
                  { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Tipo"        } }], Values: [[{ Literal: { Value: "'Agente'"         } }]] } } },
                  { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "c" } }, Property: "FiltroMesAno"} }], Values: [[{ Literal: { Value: filtroMesAno(mes) } }]] } } }
                ]
              }
            }
          }]
        }
      },
      // Query 1 — metadados estáticos
      {
        Query: {
          Commands: [{
            SemanticQueryDataShapeCommand: {
              Query: {
                Version: 2,
                From: [
                  { Name: "s", Entity: "SEGURANCA_MERCADO",  Type: 0 },
                  { Name: "m", Entity: "MEDIDAS_CALCULADAS", Type: 0 },
                  { Name: "t", Entity: "TabelaBusca",        Type: 0 },
                  { Name: "c", Entity: "CALENDARIO",         Type: 0 }
                ],
                Select: [
                  { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "NM_CSSE"        } },
                  { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "NM_RZOA_SOCI"   } },
                  { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "SG_AGEN"        } },
                  { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "CNPJ_Formatado" } },
                  { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "DS_STAT_AGEN"   } },
                  { Measure: { Expression: { SourceRef: { Source: "m" } }, Property: "Capital Social" } }
                ],
                Where: [
                  { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Tipo"        } }], Values: [[{ Literal: { Value: "'Agente'"         } }]] } } },
                  { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "c" } }, Property: "FiltroMesAno"} }], Values: [[{ Literal: { Value: "'(mais recente)'" } }]] } } },
                  { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Valor"       } }], Values: [[{ Literal: { Value: `'${agente}'`      } }]] } } }
                ]
              },
              Binding: {
                Primary: { Groupings: [{ Projections: [0, 1, 2, 3, 4, 5] }] },
                DataReduction: { DataVolume: 3, Primary: { Window: { Count: 500 } } },
                Version: 1
              }
            }
          }]
        }
      }
    ],
    modelId: Number(process.env.POWERBI_MODEL_ID)
  };

  try {
    const res = await fetch(
      "https://wabi-brazil-south-b-primary-api.analysis.windows.net/public/reports/querydata?synchronous=true",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PowerBI-ResourceKey": process.env.POWERBI_RESOURCE_KEY
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );

    clearTimeout(timer);

    if (!res.ok) throw new Error(`Power BI retornou HTTP ${res.status}`);

    const json = await res.json();
    const jobIds   = json?.jobIds  || [];
    const results  = json?.results || [];
    const porJobId = {};
    results.forEach(r => { porJobId[r.jobId] = r; });

    const dados = extrairDados(porJobId[jobIds[0]] || null, agente, mes);
    const meta  = extrairMetadados(porJobId[jobIds[1]] || null, agente);

    return { dados, metadados: meta };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error("Timeout ao buscar Power BI (>15s)");
    throw err;
  }
}

// ─── Persistência ─────────────────────────────────────────────────────────────

async function salvarAgente(meta) {
  if (!meta) return;
  await pool.query(`
    INSERT INTO ccee_agentes (agente, razao_social, sigla, cnpj, classe, situacao, capital_social)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (agente) DO UPDATE SET
      razao_social   = EXCLUDED.razao_social,
      sigla          = EXCLUDED.sigla,
      cnpj           = EXCLUDED.cnpj,
      classe         = EXCLUDED.classe,
      situacao       = EXCLUDED.situacao,
      capital_social = EXCLUDED.capital_social,
      updated_at     = NOW()
  `, [meta.agente, meta.razao_social, meta.sigla, meta.cnpj, meta.classe, meta.situacao, meta.capital_social]);
}

// Salva histórico em batch — ON CONFLICT DO NOTHING para não sobrescrever dados completos (Q0)
async function salvarHistorico(rows) {
  if (!rows.length) return;
  await pool.query(`
    INSERT INTO ccee_dados (agente, mes, balanco_energetico, mcp, compra, consumo)
    SELECT * FROM UNNEST($1::text[], $2::char(7)[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[])
    ON CONFLICT (agente, mes) DO UPDATE SET
      balanco_energetico = EXCLUDED.balanco_energetico,
      mcp                = EXCLUDED.mcp,
      compra             = COALESCE(EXCLUDED.compra,  ccee_dados.compra),
      consumo            = COALESCE(EXCLUDED.consumo, ccee_dados.consumo)
  `, [
    rows.map(r => r.agente),
    rows.map(r => r.mes),
    rows.map(r => r.balanco_energetico ?? 0),
    rows.map(r => r.mcp               ?? 0),
    rows.map(r => r.compra  || null),
    rows.map(r => r.consumo || null),
  ]);

  // Converte zeros legados para NULL para não distorcer o gráfico
  const agente = rows[0]?.agente;
  await pool.query(`
    UPDATE ccee_dados
    SET compra  = CASE WHEN compra  = 0 THEN NULL ELSE compra  END,
        consumo = CASE WHEN consumo = 0 THEN NULL ELSE consumo END
    WHERE agente = $1 AND resultado IS NULL
  `, [agente]);

  console.log(`Histórico: ${rows.length} meses salvos para ${agente}`);
}

async function salvarDados(dado) {
  await pool.query(`
    INSERT INTO ccee_dados
      (agente, consumo, compra, mcp, resultado, resultado_mcp, balanco_energetico, mes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (agente, mes) DO UPDATE SET
      consumo            = EXCLUDED.consumo,
      compra             = EXCLUDED.compra,
      mcp                = EXCLUDED.mcp,
      resultado          = EXCLUDED.resultado,
      resultado_mcp      = EXCLUDED.resultado_mcp,
      balanco_energetico = EXCLUDED.balanco_energetico,
      created_at         = NOW()
  `, [dado.agente, dado.consumo, dado.compra, dado.mcp, dado.resultado, dado.resultado_mcp, dado.balanco_energetico, dado.mes]);
}

async function fetchSalvarRetornar(agente, mes) {
  const { dados, historico, metadados } = await buscarPowerBI(agente, mes);
  await salvarAgente(metadados);    // deve vir primeiro (FK)
  await salvarHistorico(historico); // ON CONFLICT DO NOTHING — não sobrescreve Q0
  await salvarDados(dados);         // ON CONFLICT DO UPDATE — sempre atualiza o mês consultado
  return combinarResposta(dados, metadados);
}

// Variante leve: só Q0+Q2, usada quando o mês já existe no banco mas resultado é NULL
async function fetchSalvarRetornarSimples(agente, mes) {
  const { dados, metadados } = await buscarPowerBISimples(agente, mes);
  await salvarAgente(metadados); // atualiza metadados se necessário
  await salvarDados(dados);      // preenche os campos financeiros que estavam NULL
  return combinarResposta(dados, metadados);
}

function combinarResposta(dados, meta) {
  return {
    ...dados,
    razao_social:   meta?.razao_social  ?? null,
    sigla:          meta?.sigla         ?? null,
    cnpj:           meta?.cnpj          ?? null,
    classe:         meta?.classe        ?? null,
    situacao:       meta?.situacao      ?? null,
    capital_social: meta?.capital_social ?? null
  };
}

async function salvarCargas(agente, siglaPerfilAgente, registros) {
  if (!registros.length) return;

  const parseDate = (v) => {
    if (!v) return null;
    const s = v.toString().trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
    return null;
  };

  await pool.query(`
    INSERT INTO ccee_cargas (
      agente, sigla_perfil_agente, mes_referencia,
      cod_perf_agente, nome_empresarial, cod_parcela_carga, sigla_parcela_carga,
      cnpj_carga, cidade, estado_uf, ramo_atividade, submercado, data_migracao,
      cod_perf_agente_conectado, sigla_perfil_agente_conectado,
      capacidade_carga, consumo_acl, consumo_cativo_parc_livre, consumo_total
    )
    SELECT * FROM UNNEST(
      $1::text[], $2::text[], $3::char(7)[],
      $4::text[], $5::text[], $6::text[], $7::text[],
      $8::text[], $9::text[], $10::char(2)[], $11::text[], $12::text[], $13::date[],
      $14::text[], $15::text[],
      $16::numeric[], $17::numeric[], $18::numeric[], $19::numeric[]
    )
    ON CONFLICT (sigla_parcela_carga, mes_referencia) DO NOTHING
  `, [
    registros.map(() => agente),
    registros.map(() => siglaPerfilAgente),
    registros.map(r => r.mes_referencia),
    registros.map(r => r.cod_perf_agente              || null),
    registros.map(r => r.nome_empresarial              || null),
    registros.map(r => r.cod_parcela_carga             || null),
    registros.map(r => r.sigla_parcela_carga           || null),
    registros.map(r => r.cnpj_carga                    || null),
    registros.map(r => r.cidade                        || null),
    registros.map(r => r.estado_uf                     || null),
    registros.map(r => r.ramo_atividade                || null),
    registros.map(r => r.submercado                    || null),
    registros.map(r => parseDate(r.data_migracao)),
    registros.map(r => r.cod_perf_agente_conectado     || null),
    registros.map(r => r.sigla_perfil_agente_conectado || null),
    registros.map(r => r.capacidade_carga              != null ? Number(r.capacidade_carga)           : null),
    registros.map(r => r.consumo_acl                   != null ? Number(r.consumo_acl)                : null),
    registros.map(r => r.consumo_cativo_parc_livre     != null ? Number(r.consumo_cativo_parc_livre)  : null),
    registros.map(r => r.consumo_total                 != null ? Number(r.consumo_total)              : null),
  ]);

  console.log(`Cargas: ${registros.length} registros salvos para ${agente}`);
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected", ts: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: "error", db: "disconnected", error: e.message });
  }
});

// GET /inteligencia/:agente — dados do mês + metadados
// Query param opcional: ?mes=YYYY-MM (default: mês recente)
app.get("/inteligencia/:agente", limitePowerBI, async (req, res) => {
  const agenteRaw = decodeURIComponent(req.params.agente);
  if (!agenteRaw || agenteRaw.trim().length < 2)
    return res.status(400).json({ error: "Nome de agente inválido" });

  const agente = normalizarAgente(agenteRaw);
  const mes    = req.query.mes || mesReferencia();

  if (!/^\d{4}-\d{2}$/.test(mes))
    return res.status(400).json({ error: "Formato de mês inválido (esperado: YYYY-MM)" });

  console.log("Consultando agente:", agente, "| mês:", mes);

  try {
    const r = await pool.query(`
      SELECT d.*, a.razao_social, a.sigla, a.cnpj, a.classe, a.situacao, a.capital_social
      FROM ccee_dados d
      LEFT JOIN ccee_agentes a USING (agente)
      WHERE d.agente = $1 AND d.mes = $2
      LIMIT 1
    `, [agente, mes]);

    if (req.query.refresh) {
      console.log("Refresh forçado via GET para:", agente, "| mês:", mes);
      return res.json(await fetchSalvarRetornar(agente, mes));
    }

    if (r.rows.length > 0) {
      const row = r.rows[0];

      // Verifica se há mês mais recente disponível na API aberta
      if (!req.query.mes) {
        const mesMaxDB  = await pool.query("SELECT MAX(mes) AS mes FROM ccee_dados WHERE agente = $1", [agente]);
        const mesDB     = mesMaxDB.rows[0]?.mes;
        const mesRecente = await buscarMesRecente(agente);
        console.log(`Freshness check | banco="${mesDB}" | CCEE="${mesRecente}"`);

        if (mesRecente && mesDB && mesRecente > mesDB) {
          console.log(`Dados desatualizados — buscando mês ${mesRecente} no Power BI...`);
          return res.json(await fetchSalvarRetornar(agente, mesRecente));
        }
      }

      if (row.resultado !== null) {
        console.log("Dado retornado do banco");
        return res.json(row);
      }
      console.log("Dados incompletos no banco, buscando Q0+Q2 no Power BI...");
      return res.json(await fetchSalvarRetornarSimples(agente, mes));
    }

    console.log("Não encontrado no banco, buscando Power BI...");
    return res.json(await fetchSalvarRetornar(agente, mes));
  } catch (e) {
    console.error("Erro:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /inteligencia/:agente/historico — todos os meses do agente com metadados
app.get("/inteligencia/:agente/historico", async (req, res) => {
  const agenteRaw = decodeURIComponent(req.params.agente);
  if (!agenteRaw || agenteRaw.trim().length < 2)
    return res.status(400).json({ error: "Nome de agente inválido" });

  const agente = normalizarAgente(agenteRaw);

  try {
    const r = await pool.query(`
      SELECT d.*, a.razao_social, a.sigla, a.cnpj, a.classe, a.situacao, a.capital_social
      FROM ccee_dados d
      LEFT JOIN ccee_agentes a USING (agente)
      WHERE d.agente = $1
      ORDER BY d.mes ASC
    `, [agente]);

    return res.json(r.rows);
  } catch (e) {
    console.error("Erro:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /inteligencia/:agente/cargas — parcelas de carga (banco ou API aberta CCEE)
// Query params opcionais: ?estado=SP&cidade=SAO+PAULO&ramo=INDUSTRIA&submercado=SE
app.get("/inteligencia/:agente/cargas", async (req, res) => {
  const agenteRaw = decodeURIComponent(req.params.agente);
  if (!agenteRaw || agenteRaw.trim().length < 2)
    return res.status(400).json({ error: "Nome de agente inválido" });

  const agente = normalizarAgente(agenteRaw);
  const { estado, cidade, ramo, submercado, mes } = req.query;

  try {
    // Verifica se já existe no banco
    const existe = await pool.query(
      "SELECT 1 FROM ccee_cargas WHERE agente = $1 LIMIT 1",
      [agente]
    );

    const maxCargasDB = existe.rows.length > 0
      ? (await pool.query("SELECT MAX(mes_referencia) AS mes FROM ccee_cargas WHERE agente = $1", [agente])).rows[0]?.mes
      : null;

    const precisaAtualizar = !maxCargasDB || (mes && mes > maxCargasDB);

    if (precisaAtualizar) {
      console.log(`[cargas] Buscando na API aberta | banco="${maxCargasDB}" | solicitado="${mes}"...`);
      const registros = await buscarCargas(agente);
      console.log(`[cargas] API retornou ${registros.length} registros`);
      if (registros.length > 0) await salvarCargas(agente, agente, registros);
    } else {
      console.log(`[cargas] Banco atualizado até "${maxCargasDB}", sem necessidade de rebuscar`);
    }

    // Resolve o mês a usar: se solicitado mas sem dados, cai pro mais recente disponível
    let mesEfetivo = mes || null;
    if (mesEfetivo) {
      const check = await pool.query(
        "SELECT 1 FROM ccee_cargas WHERE agente = $1 AND mes_referencia = $2 LIMIT 1",
        [agente, mesEfetivo]
      );
      if (check.rows.length === 0) {
        const ultimo = await pool.query(
          "SELECT MAX(mes_referencia) AS mes FROM ccee_cargas WHERE agente = $1",
          [agente]
        );
        mesEfetivo = ultimo.rows[0]?.mes || null;
      }
    }

    // Monta query com filtros opcionais
    const conditions = ["agente = $1"];
    const params     = [agente];
    let   idx        = 2;

    if (mesEfetivo)  { conditions.push(`mes_referencia = $${idx++}`);      params.push(mesEfetivo); }
    if (estado)      { conditions.push(`estado_uf = $${idx++}`);           params.push(estado.toUpperCase()); }
    if (cidade)      { conditions.push(`cidade ILIKE $${idx++}`);          params.push(cidade); }
    if (ramo)        { conditions.push(`ramo_atividade ILIKE $${idx++}`);  params.push(ramo); }
    if (submercado)  { conditions.push(`submercado ILIKE $${idx++}`);      params.push(submercado); }

    const r = await pool.query(`
      SELECT * FROM ccee_cargas
      WHERE ${conditions.join(" AND ")}
      ORDER BY mes_referencia DESC, sigla_parcela_carga ASC
    `, params);

    return res.json({ mes: mesEfetivo, registros: r.rows });
  } catch (e) {
    console.error("Erro em /cargas:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// POST /inteligencia/:agente/refresh — força busca no Power BI
app.post("/inteligencia/:agente/refresh", limitePowerBI, async (req, res) => {
  const agenteRaw = decodeURIComponent(req.params.agente);
  if (!agenteRaw || agenteRaw.trim().length < 2)
    return res.status(400).json({ error: "Nome de agente inválido" });

  const agente = normalizarAgente(agenteRaw);
  const mes    = req.query.mes || mesReferencia();
  console.log("Refresh forçado para:", agente, "| mês:", mes);

  try {
    return res.json(await fetchSalvarRetornar(agente, mes));
  } catch (e) {
    console.error("Erro no refresh:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Pinga o banco a cada 6h para evitar pausa por inatividade (Aiven free tier)
if (process.env.NODE_ENV !== "test") {
  setInterval(() => {
    pool.query("SELECT 1").catch(err =>
      console.error("Keep-alive falhou:", err.message)
    );
  }, 6 * 60 * 60 * 1000);
}

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`API rodando em http://localhost:${PORT}`));
}

module.exports = app;
