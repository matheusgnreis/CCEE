require("dotenv").config();

const express   = require("express");
const { Pool }  = require("pg");
const fetch     = require("node-fetch");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");

const { buscarCargas }            = require("./ccee-abertos/cargas");
const { buscarGeracaoHoraria }    = require("./ccee-abertos/geracao-horaria");
const { buscarUsinas }            = require("./ccee-abertos/geracao");
const { buscarContabilizacao }    = require("./ccee-abertos/contabilizacao");
const { buscarMesRecente }        = require("./ccee-abertos/mcp");
const { buscarDesligamento }      = require("./ccee-abertos/desligamento");
const { buscarConsumoHorario, listarRecursos: listarRecursosConsumo } = require("./ccee-abertos/consumo-horario");
const { buscarPldHorario, buscarPldHorarioMapa, anosDisponiveis: anosDisponiveisPld } = require("./ccee-abertos/pld-horario");
const { normalizarMes } = require("./ccee-abertos/utils");
const cron                        = require("node-cron");

// Cache do mês mais recente disponível nas cargas da CCEE (TTL 1 hora)
let _mesCCEECache = { mes: null, ts: 0 };
async function ultimoMesDisponivelCCEE() {
  const agora = Date.now();
  if (_mesCCEECache.mes && agora - _mesCCEECache.ts < 60 * 60 * 1000) {
    return _mesCCEECache.mes;
  }
  try {
    const recursos = await listarRecursosConsumo();
    const mes = recursos[recursos.length - 1]?.mes || null;
    if (mes) _mesCCEECache = { mes, ts: agora };
    return mes;
  } catch (e) {
    console.warn("[freshness] Erro ao consultar meses disponíveis na CCEE:", e.message);
    return _mesCCEECache.mes || null; // retorna cache antigo se houver
  }
}

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
  connectionString:          process.env.DATABASE_URL,
  ssl:                       { rejectUnauthorized: false },
  max:                       process.env.NODE_ENV === "production" ? 10 : 4,
  idleTimeoutMillis:         60000,   // fecha conexão idle depois de 60s
  connectionTimeoutMillis:   30000,
  keepAlive:                 true,    // TCP keepalive — evita queda durante downloads longos
  keepAliveInitialDelayMillis: 10000, // começa a enviar probes após 10s de idle
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
    recursoRequisito: porJobId[jobIds[3]] || null, // Query 3
    geracaoSerie:     porJobId[jobIds[4]] || null  // Query 4
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
    geracao:            Number(map["Geração"])               || null,
    venda:              Number(map["Venda"])                 || null,
    consumo_geracao:    Number(map["Cons.da Ger."])          || null,
    mre_mais:           map["MRE +"]  != null ? (Number(map["MRE +"]) || null)  : null,
    mre_menos:          map["MRE -"]  != null ? (Number(map["MRE -"]) || null)  : null,
    mes
  };
}

// Extrai série histórica genérica — bitmask DSR (Ø = null-mask, R = carry-mask)
// Colunas: [ANO, MES_NOME(D0), MES_ANO(D1), campoA, campoB, (campoC?)]
function extrairSerieDSR(result, agente, campoA, campoB, campoC = null) {
  const dsr = result?.result?.data?.dsr?.DS?.[0];
  if (!dsr) return [];

  const dm = dsr?.PH?.[0]?.DM0;
  if (!dm || !Array.isArray(dm)) return [];

  const meses = dsr?.ValueDicts?.D1 || [];
  const rows  = [];
  const N     = campoC ? 6 : 5;
  let prev    = new Array(N).fill(null);

  for (const item of dm) {
    const C    = item.C || [];
    const full = new Array(N).fill(null);
    let ci     = 0;

    if (typeof item["Ø"] === "number") {
      // Ø: bit=1 → campo é null (omitido de C), bit=0 → próximo valor de C
      const mask = item["Ø"];
      for (let i = 0; i < N; i++)
        full[i] = (mask & (1 << i)) ? null : (C[ci++] ?? null);
    } else {
      // R: bit=1 → carrega de prev, bit=0 → próximo valor de C
      const mask = typeof item.R === "number" ? item.R : 0;
      for (let i = 0; i < N; i++)
        full[i] = (mask & (1 << i)) ? prev[i] : (C[ci++] ?? null);
    }
    prev = full;

    const mesVal = typeof full[2] === "number" ? meses[full[2]] : full[2];
    if (!mesVal || typeof mesVal !== "string") continue;

    const mes = mesVal.replace("/", "-");
    if (!/^\d{4}-\d{2}$/.test(mes)) continue;

    const row = { agente, mes, [campoA]: Number(full[3]) || 0, [campoB]: Number(full[4]) || 0 };
    if (campoC) row[campoC] = full[5] != null ? Number(full[5]) || null : null;
    rows.push(row);
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

// Extrai série histórica de Montante Gerado (7 colunas, bitmask real Ø/R)
// Colunas: [ANO, MES_NOME, MES_ANO(D1), Montante Gerado, Compra, % compra, % geração alocada]
// Ø row: bit=1 → campo é null (omitido de C). R row: bit=1 → campo é carried de prev.
function extrairSerieGeracao(result, agente) {
  const dsr = result?.result?.data?.dsr?.DS?.[0];
  if (!dsr) return [];

  const dm = dsr?.PH?.[0]?.DM0;
  if (!dm || !Array.isArray(dm)) return [];

  const meses = dsr?.ValueDicts?.D1 || [];
  const rows  = [];
  const N     = 7;
  let prev    = new Array(N).fill(null);

  for (const item of dm) {
    const C    = item.C || [];
    const full = new Array(N).fill(null);
    let ci     = 0;

    if (typeof item["Ø"] === "number") {
      // Ø: bit=1 → null, bit=0 → next C value
      const mask = item["Ø"];
      for (let i = 0; i < N; i++)
        full[i] = (mask & (1 << i)) ? null : (C[ci++] ?? null);
    } else {
      // R: bit=1 → carry from prev, bit=0 → next C value
      const mask = typeof item.R === "number" ? item.R : 0;
      for (let i = 0; i < N; i++)
        full[i] = (mask & (1 << i)) ? prev[i] : (C[ci++] ?? null);
    }
    prev = full;

    const mesVal = typeof full[2] === "number" ? meses[full[2]] : full[2];
    if (!mesVal || typeof mesVal !== "string") continue;

    const mes = mesVal.replace("/", "-");
    if (!/^\d{4}-\d{2}$/.test(mes)) continue;

    rows.push({ agente, mes, geracao: full[3] != null ? (Number(full[3]) || null) : null });
  }

  return rows;
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

async function buscarPowerBI(agente, mes, usarMaisRecente = false) {
  mes = mes || mesReferencia();
  console.log("Buscando no Power BI:", agente, "| mês:", mes, usarMaisRecente ? "| filtro: (mais recente)" : "");

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
                  { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "c" } }, Property: "FiltroMesAno"} }], Values: [[{ Literal: { Value: usarMaisRecente ? "'(mais recente)'" : filtroMesAno(mes) } }]] } } }
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
      },
      // Query 4 — série histórica de Montante Gerado (~2 anos)
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
                  { Column:      { Expression: { SourceRef: { Source: "c" } }, Property: "MES_NOME"            } },
                  { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Source: "c" } }, Property: "MES_ANO_FORMATADO" } }, Function: 3 } },
                  { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "Montante Gerado"     } },
                  { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "Compra"              } },
                  { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "% compra"            } },
                  { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "% de geração alocada no recurso do agente" } }
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
                Primary: { Groupings: [{ Projections: [0, 1, 2, 3, 4, 5, 6] }] },
                DataReduction: { DataVolume: 4, Primary: { Window: { Count: 1000 } } },
                SuppressedJoinPredicates: [2, 5, 6],
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

    const { financeiro, historico, metadados, recursoRequisito, geracaoSerie } = mapearResultados(json);

    const serieBalMcp    = extrairSerieDSR(historico,        agente, "balanco_energetico", "mcp");
    const serieCompCons  = extrairSerieDSR(recursoRequisito, agente, "compra",             "consumo");
    const serieGeracao   = extrairSerieGeracao(geracaoSerie, agente);
    const hist           = mergeHistorico(mergeHistorico(serieBalMcp, serieCompCons), serieGeracao);

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
async function buscarPowerBISimples(agente, mes, usarMaisRecente = false) {
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
                  { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "c" } }, Property: "FiltroMesAno"} }], Values: [[{ Literal: { Value: usarMaisRecente ? "'(mais recente)'" : filtroMesAno(mes) } }]] } } }
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

// ─── PLD Power BI ─────────────────────────────────────────────────────────────

// Decodifica tabela flat [DataHora, SUBMERCADO_TEXTO, PLDhora_avg] com bitmask DSR
// Filtragem por data usa BRT (UTC-3) → médias mensais exatas sem desvio de fuso
function parsePldBiFlat(result) {
  const dsr   = result?.result?.data?.dsr?.DS?.[0];
  if (!dsr) return [];
  const dm0   = dsr?.PH?.[0]?.DM0 || [];
  const dicts = dsr?.ValueDicts || {};
  const rows  = [];
  const N     = 3;
  let prev    = new Array(N).fill(null);

  for (const item of dm0) {
    const C    = item.C || [];
    const full = new Array(N).fill(null);
    let ci     = 0;

    if (typeof item["Ø"] === "number") {
      const mask = item["Ø"];
      for (let i = 0; i < N; i++)
        full[i] = (mask & (1 << i)) ? null : (C[ci++] ?? null);
    } else {
      const mask = typeof item.R === "number" ? item.R : 0;
      for (let i = 0; i < N; i++)
        full[i] = (mask & (1 << i)) ? prev[i] : (C[ci++] ?? null);
    }
    prev = full;

    const ts = full[0];
    if (!ts || typeof ts !== "number") continue;

    const rawSub = full[1];
    const sub    = typeof rawSub === "number"
      ? (dicts.D0?.[rawSub] ?? "").toLowerCase()
      : String(rawSub ?? "").toLowerCase();

    // Measure values are usually raw floats, but Power BI may compress them into D1
    const rawPld = full[2];
    if (rawPld == null) continue;
    let pld;
    if (dicts.D1 && Number.isInteger(rawPld) && rawPld >= 0 && rawPld < dicts.D1.length) {
      pld = Number(dicts.D1[rawPld] ?? rawPld);
    } else {
      pld = Number(rawPld);
    }
    if (!sub || isNaN(pld)) continue;

    // Power BI envia timestamps como hora local BRT tratada como UTC (naive local time)
    // Não aplicar offset — usar UTC components diretamente como BRT
    const dt      = new Date(ts);
    const dataStr = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,"0")}-${String(dt.getUTCDate()).padStart(2,"0")}`;
    const horaStr = `${String(dt.getUTCHours()).padStart(2,"0")}:00`;

    rows.push({ ts, data: dataStr, hora: horaStr, sub, pld });
  }
  return rows;
}

async function buscarPldBi(diaHoje, diasPrevMes) {
  // +2 dias de margem; max: 31+31+2=64 dias → 64*24*4=6144 linhas < Window 7000
  const diasTotal = diaHoje + diasPrevMes + 2;

  const lower = {
    DateSpan: {
      Expression: {
        DateAdd: {
          Expression: { DateAdd: { Expression: { Now: {} }, Amount: 1, TimeUnit: 0 } },
          Amount: -diasTotal, TimeUnit: 0
        }
      },
      TimeUnit: 0
    }
  };

  const body = {
    version: "1.0.0",
    queries: [{
      Query: {
        Commands: [{
          SemanticQueryDataShapeCommand: {
            Query: {
              Version: 2,
              From: [
                { Name: "d", Entity: "DataHora",           Type: 0 },
                { Name: "m", Entity: "Medidas Calculadas", Type: 0 },
                { Name: "s", Entity: "Submercado",         Type: 0 }
              ],
              Select: [
                { Column:  { Expression: { SourceRef: { Source: "d" } }, Property: "Data_Hora"                } },
                { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "SUBMERCADO_TEXTO"          } },
                { Measure: { Expression: { SourceRef: { Source: "m" } }, Property: "PLDHorario Media PLDhora" } }
              ],
              Where: [{
                Condition: {
                  Between: {
                    Expression: { Column: { Expression: { SourceRef: { Source: "d" } }, Property: "Data_Hora" } },
                    LowerBound: lower,
                    UpperBound: { DateSpan: { Expression: { Now: {} }, TimeUnit: 0 } }
                  }
                }
              }]
            },
            Binding: {
              Primary: { Groupings: [{ Projections: [0, 1, 2] }] },
              DataReduction: { DataVolume: 4, Primary: { Window: { Count: 7000 } } },
              Version: 1
            }
          }
        }]
      }
    }],
    cancelQueries: [],
    modelId: Number(process.env.POWERBI_PLD_MODEL_ID || 7203757)
  };

  const res = await fetch(
    "https://wabi-brazil-south-b-primary-api.analysis.windows.net/public/reports/querydata?synchronous=true",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PowerBI-ResourceKey": process.env.POWERBI_PLD_RESOURCE_KEY || process.env.POWERBI_RESOURCE_KEY
      },
      body: JSON.stringify(body)
    }
  );

  if (!res.ok) throw new Error(`Power BI PLD HTTP ${res.status}`);
  return parsePldBiFlat((await res.json())?.results?.[0]);
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
    INSERT INTO ccee_dados (agente, mes, balanco_energetico, mcp, compra, consumo, geracao)
    SELECT * FROM UNNEST($1::text[], $2::char(7)[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[])
    ON CONFLICT (agente, mes) DO UPDATE SET
      balanco_energetico = EXCLUDED.balanco_energetico,
      mcp                = EXCLUDED.mcp,
      compra             = COALESCE(EXCLUDED.compra,   ccee_dados.compra),
      consumo            = COALESCE(EXCLUDED.consumo,  ccee_dados.consumo),
      geracao            = COALESCE(EXCLUDED.geracao,  ccee_dados.geracao)
  `, [
    rows.map(r => r.agente),
    rows.map(r => r.mes),
    rows.map(r => r.balanco_energetico ?? 0),
    rows.map(r => r.mcp               ?? 0),
    rows.map(r => r.compra   || null),
    rows.map(r => r.consumo  || null),
    rows.map(r => r.geracao  || null),
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

function calcMcpRsMwh(mcp, consumo, mes, balanco = null) {
  if (!mcp || !mes) return null;
  const divisor = (consumo > 0) ? consumo : (balanco && balanco !== 0 ? balanco : null);
  if (!divisor) return null;
  const [ano, mesNum] = mes.split("-").map(Number);
  const horas = new Date(ano, mesNum, 0).getDate() * 24;
  return Math.round((mcp / (divisor * horas)) * 10000) / 10000;
}

async function salvarDados(dado) {
  const mcpRsMwh = calcMcpRsMwh(dado.mcp, dado.consumo, dado.mes, dado.balanco_energetico);
  await pool.query(`
    INSERT INTO ccee_dados
      (agente, consumo, compra, mcp, resultado, resultado_mcp, balanco_energetico, geracao, venda, consumo_geracao, mcp_rs_mwh, mre_mais, mre_menos, mes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (agente, mes) DO UPDATE SET
      consumo            = EXCLUDED.consumo,
      compra             = EXCLUDED.compra,
      mcp                = EXCLUDED.mcp,
      resultado          = EXCLUDED.resultado,
      resultado_mcp      = EXCLUDED.resultado_mcp,
      balanco_energetico = EXCLUDED.balanco_energetico,
      geracao            = COALESCE(EXCLUDED.geracao,         ccee_dados.geracao),
      venda              = COALESCE(EXCLUDED.venda,           ccee_dados.venda),
      consumo_geracao    = COALESCE(EXCLUDED.consumo_geracao, ccee_dados.consumo_geracao),
      mcp_rs_mwh         = EXCLUDED.mcp_rs_mwh,
      mre_mais           = COALESCE(EXCLUDED.mre_mais,        ccee_dados.mre_mais),
      mre_menos          = COALESCE(EXCLUDED.mre_menos,       ccee_dados.mre_menos),
      created_at         = NOW()
  `, [dado.agente, dado.consumo, dado.compra, dado.mcp, dado.resultado, dado.resultado_mcp, dado.balanco_energetico, dado.geracao ?? null, dado.venda ?? null, dado.consumo_geracao ?? null, mcpRsMwh, dado.mre_mais ?? null, dado.mre_menos ?? null, dado.mes]);
}

async function fetchSalvarRetornar(agente, mes, usarMaisRecente = false) {
  const { dados, historico, metadados } = await buscarPowerBI(agente, mes, usarMaisRecente);
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
    mcp_rs_mwh:     calcMcpRsMwh(dados.mcp, dados.consumo, dados.mes, dados.balanco_energetico),
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
    ON CONFLICT (agente, sigla_parcela_carga, mes_referencia) DO NOTHING
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

async function salvarUsinas(agente, siglaPerfilAgente, registros) {
  if (!registros.length) return;

  const parseDate = (v) => {
    if (!v) return null;
    const s = v.toString().trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
    return null;
  };

  // API pode retornar números como "50%" ou "50,00" — remove símbolo e normaliza separador
  const parseNum = (v) => {
    if (v == null) return null;
    const n = Number(String(v).replace("%", "").replace(",", ".").trim());
    return isNaN(n) ? null : n;
  };

  await pool.query(`
    INSERT INTO ccee_usinas (
      agente, sigla_perfil, mes_referencia,
      sigla_ativo, cod_parcela_usina, sigla_parcela_usina,
      tipo_despacho, fonte_energia_primaria, submercado, estado_uf,
      caracteristica_parcela, participante_mre, participante_regime_cotas,
      data_inicio_op_com, percentual_desconto_usina, cap_t,
      geracao_centro_gravidade, gf_centro_gravidade
    )
    SELECT * FROM UNNEST(
      $1::text[], $2::text[], $3::char(7)[],
      $4::text[], $5::text[], $6::text[],
      $7::text[], $8::text[], $9::text[], $10::char(2)[],
      $11::text[], $12::text[], $13::text[],
      $14::date[], $15::numeric[], $16::numeric[],
      $17::numeric[], $18::numeric[]
    )
    ON CONFLICT (sigla_parcela_usina, mes_referencia) DO NOTHING
  `, [
    registros.map(() => agente),
    registros.map(() => siglaPerfilAgente),
    registros.map(r => r.mes_referencia),
    registros.map(r => r.sigla_ativo                               || null),
    registros.map(r => r.cod_parcela_usina                         || null),
    registros.map(r => r.sigla_parcela_usina                       || null),
    registros.map(r => r.tipo_despacho                             || null),
    registros.map(r => r.fonte_energia_primaria                    || null),
    registros.map(r => r.submercado                                || null),
    registros.map(r => r.estado_uf                                 || null),
    registros.map(r => r.caracteristica_parcela                    || null),
    registros.map(r => r.participante_mre                          || null),
    registros.map(r => r.participante_regime_cotas                 || null),
    registros.map(r => parseDate(r.data_inicio_op_com)),
    registros.map(r => parseNum(r.percentual_desconto_usina)),
    registros.map(r => parseNum(r.cap_t)),
    registros.map(r => parseNum(r.geracao_centro_gravidade)),
    registros.map(r => parseNum(r.gf_centro_gravidade)),
  ]);

  console.log(`Usinas: ${registros.length} registros salvos para ${agente}`);
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

  // Mês explícito do usuário (seletor) — vai direto ao banco/PowerBI sem checar CCEE
  if (req.query.mes) {
    const mes = req.query.mes;
    if (!/^\d{4}-\d{2}$/.test(mes))
      return res.status(400).json({ error: "Formato de mês inválido (esperado: YYYY-MM)" });

    console.log("Consultando agente:", agente, "| mês:", mes);

    if (req.query.refresh)
      return res.json(await fetchSalvarRetornar(agente, mes));

    const r = await pool.query(`
      SELECT d.*, a.razao_social, a.sigla, a.cnpj, a.classe, a.situacao, a.capital_social
      FROM ccee_dados d
      LEFT JOIN ccee_agentes a USING (agente)
      WHERE d.agente = $1 AND d.mes = $2 LIMIT 1
    `, [agente, mes]);

    if (r.rows.length > 0) {
      const row = r.rows[0];
      if (row.resultado !== null) { console.log("Dado retornado do banco"); return res.json(row); }
      return res.json(await fetchSalvarRetornarSimples(agente, mes));
    }
    return res.json(await fetchSalvarRetornar(agente, mes));
  }

  // Sem mês explícito: bate no MCP primeiro para saber o mês mais recente,
  // depois compara com o banco e decide o que buscar.
  console.log("Consultando agente:", agente, "| mês: (auto)");

  try {
    const [mesRecente, rMaxDB] = await Promise.all([
      ultimoMesDisponivelCCEE(),
      pool.query("SELECT MAX(mes) AS mes FROM ccee_dados WHERE agente = $1", [agente]),
    ]);
    const mesDB = rMaxDB.rows[0]?.mes || null;

    // Mês alvo = o mais recente entre CCEE e banco (CCEE tem prioridade se for mais novo)
    const mes = mesRecente && (!mesDB || mesRecente >= mesDB)
      ? mesRecente
      : (mesDB || mesReferencia());

    console.log(`Freshness | CCEE="${mesRecente}" banco="${mesDB}" → usando "${mes}"`);

    // CCEE tem mês mais novo que o banco → busca da fonte
    if (mesRecente && (!mesDB || mesRecente > mesDB)) {
      console.log(`Dados desatualizados — buscando ${mes} no Power BI...`);
      const novosDados = await fetchSalvarRetornar(agente, mes, true);

      // Se o mês novo voltou zerado, ainda não foi liquidado pela CCEE para este agente.
      // Apaga a entrada vazia do banco e retorna o mês anterior.
      const vazio = !novosDados.consumo && !novosDados.mcp && !novosDados.balanco_energetico;
      if (vazio && mesDB) {
        console.log(`Mês ${mes} sem dados para "${agente}" — removendo e retornando ${mesDB}`);
        await pool.query("DELETE FROM ccee_dados WHERE agente = $1 AND mes = $2", [agente, mes]);
        const rAnterior = await pool.query(`
          SELECT d.*, a.razao_social, a.sigla, a.cnpj, a.classe, a.situacao, a.capital_social
          FROM ccee_dados d LEFT JOIN ccee_agentes a USING (agente)
          WHERE d.agente = $1 AND d.mes = $2 LIMIT 1
        `, [agente, mesDB]);
        if (rAnterior.rows.length > 0) return res.json(rAnterior.rows[0]);
      }

      return res.json(novosDados);
    }

    // Banco já tem o mês mais recente — retorna do banco
    const r = await pool.query(`
      SELECT d.*, a.razao_social, a.sigla, a.cnpj, a.classe, a.situacao, a.capital_social
      FROM ccee_dados d
      LEFT JOIN ccee_agentes a USING (agente)
      WHERE d.agente = $1 AND d.mes = $2 LIMIT 1
    `, [agente, mes]);

    if (r.rows.length > 0) {
      const row = r.rows[0];
      if (row.resultado !== null) { console.log("Dado retornado do banco"); return res.json(row); }
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

    // Dispara cálculo de modulação (consumo e geração) em background
    if (r.rows.length > 0) {
      dispararModulacaoBackground(agente).catch(err =>
        console.warn("[modulacao-auto] Erro ao disparar:", err.message)
      );
      dispararModulacaoGeracaoBackground(agente).catch(err =>
        console.warn("[mod-ger-auto] Erro ao disparar:", err.message)
      );
    }

    const rows = r.rows.map(row => ({
      ...row,
      mcp_rs_mwh: row.mcp_rs_mwh ?? calcMcpRsMwh(row.mcp, row.consumo, row.mes, row.balanco_energetico),
    }));
    return res.json(rows);
  } catch (e) {
    console.error("Erro:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /inteligencia/:agente/modulacao — resultados calculados + status do batch
app.get("/inteligencia/:agente/modulacao", async (req, res) => {
  const agenteRaw = decodeURIComponent(req.params.agente);
  if (!agenteRaw || agenteRaw.trim().length < 2)
    return res.status(400).json({ error: "Nome de agente inválido" });

  const agente = normalizarAgente(agenteRaw);

  try {
    const [resultados, totalMeses] = await Promise.all([
      pool.query(`
        SELECT mes_referencia, submercado, consumo_total_mwh, n_horas,
               custo_modulacao_rs_mwh, soma_curva_rs, soma_flat_rs
        FROM ccee_modulacao
        WHERE agente = $1
        ORDER BY mes_referencia DESC, submercado ASC
      `, [agente]),
      pool.query(`
        SELECT COUNT(*) AS total
        FROM ccee_dados
        WHERE agente = $1 AND mes >= $2
      `, [agente, PRIMEIRO_MES_PLD])
    ]);

    const calculando = modulacaoEmAndamento.has(agente) || modulacaoGeracaoEmAndamento.has(agente);

    return res.json({
      calculando,
      fila_global: { ativa: filaProcessamento.ativa, tamanho: filaProcessamento.tamanho },
      total_meses: Number(totalMeses.rows[0].total),
      calculados:  resultados.rows.length,
      resultados:  resultados.rows,
    });
  } catch (e) {
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
  const { estado, cidade, ramo, submercado, mes, razao_social: razaoSocialParam } = req.query;

  try {
    // Verifica se já existe no banco
    const existe = await pool.query(
      "SELECT 1 FROM ccee_cargas WHERE agente = $1 LIMIT 1",
      [agente]
    );

    const maxCargasDB = existe.rows.length > 0
      ? (await pool.query("SELECT MAX(mes_referencia) AS mes FROM ccee_cargas WHERE agente = $1", [agente])).rows[0]?.mes
      : null;

    const mesRecenteCCEE = await ultimoMesDisponivelCCEE();
    const precisaAtualizar = !maxCargasDB || (mesRecenteCCEE && mesRecenteCCEE > maxCargasDB);

    if (precisaAtualizar) {
      console.log(`[cargas] Buscando na API aberta | banco="${maxCargasDB}" | CCEE="${mesRecenteCCEE}"...`);
      const metaAgente  = razaoSocialParam
        ? { rows: [{ razao_social: razaoSocialParam }] }
        : await pool.query("SELECT razao_social FROM ccee_agentes WHERE agente = $1", [agente]);
      const razaoSocial = metaAgente.rows[0]?.razao_social || null;
      const registros   = await buscarCargas(agente, { razaoSocial });
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
    const SUB_MAP_FULL = { SE: "SUDESTE", S: "SUL", NE: "NORDESTE", N: "NORTE" };
    const conditions = ["agente = $1"];
    const params     = [agente];
    let   idx        = 2;

    if (mesEfetivo) { conditions.push(`mes_referencia = $${idx++}`); params.push(mesEfetivo); }

    // Estado: aceita múltiplos valores separados por vírgula (ex: "MG,SP")
    if (estado) {
      const estados = estado.toUpperCase().split(",").map(e => e.trim()).filter(Boolean);
      if (estados.length === 1) {
        conditions.push(`estado_uf = $${idx++}`);
        params.push(estados[0]);
      } else if (estados.length > 1) {
        conditions.push(`estado_uf = ANY($${idx++})`);
        params.push(estados);
      }
    }

    if (cidade)     { conditions.push(`cidade ILIKE $${idx++}`);         params.push(cidade); }
    if (ramo)       { conditions.push(`ramo_atividade ILIKE $${idx++}`); params.push(ramo); }
    if (submercado) {
      const subFull = SUB_MAP_FULL[submercado.toUpperCase()] || submercado;
      conditions.push(`submercado ILIKE $${idx++}`);
      params.push(subFull);
    }

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

// GET /inteligencia/:agente/usinas — unidades geradoras (DB-first, mesma lógica de cargas)
app.get("/inteligencia/:agente/usinas", async (req, res) => {
  const agenteRaw = decodeURIComponent(req.params.agente);
  if (!agenteRaw || agenteRaw.trim().length < 2)
    return res.status(400).json({ error: "Nome de agente inválido" });

  const agente = normalizarAgente(agenteRaw);
  const { fonte, submercado, estado, mes, razao_social: razaoSocialParam } = req.query;

  try {
    const existe = await pool.query(
      "SELECT 1 FROM ccee_usinas WHERE agente = $1 LIMIT 1",
      [agente]
    );

    const maxUsinaDB = existe.rows.length > 0
      ? (await pool.query("SELECT MAX(mes_referencia) AS mes FROM ccee_usinas WHERE agente = $1", [agente])).rows[0]?.mes
      : null;

    const mesRecenteCCEEU = await ultimoMesDisponivelCCEE();
    const precisaAtualizar = !maxUsinaDB || (mesRecenteCCEEU && mesRecenteCCEEU > maxUsinaDB);

    if (precisaAtualizar) {
      console.log(`[usinas] Buscando na API aberta | banco="${maxUsinaDB}" | CCEE="${mesRecenteCCEEU}"...`);
      const metaAgente  = razaoSocialParam
        ? { rows: [{ razao_social: razaoSocialParam }] }
        : await pool.query("SELECT razao_social FROM ccee_agentes WHERE agente = $1", [agente]);
      const razaoSocial = metaAgente.rows[0]?.razao_social || null;
      if (!razaoSocial) {
        console.warn(`[usinas] razao_social não encontrada para "${agente}" — busca ignorada`);
      } else {
        const registros = await buscarUsinas(razaoSocial);
        console.log(`[usinas] API retornou ${registros.length} registros`);
        if (registros.length > 0) {
          await salvarUsinas(agente, agente, registros);
          // Dispara modulação de geração agora que as usinas estão no banco
          dispararModulacaoGeracaoBackground(agente).catch(err =>
            console.warn("[mod-ger-auto] Erro ao disparar após usinas:", err.message)
          );
        }
      }
    } else {
      console.log(`[usinas] Banco atualizado até "${maxUsinaDB}", sem necessidade de rebuscar`);
    }

    let mesEfetivo = mes || null;
    if (mesEfetivo) {
      const check = await pool.query(
        "SELECT 1 FROM ccee_usinas WHERE agente = $1 AND mes_referencia = $2 LIMIT 1",
        [agente, mesEfetivo]
      );
      if (check.rows.length === 0) {
        const ultimo = await pool.query(
          "SELECT MAX(mes_referencia) AS mes FROM ccee_usinas WHERE agente = $1",
          [agente]
        );
        mesEfetivo = ultimo.rows[0]?.mes || null;
      }
    }

    const conditions = ["agente = $1"];
    const params     = [agente];
    let   idx        = 2;

    if (mesEfetivo) { conditions.push(`mes_referencia = $${idx++}`);             params.push(mesEfetivo); }
    if (fonte)      { conditions.push(`fonte_energia_primaria ILIKE $${idx++}`); params.push(fonte); }
    if (submercado) { conditions.push(`submercado ILIKE $${idx++}`);             params.push(submercado); }
    if (estado)     { conditions.push(`estado_uf = $${idx++}`);                  params.push(estado.toUpperCase()); }

    const r = await pool.query(`
      SELECT * FROM ccee_usinas
      WHERE ${conditions.join(" AND ")}
      ORDER BY mes_referencia DESC, sigla_ativo ASC
    `, params);

    return res.json({ mes: mesEfetivo, registros: r.rows });
  } catch (e) {
    console.error("Erro em /usinas:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ─── Contabilização por perfil ────────────────────────────────────────────────

async function salvarContabilizacao(agente, registros) {
  if (!registros.length) return;
  const BATCH = 200;
  for (let i = 0; i < registros.length; i += BATCH) {
    const lote = registros.slice(i, i + BATCH);
    await pool.query(`
      INSERT INTO ccee_contabilizacao (
        agente, mes_referencia, sigla_perfil_agente, nome_empresarial, cod_perf_agente,
        valor_tm_mcp, compensacao_mre, valor_encargo, valor_ajuste_exposicao,
        valor_ajuste_alivio_ret, efeito_contrat_disp, efeito_contrat_cota_gf,
        efeito_contrat_nuclear, ajuste_recontab, ajuste_mcsd_ex,
        resultado_financeiro_er, efeito_ccearq, efeito_contrat_itaipu,
        efeito_repasse_risco_hidro, efeito_desloc_pld_cmo, resultado_final
      )
      SELECT * FROM UNNEST(
        $1::text[], $2::char(7)[], $3::text[], $4::text[], $5::integer[],
        $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[],
        $10::numeric[], $11::numeric[], $12::numeric[],
        $13::numeric[], $14::numeric[], $15::numeric[],
        $16::numeric[], $17::numeric[], $18::numeric[],
        $19::numeric[], $20::numeric[], $21::numeric[]
      )
      ON CONFLICT (agente, mes_referencia, sigla_perfil_agente) DO UPDATE SET
        valor_tm_mcp               = EXCLUDED.valor_tm_mcp,
        compensacao_mre            = EXCLUDED.compensacao_mre,
        valor_encargo              = EXCLUDED.valor_encargo,
        valor_ajuste_exposicao     = EXCLUDED.valor_ajuste_exposicao,
        valor_ajuste_alivio_ret    = EXCLUDED.valor_ajuste_alivio_ret,
        efeito_contrat_disp        = EXCLUDED.efeito_contrat_disp,
        efeito_contrat_cota_gf     = EXCLUDED.efeito_contrat_cota_gf,
        efeito_contrat_nuclear     = EXCLUDED.efeito_contrat_nuclear,
        ajuste_recontab            = EXCLUDED.ajuste_recontab,
        ajuste_mcsd_ex             = EXCLUDED.ajuste_mcsd_ex,
        resultado_financeiro_er    = EXCLUDED.resultado_financeiro_er,
        efeito_ccearq              = EXCLUDED.efeito_ccearq,
        efeito_contrat_itaipu      = EXCLUDED.efeito_contrat_itaipu,
        efeito_repasse_risco_hidro = EXCLUDED.efeito_repasse_risco_hidro,
        efeito_desloc_pld_cmo      = EXCLUDED.efeito_desloc_pld_cmo,
        resultado_final            = EXCLUDED.resultado_final,
        created_at                 = NOW()
    `, [
      lote.map(() => agente),
      lote.map(r => r.mes_referencia),
      lote.map(r => r.sigla_perfil_agente || null),
      lote.map(r => r.nome_empresarial   || null),
      lote.map(r => r.cod_perf_agente    != null ? Number(r.cod_perf_agente) : null),
      lote.map(r => r.valor_tm_mcp),
      lote.map(r => r.compensacao_mre),
      lote.map(r => r.valor_encargo),
      lote.map(r => r.valor_ajuste_exposicao),
      lote.map(r => r.valor_ajuste_alivio_ret),
      lote.map(r => r.efeito_contrat_disp),
      lote.map(r => r.efeito_contrat_cota_gf),
      lote.map(r => r.efeito_contrat_nuclear),
      lote.map(r => r.ajuste_recontab),
      lote.map(r => r.ajuste_mcsd_ex),
      lote.map(r => r.resultado_financeiro_er),
      lote.map(r => r.efeito_ccearq),
      lote.map(r => r.efeito_contrat_itaipu),
      lote.map(r => r.efeito_repasse_risco_hidro),
      lote.map(r => r.efeito_desloc_pld_cmo),
      lote.map(r => r.resultado_final),
    ]);
  }
  console.log(`Contabilização: ${registros.length} registros salvos para ${agente}`);
}

// GET /inteligencia/:agente/desligamento — situação de desligamento por descumprimento
app.get("/inteligencia/:agente/desligamento", async (req, res) => {
  const agenteRaw = decodeURIComponent(req.params.agente);
  if (!agenteRaw || agenteRaw.trim().length < 2)
    return res.status(400).json({ error: "Nome de agente inválido" });

  const agente = normalizarAgente(agenteRaw);

  try {
    // 1. Tenta retornar do banco (cache local)
    const rDB = await pool.query(
      `SELECT agente, sigla, cnpj, classe, status,
              data_desligamento::TEXT,      inicio_monitoramento::TEXT,
              fim_monitoramento::TEXT,      reuniao_cad,
              suspensao_fornecimento::TEXT, tipos_descumprimentos,
              caucionamento,                tipo_desligamento,
              data_publicacao::TEXT,        updated_at
         FROM ccee_desligamento WHERE agente = $1`,
      [agente]
    );
    if (rDB.rows.length > 0 && !req.query.refresh) {
      return res.json(rDB.rows[0]);
    }

    // 2. Busca CNPJ e sigla do agente para filtrar na CCEE
    const rMeta = await pool.query(
      "SELECT cnpj, sigla FROM ccee_agentes WHERE agente = $1", [agente]
    );
    const { cnpj, sigla } = rMeta.rows[0] || {};

    const dado = await buscarDesligamento(cnpj, sigla || agente);

    if (!dado) {
      // Agente sem desligamento — remove do banco se havia registro antigo
      await pool.query("DELETE FROM ccee_desligamento WHERE agente = $1", [agente]);
      return res.json(null);
    }

    // 3. Salva/atualiza no banco
    await pool.query(`
      INSERT INTO ccee_desligamento
        (agente, sigla, cnpj, classe, status, data_desligamento, inicio_monitoramento,
         fim_monitoramento, reuniao_cad, suspensao_fornecimento, tipos_descumprimentos,
         caucionamento, tipo_desligamento, data_publicacao, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      ON CONFLICT (agente) DO UPDATE SET
        sigla                  = EXCLUDED.sigla,
        cnpj                   = EXCLUDED.cnpj,
        classe                 = EXCLUDED.classe,
        status                 = EXCLUDED.status,
        data_desligamento      = EXCLUDED.data_desligamento,
        inicio_monitoramento   = EXCLUDED.inicio_monitoramento,
        fim_monitoramento      = EXCLUDED.fim_monitoramento,
        reuniao_cad            = EXCLUDED.reuniao_cad,
        suspensao_fornecimento = EXCLUDED.suspensao_fornecimento,
        tipos_descumprimentos  = EXCLUDED.tipos_descumprimentos,
        caucionamento          = EXCLUDED.caucionamento,
        tipo_desligamento      = EXCLUDED.tipo_desligamento,
        data_publicacao        = EXCLUDED.data_publicacao,
        updated_at             = NOW()
    `, [
      agente, dado.sigla, dado.cnpj, dado.classe, dado.status,
      dado.data_desligamento, dado.inicio_monitoramento, dado.fim_monitoramento,
      dado.reuniao_cad, dado.suspensao_fornecimento, dado.tipos_descumprimentos,
      dado.caucionamento, dado.tipo_desligamento, dado.data_publicacao,
    ]);

    return res.json({ agente, ...dado });
  } catch (e) {
    console.error("[desligamento] Erro:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /inteligencia/:agente/contabilizacao?mes=YYYY-MM
app.get("/inteligencia/:agente/contabilizacao", async (req, res) => {
  const agenteRaw = decodeURIComponent(req.params.agente);
  if (!agenteRaw || agenteRaw.trim().length < 2)
    return res.status(400).json({ error: "Nome de agente inválido" });

  const agente = normalizarAgente(agenteRaw);
  const mes    = req.query.mes;

  try {
    // Verifica se já há dados no banco para este agente
    const existe = await pool.query(
      "SELECT MAX(mes_referencia) AS max_mes FROM ccee_contabilizacao WHERE agente = $1",
      [agente]
    );
    const maxMesDB = existe.rows[0]?.max_mes || null;

    // Busca razão social para filtrar por NOME_EMPRESARIAL
    const metaAgente  = await pool.query("SELECT razao_social FROM ccee_agentes WHERE agente = $1", [agente]);
    const razaoSocial = metaAgente.rows[0]?.razao_social || null;

    // Re-busca se banco vazio ou dado desatualizado (mês atual não presente)
    const mesAtualStr = new Date().toISOString().slice(0, 7);
    const precisaAtualizar = !maxMesDB;

    if (precisaAtualizar && razaoSocial) {
      console.log(`[contabilizacao] Buscando dados para ${agente} (${razaoSocial})...`);
      try {
        const registros = await buscarContabilizacao(razaoSocial);
        if (registros.length) await salvarContabilizacao(agente, registros);
      } catch (err) {
        console.warn(`[contabilizacao] Erro ao buscar: ${err.message}`);
      }
    }

    const where = mes ? "WHERE agente = $1 AND mes_referencia = $2" : "WHERE agente = $1";
    const params = mes ? [agente, mes] : [agente];

    const r = await pool.query(`
      SELECT mes_referencia, sigla_perfil_agente, cod_perf_agente,
             valor_tm_mcp, compensacao_mre, valor_encargo, valor_ajuste_exposicao,
             valor_ajuste_alivio_ret, efeito_contrat_disp, efeito_contrat_cota_gf,
             efeito_contrat_nuclear, ajuste_recontab, ajuste_mcsd_ex,
             resultado_financeiro_er, efeito_ccearq, efeito_contrat_itaipu,
             efeito_repasse_risco_hidro, efeito_desloc_pld_cmo, resultado_final
      FROM ccee_contabilizacao
      ${where}
      ORDER BY mes_referencia DESC, sigla_perfil_agente ASC
    `, params);

    return res.json(r.rows);
  } catch (e) {
    console.error("Erro em /contabilizacao:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /inteligencia/:agente/sazonalizacao?ano=YYYY — sugestão de sazonalização baseada no último ano completo
app.get("/inteligencia/:agente/sazonalizacao", async (req, res) => {
  const agente = normalizarAgente(decodeURIComponent(req.params.agente));
  const modo   = req.query.modo || "total";
  try {
    // Encontra o último ano com 12 meses de dados
    const rAnos = await pool.query(`
      SELECT LEFT(mes, 4)::integer AS ano, COUNT(*) AS n_meses
      FROM ccee_dados
      WHERE agente = $1
      GROUP BY LEFT(mes, 4)
      HAVING COUNT(*) = 12
      ORDER BY ano DESC
      LIMIT 1
    `, [agente]);

    if (!rAnos.rows.length)
      return res.status(404).json({ error: "Nenhum ano completo (12 meses) de consumo encontrado" });

    const anoBase  = Number(rAnos.rows[0].ano);
    const anoAtual = new Date().getFullYear();

    if (modo === "sub") {
      const [rBase, rAtual] = await Promise.all([
        pool.query(`
          SELECT mes_referencia, submercado, SUM(consumo_mwh) AS total_mwh,
                 COUNT(DISTINCT periodo) AS n_periodos
          FROM ccee_consumo_horario
          WHERE agente = $1 AND LEFT(mes_referencia,4)::integer = $2
          GROUP BY mes_referencia, submercado ORDER BY mes_referencia, submercado
        `, [agente, anoBase]),
        pool.query(`
          SELECT mes_referencia, submercado, SUM(consumo_mwh) AS total_mwh,
                 COUNT(DISTINCT periodo) AS n_periodos
          FROM ccee_consumo_horario
          WHERE agente = $1 AND LEFT(mes_referencia,4)::integer = $2
          GROUP BY mes_referencia, submercado ORDER BY mes_referencia, submercado
        `, [agente, anoAtual]),
      ]);
      const totalMwhBySub = {};
      rBase.rows.forEach(r => {
        totalMwhBySub[r.submercado] = (totalMwhBySub[r.submercado] || 0) + Number(r.total_mwh);
      });
      const realizadoAtualSub = {};
      rAtual.rows.forEach(r => {
        const k = `${r.submercado}|${r.mes_referencia}`;
        realizadoAtualSub[k] = { total_mwh: Number(r.total_mwh), n_periodos: Number(r.n_periodos) };
      });
      return res.json({
        ano_base: anoBase, ano_atual: anoAtual, modo: "sub",
        meses: rBase.rows.map(r => {
          const sub = r.submercado, mes_r = r.mes_referencia;
          const [ano, mesNum] = mes_r.split("-").map(Number);
          const n_horas = new Date(ano, mesNum, 0).getDate() * 24;
          const twh = Number(r.total_mwh);
          const real = realizadoAtualSub[`${sub}|${mes_r.replace(String(anoBase), String(anoAtual))}`] || null;
          return {
            mes: mes_r, submercado: sub,
            consumo_mwh: Number(twh.toFixed(2)),
            consumo_mwm: Number((twh / n_horas).toFixed(4)),
            participacao_pct: totalMwhBySub[sub] > 0 ? Number((twh / totalMwhBySub[sub] * 100).toFixed(2)) : 0,
            realizado_mwh: real ? Number(Number(real.total_mwh).toFixed(2)) : null,
          };
        }),
      });
    }

    if (modo === "perfil") {
      const [rBase, rAtual] = await Promise.all([
        pool.query(`
          SELECT mes_referencia, sigla_perfil, SUM(consumo_mwh) AS total_mwh
          FROM ccee_consumo_horario_perfil
          WHERE agente = $1 AND LEFT(mes_referencia,4)::integer = $2
          GROUP BY mes_referencia, sigla_perfil ORDER BY mes_referencia, sigla_perfil
        `, [agente, anoBase]),
        pool.query(`
          SELECT mes_referencia, sigla_perfil, SUM(consumo_mwh) AS total_mwh
          FROM ccee_consumo_horario_perfil
          WHERE agente = $1 AND LEFT(mes_referencia,4)::integer = $2
          GROUP BY mes_referencia, sigla_perfil ORDER BY mes_referencia, sigla_perfil
        `, [agente, anoAtual]),
      ]);
      const totalMwhByPerfil = {};
      rBase.rows.forEach(r => {
        totalMwhByPerfil[r.sigla_perfil] = (totalMwhByPerfil[r.sigla_perfil] || 0) + Number(r.total_mwh);
      });
      const realizadoAtualPerfil = {};
      rAtual.rows.forEach(r => {
        const k = `${r.sigla_perfil}|${r.mes_referencia}`;
        realizadoAtualPerfil[k] = Number(r.total_mwh);
      });
      return res.json({
        ano_base: anoBase, ano_atual: anoAtual, modo: "perfil",
        meses: rBase.rows.map(r => {
          const perfil = r.sigla_perfil, mes_r = r.mes_referencia;
          const [ano, mesNum] = mes_r.split("-").map(Number);
          const n_horas = new Date(ano, mesNum, 0).getDate() * 24;
          const twh = Number(r.total_mwh);
          const realKey = `${perfil}|${mes_r.replace(String(anoBase), String(anoAtual))}`;
          return {
            mes: mes_r, sigla_perfil: perfil,
            consumo_mwh: Number(twh.toFixed(2)),
            consumo_mwm: Number((twh / n_horas).toFixed(4)),
            participacao_pct: totalMwhByPerfil[perfil] > 0 ? Number((twh / totalMwhByPerfil[perfil] * 100).toFixed(2)) : 0,
            realizado_mwh: realizadoAtualPerfil[realKey] != null ? Number(Number(realizadoAtualPerfil[realKey]).toFixed(2)) : null,
          };
        }),
      });
    }

    // Busca base (ano completo) e ano atual em paralelo
    const [rBase, rAtual] = await Promise.all([
      pool.query(`SELECT mes, consumo FROM ccee_dados WHERE agente = $1 AND mes LIKE $2 ORDER BY mes ASC`, [agente, `${anoBase}-%`]),
      pool.query(`SELECT mes, consumo FROM ccee_dados WHERE agente = $1 AND mes LIKE $2 ORDER BY mes ASC`, [agente, `${anoAtual}-%`]),
    ]);

    const calcMes = (row) => {
      const [ano, mesNum] = row.mes.split("-").map(Number);
      const horas       = new Date(ano, mesNum, 0).getDate() * 24;
      const consumo_mwm = Number(row.consumo) || 0;
      return { mes: row.mes, horas, consumo_mwm, consumo_mwh: consumo_mwm * horas };
    };

    const meses       = rBase.rows.map(calcMes);
    const total_mwh   = meses.reduce((s, m) => s + m.consumo_mwh, 0);
    const total_horas = meses.reduce((s, m) => s + m.horas, 0);
    const media_mwm   = total_horas > 0 ? total_mwh / total_horas : 0;

    // Realizado do ano atual indexado por número do mês (1-12)
    const realizadoAtual = {};
    rAtual.rows.forEach(row => {
      const mesNum = Number(row.mes.split("-")[1]);
      realizadoAtual[mesNum] = Number(row.consumo) || 0;
    });

    return res.json({
      ano_base:        anoBase,
      ano_atual:       anoAtual,
      total_mwh:       Number(total_mwh.toFixed(4)),
      total_horas,
      media_mwm:       Number(media_mwm.toFixed(4)),
      realizado_atual: realizadoAtual,
      meses: meses.map(m => ({
        mes:              m.mes,
        horas:            m.horas,
        consumo_mwm:      Number(m.consumo_mwm.toFixed(4)),
        consumo_mwh:      Number(m.consumo_mwh.toFixed(4)),
        participacao_pct: total_mwh > 0
          ? Number((m.consumo_mwh / total_mwh * 100).toFixed(4))
          : Number((100 / 12).toFixed(4)),
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /inteligencia/:agente/curva-carga — curva típica de consumo em pu por submercado
app.get("/inteligencia/:agente/curva-carga", async (req, res) => {
  const agente = normalizarAgente(decodeURIComponent(req.params.agente));
  try {
    const r = await pool.query(`
      SELECT
        submercado,
        ((periodo - 1) % 24) + 1  AS hora,
        AVG(consumo_mwh)           AS consumo_medio,
        COUNT(*)                   AS n_amostras
      FROM ccee_consumo_horario
      WHERE agente = $1
      GROUP BY submercado, hora
      ORDER BY submercado, hora
    `, [agente]);

    if (!r.rows.length) return res.json([]);

    // Normaliza em pu por submercado (cada sub tem seu próprio pico)
    const maxPorSub = {};
    for (const row of r.rows) {
      const v = Number(row.consumo_medio);
      if (!maxPorSub[row.submercado] || v > maxPorSub[row.submercado])
        maxPorSub[row.submercado] = v;
    }

    return res.json(r.rows.map(row => ({
      submercado:     row.submercado,
      hora:           Number(row.hora),
      consumo_medio:  Number(Number(row.consumo_medio).toFixed(4)),
      pu:             maxPorSub[row.submercado] > 0
                        ? Number((Number(row.consumo_medio) / maxPorSub[row.submercado]).toFixed(4))
                        : 0,
      n_amostras:     Number(row.n_amostras),
    })));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /inteligencia/:agente/curva-carga-perfil — curva típica de consumo em pu por SIGLA_PERFIL_AGENTE
app.get("/inteligencia/:agente/curva-carga-perfil", async (req, res) => {
  const agente = normalizarAgente(decodeURIComponent(req.params.agente));
  try {
    const r = await pool.query(`
      SELECT
        sigla_perfil,
        ((periodo - 1) % 24) + 1  AS hora,
        AVG(consumo_mwh)           AS consumo_medio,
        COUNT(*)                   AS n_amostras
      FROM ccee_consumo_horario_perfil
      WHERE agente = $1
      GROUP BY sigla_perfil, hora
      ORDER BY sigla_perfil, hora
    `, [agente]);

    if (!r.rows.length) return res.json([]);

    const maxPorPerfil = {};
    for (const row of r.rows) {
      const v = Number(row.consumo_medio);
      if (!maxPorPerfil[row.sigla_perfil] || v > maxPorPerfil[row.sigla_perfil])
        maxPorPerfil[row.sigla_perfil] = v;
    }

    return res.json(r.rows.map(row => ({
      sigla_perfil:  row.sigla_perfil,
      hora:          Number(row.hora),
      consumo_medio: Number(Number(row.consumo_medio).toFixed(4)),
      pu:            maxPorPerfil[row.sigla_perfil] > 0
                       ? Number((Number(row.consumo_medio) / maxPorPerfil[row.sigla_perfil]).toFixed(4))
                       : 0,
      n_amostras:    Number(row.n_amostras),
    })));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /inteligencia/:agente/curva-geracao — curva típica de geração em pu por unidade geradora
app.get("/inteligencia/:agente/curva-geracao", async (req, res) => {
  const agente = normalizarAgente(decodeURIComponent(req.params.agente));
  try {
    const r = await pool.query(`
      SELECT
        sigla_usina,
        ((periodo - 1) % 24) + 1  AS hora,
        AVG(geracao_mwmed)         AS geracao_media,
        COUNT(*)                   AS n_amostras
      FROM ccee_geracao_horaria
      WHERE agente = $1
      GROUP BY sigla_usina, hora
      ORDER BY sigla_usina, hora
    `, [agente]);

    if (!r.rows.length) return res.json([]);

    // Normaliza em pu por usina (cada usina tem seu próprio pico)
    const maxPorUsina = {};
    for (const row of r.rows) {
      const v = Number(row.geracao_media);
      if (!maxPorUsina[row.sigla_usina] || v > maxPorUsina[row.sigla_usina]) {
        maxPorUsina[row.sigla_usina] = v;
      }
    }

    return res.json(r.rows.map(row => ({
      sigla_usina:    row.sigla_usina,
      hora:           Number(row.hora),
      geracao_media:  Number(Number(row.geracao_media).toFixed(4)),
      pu:             maxPorUsina[row.sigla_usina] > 0
                        ? Number((Number(row.geracao_media) / maxPorUsina[row.sigla_usina]).toFixed(4))
                        : 0,
      n_amostras:     Number(row.n_amostras),
    })));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /inteligencia/:agente/geracao-horaria/csv?mes=YYYY-MM — exporta geração horária por usina como CSV
app.get("/inteligencia/:agente/geracao-horaria/csv", async (req, res) => {
  const agenteRaw = decodeURIComponent(req.params.agente);
  if (!agenteRaw || agenteRaw.trim().length < 2)
    return res.status(400).json({ error: "Nome de agente inválido" });

  const agente = normalizarAgente(agenteRaw);
  const mes    = req.query.mes;

  if (!mes || !/^\d{4}-\d{2}$/.test(mes))
    return res.status(400).json({ error: "Parâmetro ?mes=YYYY-MM é obrigatório" });

  try {
    const r = await pool.query(`
      SELECT sigla_usina, periodo, submercado, geracao_mwmed
      FROM ccee_geracao_horaria
      WHERE agente = $1 AND mes_referencia = $2
      ORDER BY sigla_usina, periodo ASC
    `, [agente, mes]);

    if (!r.rows.length)
      return res.status(404).json({ error: "Sem dados de geração horária para este agente/mês" });

    const [ano, mesNum] = mes.split("-");
    const linhas = [
      "data,hora,sigla_usina,submercado,geracao_mwmed",
      ...r.rows.map(row => {
        const p    = Number(row.periodo);
        const dia  = Math.ceil(p / 24).toString().padStart(2, "0");
        const hora = (((p - 1) % 24) + 1).toString().padStart(2, "0");
        return `${dia}/${mesNum}/${ano},${hora},${row.sigla_usina},${row.submercado},${Number(row.geracao_mwmed).toFixed(6)}`;
      }),
    ].join("\n");

    const filename = `geracao_horaria_${agente.replace(/\s+/g, "_")}_${mes}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(linhas);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /inteligencia/:agente/consumo-horario/csv?mes=YYYY-MM — exporta consumo horário como CSV
app.get("/inteligencia/:agente/consumo-horario/csv", async (req, res) => {
  const agenteRaw = decodeURIComponent(req.params.agente);
  if (!agenteRaw || agenteRaw.trim().length < 2)
    return res.status(400).json({ error: "Nome de agente inválido" });

  const agente = normalizarAgente(agenteRaw);
  const mes    = req.query.mes;

  if (!mes || !/^\d{4}-\d{2}$/.test(mes))
    return res.status(400).json({ error: "Parâmetro ?mes=YYYY-MM é obrigatório" });

  try {
    const r = await pool.query(`
      SELECT periodo, submercado, consumo_mwh
      FROM ccee_consumo_horario
      WHERE agente = $1 AND mes_referencia = $2
      ORDER BY submercado, periodo ASC
    `, [agente, mes]);

    if (!r.rows.length)
      return res.status(404).json({ error: "Sem dados de consumo horário para este agente/mês" });

    const [ano, mesNum] = mes.split("-");
    const linhas = [
      "data,hora,submercado,consumo_mwh",
      ...r.rows.map(row => {
        const p    = Number(row.periodo);
        const dia  = Math.ceil(p / 24).toString().padStart(2, "0");
        const hora = (((p - 1) % 24) + 1).toString().padStart(2, "0");
        return `${dia}/${mesNum}/${ano},${hora},${row.submercado},${Number(row.consumo_mwh).toFixed(6)}`;
      }),
    ].join("\n");

    const filename = `consumo_horario_${agente.replace(/\s+/g, "_")}_${mes}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(linhas);
  } catch (e) {
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

// ─── Persistência: consumo horário ────────────────────────────────────────────

async function salvarConsumoHorario(agente, registros) {
  if (!registros.length) return;

  const BATCH = 500;
  for (let i = 0; i < registros.length; i += BATCH) {
    const lote = registros.slice(i, i + BATCH);
    await pool.query(`
      INSERT INTO ccee_consumo_horario
        (agente, mes_referencia, periodo, submercado, consumo_mwh)
      SELECT * FROM UNNEST(
        $1::text[], $2::char(7)[], $3::integer[], $4::text[], $5::numeric[]
      )
      ON CONFLICT (agente, mes_referencia, periodo, submercado) DO NOTHING
    `, [
      lote.map(() => agente),
      lote.map(r => r.mes_referencia),
      lote.map(r => r.periodo),
      lote.map(r => r.submercado),
      lote.map(r => r.consumo_mwh),
    ]);
  }
  console.log(`Consumo horário: ${registros.length} períodos salvos para ${agente}`);
}

async function salvarConsumoHorarioPerfil(agente, registros) {
  if (!registros.length) return;
  const BATCH = 500;
  for (let i = 0; i < registros.length; i += BATCH) {
    const lote = registros.slice(i, i + BATCH);
    await pool.query(`
      INSERT INTO ccee_consumo_horario_perfil
        (agente, mes_referencia, sigla_perfil, periodo, submercado, consumo_mwh)
      SELECT * FROM UNNEST(
        $1::text[], $2::char(7)[], $3::text[], $4::integer[], $5::text[], $6::numeric[]
      )
      ON CONFLICT (agente, mes_referencia, sigla_perfil, periodo, submercado) DO NOTHING
    `, [
      lote.map(() => agente),
      lote.map(r => r.mes_referencia),
      lote.map(r => r.sigla_perfil),
      lote.map(r => r.periodo),
      lote.map(r => r.submercado),
      lote.map(r => r.consumo_mwh),
    ]);
  }
  console.log(`Consumo por perfil: ${registros.length} períodos salvos para ${agente}`);
}

// ─── Cálculo de modulação ─────────────────────────────────────────────────────

/**
 * Calcula o custo de modulação por submercado.
 *
 * soma_curva = Σ (consumo_j × pld_j)  — só horas com consumo
 * soma_flat  = (consumo_total / n_horas_pld) × Σ pld_j  — usa TODOS os períodos do PLD
 *
 * O PLD tem 744 períodos (ex: mês de 31 dias); o consumo tem 743 porque a última
 * hora do mês não consta no arquivo CCEE (aparece no mês seguinte). O flat deve
 * usar os 744 períodos do PLD para ser metodologicamente correto.
 */
function calcularModulacaoPorSub(consumo, pldMapa, submercadoFiltro) {
  const registros = consumo.filter(r => r.submercado === submercadoFiltro);
  if (!registros.length) return null;

  // soma_curva: só os períodos que têm consumo E PLD
  let totalConsumo = 0;
  let somaCurva    = 0;
  const periodosSemPld = [];

  for (const r of registros) {
    const consumoMwh = Number(r.consumo_mwh) || 0;
    const pld        = pldMapa[`${r.periodo}|${submercadoFiltro}`];
    if (pld == null) { periodosSemPld.push(r.periodo); continue; }
    totalConsumo += consumoMwh;
    somaCurva    += consumoMwh * pld;
  }

  // soma_flat: usa TODOS os períodos do PLD para o submercado (inclui última hora do mês)
  let somaPldTotal = 0;
  let nHorasPld    = 0;
  for (const [key, pld] of Object.entries(pldMapa)) {
    if (key.endsWith(`|${submercadoFiltro}`)) {
      somaPldTotal += pld;
      nHorasPld++;
    }
  }

  console.log(`[calc-mod] sub=${submercadoFiltro}: ${registros.length} consumo | ${nHorasPld} PLD | ${periodosSemPld.length} sem match`);

  if (!nHorasPld || !totalConsumo) {
    console.warn(`[calc-mod] sub=${submercadoFiltro}: nHorasPld=${nHorasPld} totalConsumo=${totalConsumo} → null`);
    return null;
  }

  if (periodosSemPld.length) {
    console.warn(`[calc-mod] ${periodosSemPld.length} períodos de consumo sem PLD (amostra: ${periodosSemPld.slice(0, 5).join(",")})`);
  }

  const flat           = totalConsumo / nHorasPld;
  const somaFlat       = flat * somaPldTotal;
  const custoModulacao = (somaCurva - somaFlat) / totalConsumo;

  return {
    submercado:              submercadoFiltro,
    consumo_total_mwh:       Number(totalConsumo.toFixed(4)),
    n_horas:                 nHorasPld,
    soma_curva_rs:           Number(somaCurva.toFixed(4)),
    soma_flat_rs:            Number(somaFlat.toFixed(4)),
    custo_modulacao_rs_mwh:  Number(custoModulacao.toFixed(4)),
  };
}

async function salvarModulacao(agente, mes, resultados) {
  if (!resultados.length) return;
  await pool.query(`
    INSERT INTO ccee_modulacao
      (agente, mes_referencia, submercado, consumo_total_mwh, n_horas,
       soma_curva_rs, soma_flat_rs, custo_modulacao_rs_mwh)
    SELECT * FROM UNNEST(
      $1::text[], $2::char(7)[], $3::text[], $4::numeric[], $5::integer[],
      $6::numeric[], $7::numeric[], $8::numeric[]
    )
    ON CONFLICT (agente, mes_referencia, submercado) DO UPDATE SET
      consumo_total_mwh    = EXCLUDED.consumo_total_mwh,
      n_horas              = EXCLUDED.n_horas,
      soma_curva_rs        = EXCLUDED.soma_curva_rs,
      soma_flat_rs         = EXCLUDED.soma_flat_rs,
      custo_modulacao_rs_mwh = EXCLUDED.custo_modulacao_rs_mwh,
      created_at           = NOW()
  `, [
    resultados.map(() => agente),
    resultados.map(() => mes),
    resultados.map(r => r.submercado),
    resultados.map(r => r.consumo_total_mwh),
    resultados.map(r => r.n_horas),
    resultados.map(r => r.soma_curva_rs),
    resultados.map(r => r.soma_flat_rs),
    resultados.map(r => r.custo_modulacao_rs_mwh),
  ]);
  console.log(`Modulação: ${resultados.length} submercados salvos para ${agente} ${mes}`);
}

async function salvarModulacaoPerfil(agente, mes, resultados) {
  if (!resultados.length) return;
  await pool.query(`
    INSERT INTO ccee_modulacao_perfil
      (agente, mes_referencia, sigla_perfil, submercado, consumo_total_mwh, n_horas,
       soma_curva_rs, soma_flat_rs, custo_modulacao_rs_mwh)
    SELECT * FROM UNNEST(
      $1::text[], $2::char(7)[], $3::text[], $4::text[], $5::numeric[], $6::integer[],
      $7::numeric[], $8::numeric[], $9::numeric[]
    )
    ON CONFLICT (agente, mes_referencia, sigla_perfil, submercado) DO UPDATE SET
      consumo_total_mwh      = EXCLUDED.consumo_total_mwh,
      n_horas                = EXCLUDED.n_horas,
      soma_curva_rs          = EXCLUDED.soma_curva_rs,
      soma_flat_rs           = EXCLUDED.soma_flat_rs,
      custo_modulacao_rs_mwh = EXCLUDED.custo_modulacao_rs_mwh,
      created_at             = NOW()
  `, [
    resultados.map(() => agente),
    resultados.map(() => mes),
    resultados.map(r => r.sigla_perfil),
    resultados.map(r => r.submercado),
    resultados.map(r => r.consumo_total_mwh),
    resultados.map(r => r.n_horas),
    resultados.map(r => r.soma_curva_rs),
    resultados.map(r => r.soma_flat_rs),
    resultados.map(r => r.custo_modulacao_rs_mwh),
  ]);
  console.log(`Modulação por perfil: ${resultados.length} perfis×submercados salvos para ${agente} ${mes}`);
}

// GET /inteligencia/:agente/modulacao
// Query params: ?mes=YYYY-MM (obrigatório) &submercado=SE (opcional)
app.get("/inteligencia/:agente/modulacao", async (req, res) => {
  const agenteRaw = decodeURIComponent(req.params.agente);
  if (!agenteRaw || agenteRaw.trim().length < 2)
    return res.status(400).json({ error: "Nome de agente inválido" });

  const agente = normalizarAgente(agenteRaw);
  const mes    = req.query.mes;
  const sub    = req.query.submercado?.toUpperCase() || null;

  if (!mes || !/^\d{4}-\d{2}$/.test(mes))
    return res.status(400).json({ error: "Parâmetro ?mes=YYYY-MM é obrigatório" });

  try {
    // Garante consumo horário no banco
    const existeConsumo = await pool.query(
      "SELECT 1 FROM ccee_consumo_horario WHERE agente = $1 AND mes_referencia = $2 LIMIT 1",
      [agente, mes]
    );
    if (existeConsumo.rows.length === 0) {
      console.log(`[modulação] Baixando consumo horário para ${agente} | mês=${mes}...`);
      const { resultado: registros, resultadoPerfil } = await buscarConsumoHorario(agente, mes);
      if (registros.length > 0) await salvarConsumoHorario(agente, registros);
      if (resultadoPerfil.length > 0) await salvarConsumoHorarioPerfil(agente, resultadoPerfil);
    }

    // Busca consumo do banco
    const conditions = ["agente = $1", "mes_referencia = $2"];
    const params     = [agente, mes];
    if (sub) { conditions.push("submercado = $3"); params.push(sub); }

    const rConsumo = await pool.query(`
      SELECT periodo, submercado, consumo_mwh
      FROM ccee_consumo_horario
      WHERE ${conditions.join(" AND ")}
      ORDER BY periodo ASC
    `, params);

    if (!rConsumo.rows.length)
      return res.json({ agente, mes, submercado: sub, mensagem: "Nenhum dado de consumo encontrado", resultados: [] });

    // Submercados presentes nos dados de consumo
    const submercados = sub
      ? [sub]
      : [...new Set(rConsumo.rows.map(r => r.submercado))];

    // Busca PLD horário (um mapa único cobre todos os submercados)
    console.log(`[modulação] Buscando PLD horário para mês=${mes}...`);
    const pldMapa = await buscarPldHorarioMapa(mes);

    // Calcula modulação por submercado
    const resultados = submercados
      .map(s => calcularModulacaoPorSub(rConsumo.rows, pldMapa, s))
      .filter(Boolean);

    // Persiste resultados
    if (resultados.length) await salvarModulacao(agente, mes, resultados);

    return res.json({ agente, mes, resultados });
  } catch (e) {
    console.error("[modulação] Erro:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /inteligencia/:agente/modulacao-perfil?mes=YYYY-MM
app.get("/inteligencia/:agente/modulacao-perfil", async (req, res) => {
  const agente = normalizarAgente(decodeURIComponent(req.params.agente));
  const mes    = req.query.mes;
  if (!mes || !/^\d{4}-\d{2}$/.test(mes))
    return res.status(400).json({ error: "Parâmetro ?mes=YYYY-MM é obrigatório" });
  try {
    const r = await pool.query(`
      SELECT sigla_perfil, submercado, consumo_total_mwh, n_horas,
             soma_curva_rs, soma_flat_rs, custo_modulacao_rs_mwh
      FROM ccee_modulacao_perfil
      WHERE agente = $1 AND mes_referencia = $2
      ORDER BY sigla_perfil, submercado
    `, [agente, mes]);
    return res.json({ agente, mes, resultados: r.rows.map(row => ({
      sigla_perfil:          row.sigla_perfil,
      submercado:            row.submercado,
      consumo_total_mwh:     Number(row.consumo_total_mwh),
      n_horas:               Number(row.n_horas),
      soma_curva_rs:         Number(row.soma_curva_rs),
      soma_flat_rs:          Number(row.soma_flat_rs),
      custo_modulacao_rs_mwh: Number(row.custo_modulacao_rs_mwh),
    }))});
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─── Modulação automática ─────────────────────────────────────────────────────

const PRIMEIRO_MES_PLD = "2025-01"; // PLD horário disponível a partir deste mês
const modulacaoEmAndamento = new Set(); // evita batch duplo por agente

// Classes que não têm consumo próprio → skip consumo horário
const CLASSES_SEM_CONSUMO = new Set(["Gerador", "Comercializador"]);
// Classes sem nenhum processamento
const CLASSES_SKIP_TOTAL  = new Set(["Comercializador"]);

// ─── Fila global de processamento (max 1 download simultâneo) ─────────────────
const filaProcessamento = (() => {
  const fila   = []; // [{ fn, label }]
  let rodando  = false;

  async function processar() {
    if (rodando || !fila.length) return;
    rodando = true;
    const { fn, label } = fila.shift();
    console.log(`[fila] ▶ ${label} | restam ${fila.length}`);
    try { await fn(); }
    catch (e) { console.warn(`[fila] Erro em ${label}:`, e.message); }
    finally {
      rodando = false;
      setImmediate(processar);
    }
  }

  return {
    get tamanho() { return fila.length; },
    get ativa()   { return rodando; },
    enqueue(fn, label) {
      if (fila.some(j => j.label === label)) return; // sem duplicata
      fila.push({ fn, label });
      processar();
    },
  };
})();

// Retry para erros transientes de conexão (queda de pool durante download longo)
async function comRetry(fn, tentativas = 3, label = "") {
  for (let i = 1; i <= tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      const transiente = err.message?.includes("Connection terminated")
                      || err.message?.includes("connection timeout")
                      || err.message?.includes("ECONNRESET")
                      || err.code === "57P01"; // admin_shutdown
      if (transiente && i < tentativas) {
        const espera = i * 4000;
        console.warn(`[retry${label ? " " + label : ""}] tentativa ${i}/${tentativas} falhou: ${err.message} — aguardando ${espera}ms`);
        await new Promise(r => setTimeout(r, espera));
      } else {
        throw err;
      }
    }
  }
}

async function processarMesModulacao(agente, mes) {
  console.log(`\n[modulacao] ── Iniciando ${agente} | ${mes} ──────────────────────`);

  // Detecta períodos salvos com indexação errada (base 0 em vez de base 1)
  // max_periodo correto: dias_no_mês × 24  (ex: 744 para janeiro, 672 para fevereiro)
  const [ano, mesNum] = mes.split("-").map(Number);
  const diasNoMes     = new Date(ano, mesNum, 0).getDate();
  const maxEsperado   = diasNoMes * 24;

  const formatoCheck = await pool.query(
    "SELECT MAX(periodo) AS max_periodo FROM ccee_consumo_horario WHERE agente = $1 AND mes_referencia = $2",
    [agente, mes]
  );
  const maxPeriodoCheck = Number(formatoCheck.rows[0]?.max_periodo || 0);
  const periodoErrado   = maxPeriodoCheck > 0 && maxPeriodoCheck < maxEsperado;

  const [jaCalculado, nConsumoCheck] = await Promise.all([
    pool.query("SELECT 1 FROM ccee_modulacao WHERE agente = $1 AND mes_referencia = $2 LIMIT 1", [agente, mes]),
    pool.query("SELECT COUNT(*) AS n FROM ccee_consumo_horario WHERE agente = $1 AND mes_referencia = $2", [agente, mes]),
  ]);
  const semConsumo = Number(nConsumoCheck.rows[0].n) === 0;

  if (jaCalculado.rows.length > 0 && !periodoErrado && !semConsumo) {
    console.log(`[modulacao] ${mes}: já calculado (max_periodo=${maxPeriodoCheck}/${maxEsperado}), pulando`);
    return "already_done";
  }
  if (periodoErrado) {
    console.warn(`[modulacao] ⚠ Períodos descasados (max=${maxPeriodoCheck}, esperado=${maxEsperado}) — deletando e recalculando`);
    await Promise.all([
      pool.query("DELETE FROM ccee_modulacao              WHERE agente = $1 AND mes_referencia = $2", [agente, mes]),
      pool.query("DELETE FROM ccee_consumo_horario        WHERE agente = $1 AND mes_referencia = $2", [agente, mes]),
      pool.query("DELETE FROM ccee_consumo_horario_perfil WHERE agente = $1 AND mes_referencia = $2", [agente, mes]),
      pool.query("DELETE FROM ccee_modulacao_perfil       WHERE agente = $1 AND mes_referencia = $2", [agente, mes]),
    ]);
  } else if (jaCalculado.rows.length > 0 && semConsumo) {
    console.warn(`[modulacao] ⚠ Modulação existe mas consumo ausente — recalculando ${mes}`);
    await pool.query("DELETE FROM ccee_modulacao WHERE agente = $1 AND mes_referencia = $2", [agente, mes]);
  }

  const existeConsumo = await pool.query(
    "SELECT COUNT(*) AS n, MAX(periodo) AS max_periodo FROM ccee_consumo_horario WHERE agente = $1 AND mes_referencia = $2",
    [agente, mes]
  );
  const nConsumoDB    = Number(existeConsumo.rows[0].n);
  const maxPeriodoDB  = Number(existeConsumo.rows[0].max_periodo || 0);
  console.log(`[modulacao] Consumo horário no banco: ${nConsumoDB} períodos | max_periodo=${maxPeriodoDB}`);

  // Se max_periodo < esperado, os dados estão com indexação errada — deleta e re-baixa
  if (nConsumoDB > 0 && maxPeriodoDB < maxEsperado) {
    console.warn(`[modulacao] ⚠ Consumo com períodos errados (max=${maxPeriodoDB}, esperado=${maxEsperado}) — deletando`);
    await Promise.all([
      pool.query("DELETE FROM ccee_consumo_horario        WHERE agente = $1 AND mes_referencia = $2", [agente, mes]),
      pool.query("DELETE FROM ccee_consumo_horario_perfil WHERE agente = $1 AND mes_referencia = $2", [agente, mes]),
    ]);
  }

  if (nConsumoDB === 0 || maxPeriodoDB < maxEsperado) {
    console.log(`[modulacao] Baixando consumo horário da CCEE...`);
    const metaAgente  = await pool.query("SELECT razao_social FROM ccee_agentes WHERE agente = $1", [agente]);
    const razaoSocial = metaAgente.rows[0]?.razao_social || null;
    try {
      const { resultado: registros, resultadoPerfil } = await buscarConsumoHorario(agente, mes, razaoSocial);
      console.log(`[modulacao] CCEE retornou ${registros.length} períodos | ${resultadoPerfil.length} por perfil`);
      if (registros.length > 0) {
        await salvarConsumoHorario(agente, registros);
        if (resultadoPerfil.length > 0) await salvarConsumoHorarioPerfil(agente, resultadoPerfil);
      } else {
        console.warn(`[modulacao] ⚠ Nenhum período de consumo encontrado para "${agente}" em ${mes}`);
      }
    } catch (err) {
      console.error(`[modulacao] ✖ Erro ao baixar consumo: ${err.message}`);
      throw err;
    }
  }

  const rConsumo = await pool.query(`
    SELECT periodo, submercado, consumo_mwh
    FROM ccee_consumo_horario
    WHERE agente = $1 AND mes_referencia = $2
    ORDER BY periodo ASC
  `, [agente, mes]);

  if (!rConsumo.rows.length) {
    console.warn(`[modulacao] ⚠ Sem dados de consumo no banco após tentativa de download`);
    return "no_consumption";
  }

  const subsConsumo = [...new Set(rConsumo.rows.map(r => r.submercado))];
  const periodoMin  = rConsumo.rows[0]?.periodo;
  const periodoMax  = rConsumo.rows[rConsumo.rows.length - 1]?.periodo;
  console.log(`[modulacao] Consumo: ${rConsumo.rows.length} períodos | subs=${subsConsumo.join(",")} | período ${periodoMin}–${periodoMax}`);

  console.log(`[modulacao] Buscando PLD horário CKAN para ${mes}...`);
  let pldMapa;
  try {
    pldMapa = await buscarPldHorarioMapa(mes);
    const chavesPld    = Object.keys(pldMapa);
    const subsPld      = [...new Set(chavesPld.map(k => k.split("|")[1]))];
    const periodosPld  = chavesPld.length;
    console.log(`[modulacao] PLD mapa: ${periodosPld} entradas | subs=${subsPld.join(",")}`);

    // Verifica se os submercados do consumo estão no mapa PLD
    const subsSemPld = subsConsumo.filter(s => !subsPld.includes(s));
    if (subsSemPld.length) {
      console.warn(`[modulacao] ⚠ Submercados do consumo SEM PLD correspondente: ${subsSemPld.join(",")}`);
      console.warn(`[modulacao]   Subs no consumo: ${subsConsumo.join(",")} | Subs no PLD: ${subsPld.join(",")}`);
    }
  } catch (err) {
    console.error(`[modulacao] ✖ Erro ao buscar PLD: ${err.message}`);
    throw err;
  }

  const submercados = subsConsumo;
  const resultados  = submercados
    .map(s => calcularModulacaoPorSub(rConsumo.rows, pldMapa, s))
    .filter(Boolean);

  console.log(`[modulacao] Resultados calculados: ${resultados.length}/${submercados.length} submercados`);
  resultados.forEach(r => console.log(`[modulacao]   ${r.submercado}: consumo=${r.consumo_total_mwh} MWh | ${r.n_horas} horas | custo=${r.custo_modulacao_rs_mwh} R$/MWh`));

  if (resultados.length) await salvarModulacao(agente, mes, resultados);
  else console.warn(`[modulacao] ⚠ Nenhum resultado calculado — verifique se os submercados e períodos coincidem`);

  // Calcula modulação por (sigla_perfil, submercado)
  const rConsumoPerfil = await pool.query(`
    SELECT sigla_perfil, periodo, submercado, consumo_mwh
    FROM ccee_consumo_horario_perfil
    WHERE agente = $1 AND mes_referencia = $2
    ORDER BY periodo ASC
  `, [agente, mes]);

  if (rConsumoPerfil.rows.length > 0) {
    const perfis = [...new Set(rConsumoPerfil.rows.map(r => r.sigla_perfil))];
    const subsPerfil = [...new Set(rConsumoPerfil.rows.map(r => r.submercado))];
    const resultadosPerfil = [];
    for (const perfil of perfis) {
      for (const sub of subsPerfil) {
        const registros = rConsumoPerfil.rows.filter(r => r.sigla_perfil === perfil && r.submercado === sub);
        if (!registros.length) continue;
        const res = calcularModulacaoPorSub(
          registros.map(r => ({ ...r, submercado: sub })),
          pldMapa, sub
        );
        if (res) resultadosPerfil.push({ ...res, sigla_perfil: perfil });
      }
    }
    if (resultadosPerfil.length) await salvarModulacaoPerfil(agente, mes, resultadosPerfil);
  }

  return resultados.length ? "done" : "no_results";
}

async function dispararModulacaoBackground(agente, classe) {
  // Comercializadores e geradores não têm consumo próprio para processar
  if (!classe) {
    const r = await pool.query("SELECT classe FROM ccee_agentes WHERE agente = $1", [agente]);
    classe = r.rows[0]?.classe;
  }
  if (CLASSES_SEM_CONSUMO.has(classe)) return;
  if (modulacaoEmAndamento.has(agente)) return;

  const [calculados, todos, maxPorMesRows] = await Promise.all([
    pool.query("SELECT mes_referencia FROM ccee_modulacao WHERE agente = $1", [agente]),
    pool.query("SELECT mes FROM ccee_dados WHERE agente = $1 ORDER BY mes DESC", [agente]),
    pool.query("SELECT mes_referencia, MAX(periodo) AS max_periodo FROM ccee_consumo_horario WHERE agente = $1 GROUP BY mes_referencia", [agente]),
  ]);

  const calculadosSet = new Set(calculados.rows.map(r => r.mes_referencia));
  const maxPorMes     = {};
  maxPorMesRows.rows.forEach(r => { maxPorMes[r.mes_referencia] = Number(r.max_periodo); });

  const mesesPendentes = todos.rows
    .map(r => r.mes)
    .filter(m => {
      if (m < PRIMEIRO_MES_PLD) return false;
      if (!calculadosSet.has(m)) return true;
      const [ano, mesNum] = m.split("-").map(Number);
      const maxEsperado   = new Date(ano, mesNum, 0).getDate() * 24;
      const maxAtual      = maxPorMes[m] || 0;
      return maxAtual > 0 && maxAtual < maxEsperado;
    });

  if (!mesesPendentes.length) return;

  console.log(`[modulacao-auto] ${agente}: ${mesesPendentes.length} meses enfileirados`);

  filaProcessamento.enqueue(async () => {
    modulacaoEmAndamento.add(agente);
    try {
      for (const mes of mesesPendentes) {
        try {
          const status = await comRetry(
            () => processarMesModulacao(agente, mes),
            3, `${agente} ${mes}`
          );
          console.log(`[modulacao-auto] ${agente} ${mes}: ${status}`);
        } catch (err) {
          console.warn(`[modulacao-auto] Erro em ${agente} ${mes}: ${err.message}`);
        }
      }
    } finally {
      modulacaoEmAndamento.delete(agente);
      console.log(`[modulacao-auto] ${agente}: batch concluído`);
    }
  }, `consumo|${agente}`);
}

// ─── Modulação de Geração ─────────────────────────────────────────────────────

async function salvarGeracaoHoraria(agente, registros) {
  if (!registros.length) return;
  const BATCH = 500;
  for (let i = 0; i < registros.length; i += BATCH) {
    const lote = registros.slice(i, i + BATCH);
    await pool.query(`
      INSERT INTO ccee_geracao_horaria (agente, mes_referencia, sigla_usina, periodo, submercado, geracao_mwmed)
      SELECT * FROM UNNEST($1::text[], $2::char(7)[], $3::text[], $4::integer[], $5::text[], $6::numeric[])
      ON CONFLICT (agente, mes_referencia, periodo, submercado, sigla_usina) DO NOTHING
    `, [
      lote.map(() => agente),
      lote.map(r => r.mes_referencia),
      lote.map(r => r.sigla_usina),
      lote.map(r => r.periodo),
      lote.map(r => r.submercado),
      lote.map(r => r.geracao_mwmed),
    ]);
  }
  console.log(`Geração horária: ${registros.length} registros salvos para ${agente}`);
}

// Calcula modulação para uma combinação (usina, submercado) específica
function calcularModulacaoGeracaoUsinaSub(geracao, pldMapa, siglaUsina, submercadoFiltro) {
  const registros = geracao.filter(r => r.sigla_usina === siglaUsina && r.submercado === submercadoFiltro);
  if (!registros.length) return null;

  let totalGeracao = 0;
  let somaCurva    = 0;
  const semPld     = [];

  for (const r of registros) {
    const geracaoMwmed = Number(r.geracao_mwmed) || 0;
    const pld          = pldMapa[`${r.periodo}|${submercadoFiltro}`];
    if (pld == null) { semPld.push(r.periodo); continue; }
    totalGeracao += geracaoMwmed;
    somaCurva    += geracaoMwmed * pld;
  }

  let somaPldTotal = 0, nHorasPld = 0;
  for (const [key, pld] of Object.entries(pldMapa)) {
    if (key.endsWith(`|${submercadoFiltro}`)) { somaPldTotal += pld; nHorasPld++; }
  }

  console.log(`[calc-mod-ger] usina=${siglaUsina} sub=${submercadoFiltro}: ${registros.length} períodos | ${nHorasPld} PLD | ${semPld.length} sem match`);
  if (!nHorasPld || !totalGeracao) return null;

  const flat           = totalGeracao / nHorasPld;
  const somaFlat       = flat * somaPldTotal;
  const custoModulacao = (somaCurva - somaFlat) / totalGeracao;

  return {
    sigla_usina:             siglaUsina,
    submercado:              submercadoFiltro,
    geracao_total_mwh:       Number(totalGeracao.toFixed(4)),
    n_horas:                 nHorasPld,
    soma_curva_rs:           Number(somaCurva.toFixed(4)),
    soma_flat_rs:            Number(somaFlat.toFixed(4)),
    custo_modulacao_rs_mwh:  Number(custoModulacao.toFixed(4)),
  };
}

async function salvarModulacaoGeracao(agente, mes, resultados) {
  if (!resultados.length) return;
  await pool.query(`
    INSERT INTO ccee_modulacao_geracao
      (agente, mes_referencia, sigla_usina, submercado, geracao_total_mwh, n_horas, soma_curva_rs, soma_flat_rs, custo_modulacao_rs_mwh)
    SELECT * FROM UNNEST($1::text[], $2::char(7)[], $3::text[], $4::text[], $5::numeric[], $6::integer[], $7::numeric[], $8::numeric[], $9::numeric[])
    ON CONFLICT (agente, mes_referencia, sigla_usina, submercado) DO UPDATE SET
      geracao_total_mwh      = EXCLUDED.geracao_total_mwh,
      n_horas                = EXCLUDED.n_horas,
      soma_curva_rs          = EXCLUDED.soma_curva_rs,
      soma_flat_rs           = EXCLUDED.soma_flat_rs,
      custo_modulacao_rs_mwh = EXCLUDED.custo_modulacao_rs_mwh,
      created_at             = NOW()
  `, [
    resultados.map(() => agente),
    resultados.map(() => mes),
    resultados.map(r => r.sigla_usina),
    resultados.map(r => r.submercado),
    resultados.map(r => r.geracao_total_mwh),
    resultados.map(r => r.n_horas),
    resultados.map(r => r.soma_curva_rs),
    resultados.map(r => r.soma_flat_rs),
    resultados.map(r => r.custo_modulacao_rs_mwh),
  ]);
  console.log(`Modulação geração: ${resultados.length} usina/submercado salvos para ${agente} ${mes}`);
}

async function processarMesModulacaoGeracao(agente, mes, siglasUsinas) {
  const [ano, mesNum] = mes.split("-").map(Number);
  const maxEsperado   = new Date(ano, mesNum, 0).getDate() * 24;

  const check = await pool.query(
    "SELECT MAX(periodo) AS max_periodo FROM ccee_geracao_horaria WHERE agente = $1 AND mes_referencia = $2",
    [agente, mes]
  );
  const maxAtual     = Number(check.rows[0]?.max_periodo || 0);
  // Detecta indexação errada: < esperado (dados incompletos) ou > esperado (bug antigo que
  // aplicava conversão hora-do-dia em período absoluto, gerando períodos até ~1465 para 31 dias)
  const periodoErrado = maxAtual > 0 && maxAtual !== maxEsperado;

  const jaCalculado = await pool.query(
    "SELECT 1 FROM ccee_modulacao_geracao WHERE agente = $1 AND mes_referencia = $2 LIMIT 1",
    [agente, mes]
  );
  if (jaCalculado.rows.length > 0 && !periodoErrado) return "already_done";
  if (periodoErrado) {
    await pool.query("DELETE FROM ccee_modulacao_geracao WHERE agente = $1 AND mes_referencia = $2", [agente, mes]);
    await pool.query("DELETE FROM ccee_geracao_horaria  WHERE agente = $1 AND mes_referencia = $2", [agente, mes]);
  }

  const nDB = await pool.query(
    "SELECT COUNT(*) AS n FROM ccee_geracao_horaria WHERE agente = $1 AND mes_referencia = $2",
    [agente, mes]
  );
  const nGeracaoDB = Number(nDB.rows[0].n);

  if (nGeracaoDB === 0 || periodoErrado) {
    console.log(`[mod-ger] Baixando geração horária ${agente} ${mes}...`);
    try {
      const registros = await buscarGeracaoHoraria(mes, siglasUsinas);
      if (registros.length > 0) await salvarGeracaoHoraria(agente, registros);
      else { console.warn(`[mod-ger] ⚠ Sem geração para ${agente} em ${mes}`); return "no_generation"; }
    } catch (err) {
      console.error(`[mod-ger] ✖ Erro ao baixar geração: ${err.message}`);
      throw err;
    }
  }

  const rGeracao = await pool.query(`
    SELECT sigla_usina, periodo, submercado, geracao_mwmed
    FROM ccee_geracao_horaria
    WHERE agente = $1 AND mes_referencia = $2
    ORDER BY sigla_usina, periodo
  `, [agente, mes]);
  if (!rGeracao.rows.length) return "no_generation";

  const pldMapa = await buscarPldHorarioMapa(mes);

  // Calcula modulação para cada combinação (usina, submercado)
  const combos = [...new Set(rGeracao.rows.map(r => `${r.sigla_usina}|${r.submercado}`))];
  const resultados = combos
    .map(c => {
      const [siglaUsina, submercado] = c.split("|");
      return calcularModulacaoGeracaoUsinaSub(rGeracao.rows, pldMapa, siglaUsina, submercado);
    })
    .filter(Boolean);

  if (resultados.length) await salvarModulacaoGeracao(agente, mes, resultados);
  return resultados.length ? "done" : "no_results";
}

const modulacaoGeracaoEmAndamento = new Set();

async function dispararModulacaoGeracaoBackground(agente, classe) {
  // Comercializadores não têm geração própria
  if (!classe) {
    const r = await pool.query("SELECT classe FROM ccee_agentes WHERE agente = $1", [agente]);
    classe = r.rows[0]?.classe;
  }
  if (CLASSES_SKIP_TOTAL.has(classe)) return;
  if (modulacaoGeracaoEmAndamento.has(agente)) return;

  const rUsinas = await pool.query(
    "SELECT DISTINCT sigla_parcela_usina FROM ccee_usinas WHERE agente = $1 AND sigla_parcela_usina IS NOT NULL",
    [agente]
  );
  if (!rUsinas.rows.length) return;

  const siglasUsinas = rUsinas.rows.map(r => r.sigla_parcela_usina);

  const [calculados, todos, maxPorMesRows] = await Promise.all([
    pool.query("SELECT mes_referencia FROM ccee_modulacao_geracao WHERE agente = $1", [agente]),
    pool.query("SELECT mes FROM ccee_dados WHERE agente = $1 ORDER BY mes DESC", [agente]),
    pool.query("SELECT mes_referencia, MAX(periodo) AS max_periodo FROM ccee_geracao_horaria WHERE agente = $1 GROUP BY mes_referencia", [agente]),
  ]);

  const calculadosSet = new Set(calculados.rows.map(r => r.mes_referencia));
  const maxPorMes     = {};
  maxPorMesRows.rows.forEach(r => { maxPorMes[r.mes_referencia] = Number(r.max_periodo); });

  const mesesPendentes = todos.rows
    .map(r => r.mes)
    .filter(m => {
      if (m < PRIMEIRO_MES_PLD) return false;
      if (!calculadosSet.has(m)) return true;
      const [ano, mesNum] = m.split("-").map(Number);
      const maxEsperado   = new Date(ano, mesNum, 0).getDate() * 24;
      const maxAtual      = maxPorMes[m] || 0;
      return maxAtual > 0 && maxAtual !== maxEsperado;
    });

  if (!mesesPendentes.length) return;

  console.log(`[mod-ger-auto] ${agente}: ${mesesPendentes.length} meses enfileirados | ${siglasUsinas.length} usinas`);

  filaProcessamento.enqueue(async () => {
    modulacaoGeracaoEmAndamento.add(agente);
    try {
      for (const mes of mesesPendentes) {
        try {
          const status = await comRetry(
            () => processarMesModulacaoGeracao(agente, mes, siglasUsinas),
            3, `${agente} ${mes}`
          );
          console.log(`[mod-ger-auto] ${agente} ${mes}: ${status}`);
        } catch (err) {
          console.warn(`[mod-ger-auto] Erro em ${agente} ${mes}: ${err.message}`);
        }
      }
    } finally {
      modulacaoGeracaoEmAndamento.delete(agente);
      console.log(`[mod-ger-auto] ${agente}: batch concluído`);
    }
  }, `geracao|${agente}`);
}

// GET /inteligencia/:agente/modulacao-geracao
app.get("/inteligencia/:agente/modulacao-geracao", async (req, res) => {
  const agenteRaw = decodeURIComponent(req.params.agente);
  if (!agenteRaw || agenteRaw.trim().length < 2)
    return res.status(400).json({ error: "Nome de agente inválido" });

  const agente = normalizarAgente(agenteRaw);
  try {
    const [resultados, totalMeses] = await Promise.all([
      pool.query(`
        SELECT mes_referencia, sigla_usina, submercado, geracao_total_mwh, n_horas,
               custo_modulacao_rs_mwh, soma_curva_rs, soma_flat_rs
        FROM ccee_modulacao_geracao
        WHERE agente = $1
        ORDER BY mes_referencia DESC, sigla_usina ASC, submercado ASC
      `, [agente]),
      pool.query(`SELECT COUNT(*) AS total FROM ccee_dados WHERE agente = $1 AND mes >= $2`, [agente, PRIMEIRO_MES_PLD]),
    ]);

    return res.json({
      calculando: modulacaoGeracaoEmAndamento.has(agente),
      total_meses: Number(totalMeses.rows[0].total),
      calculados:  resultados.rows.length,
      resultados:  resultados.rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─── Jobs ─────────────────────────────────────────────────────────────────────

async function criarJob(tipo, agente, mes, params = {}) {
  const r = await pool.query(`
    INSERT INTO ccee_jobs (tipo, agente, mes, params)
    VALUES ($1, $2, $3, $4)
    RETURNING id
  `, [tipo, agente, mes, JSON.stringify(params)]);
  return r.rows[0].id;
}

async function atualizarJob(id, status, resultado = null, erro = null) {
  await pool.query(`
    UPDATE ccee_jobs
    SET status = $2, resultado = $3, erro = $4, updated_at = NOW()
    WHERE id = $1
  `, [id, status, resultado ? JSON.stringify(resultado) : null, erro]);
}

function rodarEmBackground(jobId, fn) {
  setImmediate(async () => {
    try {
      await atualizarJob(jobId, "running");
      const resultado = await fn();
      await atualizarJob(jobId, "done", resultado);
    } catch (err) {
      console.error(`[job ${jobId}] Erro:`, err.message);
      await atualizarJob(jobId, "error", null, err.message);
    }
  });
}

// GET /jobs/:id
app.get("/jobs/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(id))
    return res.status(400).json({ error: "ID de job inválido" });

  try {
    const r = await pool.query(
      "SELECT id, tipo, agente, mes, status, resultado, erro, created_at, updated_at FROM ccee_jobs WHERE id = $1",
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Job não encontrado" });
    return res.json(r.rows[0]);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /inteligencia/:agente/modulacao/solicitar?mes=YYYY-MM[&submercado=SE]
// Retorna job existente (done/running) se já houver para agente+mes,
// ou cria novo job e inicia processamento em background.
app.get("/inteligencia/:agente/modulacao/solicitar", async (req, res) => {
  const agenteRaw = decodeURIComponent(req.params.agente);
  if (!agenteRaw || agenteRaw.trim().length < 2)
    return res.status(400).json({ error: "Nome de agente inválido" });

  const agente = normalizarAgente(agenteRaw);
  const mes    = req.query.mes;
  const sub    = req.query.submercado?.toUpperCase() || null;

  if (!mes || !/^\d{4}-\d{2}$/.test(mes))
    return res.status(400).json({ error: "Parâmetro ?mes=YYYY-MM é obrigatório" });

  // Deduplicação: retorna job existente se ainda válido (running ou done recente)
  try {
    const existente = await pool.query(`
      SELECT id, status, resultado, erro, updated_at
      FROM ccee_jobs
      WHERE tipo = 'modulacao' AND agente = $1 AND mes = $2
        AND status IN ('pending', 'running', 'done')
      ORDER BY created_at DESC
      LIMIT 1
    `, [agente, mes]);

    if (existente.rows.length > 0) {
      const job = existente.rows[0];
      return res.json({ jobId: job.id, status: job.status, pollUrl: `/jobs/${job.id}`, resultado: job.resultado ?? undefined });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  try {
    const jobId = await criarJob("modulacao", agente, mes, { submercado: sub });
    console.log(`[modulacao/solicitar] Novo job ${jobId} para ${agente} ${mes}`);

    rodarEmBackground(jobId, async () => {
      // Garante consumo horário no banco
      const existeConsumo = await pool.query(
        "SELECT 1 FROM ccee_consumo_horario WHERE agente = $1 AND mes_referencia = $2 LIMIT 1",
        [agente, mes]
      );
      if (existeConsumo.rows.length === 0) {
        console.log(`[job ${jobId}] Baixando consumo horário ${agente} ${mes}...`);
        const { resultado: registros, resultadoPerfil } = await buscarConsumoHorario(agente, mes);
        if (registros.length > 0) await salvarConsumoHorario(agente, registros);
        if (resultadoPerfil.length > 0) await salvarConsumoHorarioPerfil(agente, resultadoPerfil);
      }

      // Busca consumo do banco
      const conditions = ["agente = $1", "mes_referencia = $2"];
      const params     = [agente, mes];
      if (sub) { conditions.push("submercado = $3"); params.push(sub); }

      const rConsumo = await pool.query(`
        SELECT periodo, submercado, consumo_mwh
        FROM ccee_consumo_horario
        WHERE ${conditions.join(" AND ")}
        ORDER BY periodo ASC
      `, params);

      if (!rConsumo.rows.length)
        return { agente, mes, submercado: sub, mensagem: "Nenhum dado de consumo encontrado", resultados: [] };

      const submercados = sub
        ? [sub]
        : [...new Set(rConsumo.rows.map(r => r.submercado))];

      console.log(`[job ${jobId}] Buscando PLD horário ${mes}...`);
      const pldMapa = await buscarPldHorarioMapa(mes);

      const resultados = submercados
        .map(s => calcularModulacaoPorSub(rConsumo.rows, pldMapa, s))
        .filter(Boolean);

      if (resultados.length) await salvarModulacao(agente, mes, resultados);

      return { agente, mes, resultados };
    });

    return res.status(202).json({ jobId, status: "pending", pollUrl: `/jobs/${jobId}` });
  } catch (e) {
    console.error("[modulacao/solicitar] Erro ao criar job:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Pinga o banco a cada 4 minutos para evitar pausa por inatividade (Aiven free tier dorme rapidamente)
if (process.env.NODE_ENV !== "test") {
  setInterval(() => {
    pool.query("SELECT 1").catch(err =>
      console.error("Keep-alive falhou:", err.message)
    );
  }, 4 * 60 * 1000);
}

// GET /admin/modulacao/pendentes — lista agentes com modulação faltante
app.get("/admin/modulacao/pendentes", async (_req, res) => {
  try {
    const pendentes = await queryPendentes();
    return res.json({
      timestamp:        new Date().toISOString(),
      primeiro_mes_pld: PRIMEIRO_MES_PLD,
      total_agentes:    pendentes.length,
      total_meses:      pendentes.reduce((s, p) => s + p.total_pendentes, 0),
      pendentes,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /admin/modulacao/processar-pendentes — dispara processamento manual
app.post("/admin/modulacao/processar-pendentes", async (_req, res) => {
  console.log("[admin] Processamento manual de pendentes solicitado.");
  try {
    const result = await processarTodosPendentes();
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /admin/modulacao/:agente — dispara manualmente o job de modulação (carga + geração)
app.post("/admin/modulacao/:agente", async (req, res) => {
  const agente = normalizarAgente(decodeURIComponent(req.params.agente));
  const { carga = true, geracao = true } = req.query;

  try {
    const jobs = [];
    if (String(carga) !== "false") {
      jobs.push(
        dispararModulacaoBackground(agente)
          .then(() => "carga: disparado")
          .catch(e => `carga: erro — ${e.message}`)
      );
    }
    if (String(geracao) !== "false") {
      jobs.push(
        dispararModulacaoGeracaoBackground(agente)
          .then(() => "geracao: disparado")
          .catch(e => `geracao: erro — ${e.message}`)
      );
    }
    const resultados = await Promise.all(jobs);
    return res.json({ agente, status: resultados });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// DELETE /admin/consumo-horario/:agente?mes=YYYY-MM — força re-download do consumo
// Sem ?mes: deleta todo o consumo do agente. Com ?mes: deleta só aquele mês.
app.delete("/admin/consumo-horario/:agente", async (req, res) => {
  const agente = normalizarAgente(decodeURIComponent(req.params.agente));
  const mes    = req.query.mes;

  if (mes && !/^\d{4}-\d{2}$/.test(mes))
    return res.status(400).json({ error: "Formato de mês inválido (YYYY-MM)" });

  try {
    const params = mes ? [agente, mes] : [agente];
    const where  = mes ? "agente = $1 AND mes_referencia = $2" : "agente = $1";

    const [rC, rM, rCP, rMP] = await Promise.all([
      pool.query(`DELETE FROM ccee_consumo_horario        WHERE ${where} RETURNING 1`, params),
      pool.query(`DELETE FROM ccee_modulacao              WHERE ${where} RETURNING 1`, params),
      pool.query(`DELETE FROM ccee_consumo_horario_perfil WHERE ${where} RETURNING 1`, params),
      pool.query(`DELETE FROM ccee_modulacao_perfil       WHERE ${where} RETURNING 1`, params),
    ]);

    console.log(`[admin] Consumo/modulação deletados para ${agente}${mes ? ` ${mes}` : " (todos os meses)"}`);
    return res.json({
      agente, mes: mes || "todos",
      consumo_deletado: rC.rowCount, modulacao_deletada: rM.rowCount,
      consumo_perfil_deletado: rCP.rowCount, modulacao_perfil_deletada: rMP.rowCount,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});


// GET /localidade — agentes com cargas numa cidade ou estado
// Query: ?cidade=SAO+PAULO,UBERLANDIA  |  ?estado=SP,MG  |  ?q=termo (busca livre em cidade+estado+ramo)
app.get("/localidade", async (req, res) => {
  const { cidade, estado, q } = req.query;
  if (!cidade && !estado && !q)
    return res.status(400).json({ error: "Informe cidade, estado ou q" });

  // Suporta múltiplos valores separados por vírgula
  const estados = estado ? estado.split(",").map(s => s.trim().toUpperCase()).filter(Boolean) : [];
  const cidades = cidade ? cidade.split(",").map(s => s.trim().toUpperCase()).filter(Boolean) : [];

  try {
    const conds  = [];
    const params = [];

    if (estados.length) {
      params.push(estados);
      conds.push(`c.estado_uf = ANY($${params.length}::varchar[])`);
    }
    if (cidades.length) {
      params.push(cidades);
      conds.push(`UPPER(c.cidade) = ANY($${params.length}::varchar[])`);
    }
    if (q && !cidades.length && !estados.length) {
      const termo = `%${q.trim().toUpperCase()}%`;
      params.push(termo);
      conds.push(`(UPPER(c.cidade) LIKE $${params.length} OR UPPER(c.estado_uf) LIKE $${params.length} OR UPPER(c.ramo_atividade) LIKE $${params.length})`);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    // Filtro reutilizável para o JOIN de localidades (sem prefixo WHERE)
    const joinCond = conds.length ? `AND ${conds.join(" AND ")}` : "";

    const { rows } = await pool.query(`
      WITH agentes_match AS (
        SELECT DISTINCT c.agente
        FROM ccee_cargas c
        ${where}
      ),
      totais AS (
        SELECT
          c.agente,
          COUNT(DISTINCT c.sigla_parcela_carga)::int                         AS n_parcelas,
          SUM(c.consumo_total) / NULLIF(COUNT(DISTINCT c.mes_referencia), 0) AS consumo_medio_mwh
        FROM ccee_cargas c
        JOIN agentes_match am ON am.agente = c.agente
        GROUP BY c.agente
      )
      SELECT
        am.agente,
        a.razao_social,
        a.sigla,
        a.classe,
        c.estado_uf,
        c.cidade,
        c.ramo_atividade,
        c.submercado,
        MAX(c.mes_referencia) AS ultimo_mes,
        t.n_parcelas,
        t.consumo_medio_mwh,
        mod.media_custo_mod
      FROM agentes_match am
      JOIN ccee_agentes a ON a.agente = am.agente
      JOIN ccee_cargas  c ON c.agente = am.agente ${joinCond}
      JOIN totais       t ON t.agente = am.agente
      LEFT JOIN (
        SELECT agente, AVG(custo_modulacao_rs_mwh) AS media_custo_mod
        FROM ccee_modulacao GROUP BY agente
      ) mod ON mod.agente = am.agente
      GROUP BY am.agente, a.razao_social, a.sigla, a.classe,
               c.estado_uf, c.cidade, c.ramo_atividade, c.submercado,
               t.n_parcelas, t.consumo_medio_mwh, mod.media_custo_mod
      ORDER BY t.consumo_medio_mwh DESC, am.agente, c.estado_uf, c.cidade
      LIMIT 5000
    `, params);

    // Agrupa por agente — consumo e parcelas vêm do CTE (nível agente), não somam por linha
    const porAgente = {};
    for (const r of rows) {
      if (!porAgente[r.agente]) {
        porAgente[r.agente] = {
          agente:            r.agente,
          razao_social:      r.razao_social,
          sigla:             r.sigla,
          classe:            r.classe,
          localidades:       [],
          n_parcelas:        r.n_parcelas,
          consumo_medio_mwh: Number(r.consumo_medio_mwh) || 0,
          media_custo_mod:   r.media_custo_mod != null ? Number(r.media_custo_mod) : null,
        };
      }
      porAgente[r.agente].localidades.push({
        estado_uf:  r.estado_uf,
        cidade:     r.cidade,
        ramo:       r.ramo_atividade,
        submercado: r.submercado,
        ultimo_mes: r.ultimo_mes,
      });
    }

    res.json(Object.values(porAgente).sort((a, b) => b.consumo_medio_mwh - a.consumo_medio_mwh));
  } catch (e) {
    console.error("[localidade]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /localidade/opcoes — listas de estados e cidades disponíveis
app.get("/localidade/opcoes", async (_req, res) => {
  try {
    const [rEstados, rCidades] = await Promise.all([
      pool.query("SELECT DISTINCT estado_uf FROM ccee_cargas WHERE estado_uf IS NOT NULL ORDER BY estado_uf"),
      pool.query("SELECT DISTINCT cidade, estado_uf FROM ccee_cargas WHERE cidade IS NOT NULL ORDER BY cidade LIMIT 2000"),
    ]);
    res.json({
      estados: rEstados.rows.map(r => r.estado_uf),
      cidades: rCidades.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Utilitários geoespaciais ─────────────────────────────────────────────────

function toRad(d) { return d * Math.PI / 180; }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distToSegmentKm(plat, plon, alat, alon, blat, blon) {
  const dx = blat - alat, dy = blon - alon;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return haversineKm(plat, plon, alat, alon);
  const t = Math.max(0, Math.min(1, ((plat - alat) * dx + (plon - alon) * dy) / (dx * dx + dy * dy)));
  return haversineKm(plat, plon, alat + t * dx, alon + t * dy);
}

function distToPolylineKm(lat, lon, pontos) {
  // pontos: [[lon, lat], ...] (ordem GeoJSON)
  let min = Infinity;
  for (let i = 0; i < pontos.length - 1; i++) {
    const d = distToSegmentKm(lat, lon, pontos[i][1], pontos[i][0], pontos[i + 1][1], pontos[i + 1][0]);
    if (d < min) min = d;
  }
  return min;
}

// GET /geocode?q=Belo+Horizonte+MG — proxy para Nominatim
app.get("/geocode", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  try {
    const url  = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + " Brasil")}&format=json&limit=5&countrycodes=br`;
    const resp = await fetch(url, { headers: { "User-Agent": "CCEEMonitor/1.0 (github.com/matheusgnreis/CCEE)" } });
    const data = await resp.json();
    res.json(data.map(d => ({ lat: parseFloat(d.lat), lon: parseFloat(d.lon), nome: d.display_name })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /localidade/rota — agentes ao longo de uma rota rodoviária
app.post("/localidade/rota", async (req, res) => {
  const {
    origemLat, origemLon, destinoLat, destinoLon,
    raioKm = 30, minConsumoMwh = 0, ramo,
  } = req.body;

  if (!origemLat || !origemLon || !destinoLat || !destinoLon)
    return res.status(400).json({ error: "Informe origemLat, origemLon, destinoLat, destinoLon" });

  try {
    // 1. Rota via OSRM (público, gratuito)
    const osrmUrl  = `https://router.project-osrm.org/route/v1/driving/${origemLon},${origemLat};${destinoLon},${destinoLat}?overview=full&geometries=geojson`;
    const osrmResp = await fetch(osrmUrl, { headers: { "User-Agent": "CCEEMonitor/1.0" } });
    const osrmData = await osrmResp.json();

    if (!osrmData.routes?.length)
      return res.status(400).json({ error: "Rota não encontrada pelo OSRM" });

    const rotaOSRM   = osrmData.routes[0];
    const pontos     = rotaOSRM.geometry.coordinates; // [[lon, lat], ...]
    const distanciaKm = Math.round(rotaOSRM.distance / 1000);
    const duracaoMin  = Math.round(rotaOSRM.duration / 60);

    // 2. Cidades geocodificadas no banco
    const { rows: cidades } = await pool.query(
      "SELECT cidade, estado_uf, lat, lon FROM ccee_cidades_geo WHERE lat IS NOT NULL"
    );

    if (!cidades.length)
      return res.status(400).json({ error: "Nenhuma cidade geocodificada. Execute: node scripts/geocodificar-cidades.js" });

    // 3. Filtra cidades dentro do raio da rota
    const cidadesNaRota = cidades
      .map(c => ({ ...c, distKm: distToPolylineKm(c.lat, c.lon, pontos) }))
      .filter(c => c.distKm <= raioKm)
      .sort((a, b) => a.distKm - b.distKm);

    if (!cidadesNaRota.length)
      return res.json({ agentes: [], distanciaKm, duracaoMin, raioKm });

    // 4. Agentes nessas cidades
    const cidadePairs = cidadesNaRota.map(c => `(${`'${c.cidade.replace(/'/g, "''")}'`}, '${c.estado_uf}')`).join(", ");
    const distMap     = Object.fromEntries(cidadesNaRota.map(c => [`${c.cidade}|${c.estado_uf}`, c.distKm]));

    const ramoFiltro = ramo ? `AND UPPER(c.ramo_atividade) LIKE '%${ramo.trim().toUpperCase().replace(/'/g, "''")}%'` : "";

    const { rows } = await pool.query(`
      WITH totais AS (
        SELECT
          c.agente,
          COUNT(DISTINCT c.sigla_parcela_carga)::int                         AS n_parcelas,
          SUM(c.consumo_total) / NULLIF(COUNT(DISTINCT c.mes_referencia), 0) AS consumo_medio_mwh
        FROM ccee_cargas c
        WHERE (c.cidade, c.estado_uf) IN (${cidadePairs})
          ${ramoFiltro}
        GROUP BY c.agente
        HAVING SUM(c.consumo_total) / NULLIF(COUNT(DISTINCT c.mes_referencia), 0) >= $1
      )
      SELECT
        t.agente,
        a.razao_social, a.sigla, a.classe,
        c.estado_uf, c.cidade, c.ramo_atividade, c.submercado,
        MAX(c.mes_referencia) AS ultimo_mes,
        t.n_parcelas,
        t.consumo_medio_mwh,
        mod.media_custo_mod
      FROM totais t
      JOIN ccee_agentes a ON a.agente = t.agente
      JOIN ccee_cargas  c ON c.agente = t.agente
        AND (c.cidade, c.estado_uf) IN (${cidadePairs})
        ${ramoFiltro}
      LEFT JOIN (
        SELECT agente, AVG(custo_modulacao_rs_mwh) AS media_custo_mod
        FROM ccee_modulacao GROUP BY agente
      ) mod ON mod.agente = t.agente
      GROUP BY t.agente, a.razao_social, a.sigla, a.classe,
               c.estado_uf, c.cidade, c.ramo_atividade, c.submercado,
               t.n_parcelas, t.consumo_medio_mwh, mod.media_custo_mod
      ORDER BY t.consumo_medio_mwh DESC, t.agente, c.cidade
    `, [minConsumoMwh]);

    // Agrupa por agente
    const porAgente = {};
    for (const r of rows) {
      const chave = `${r.cidade}|${r.estado_uf}`;
      if (!porAgente[r.agente]) {
        porAgente[r.agente] = {
          agente:            r.agente,
          razao_social:      r.razao_social,
          sigla:             r.sigla,
          classe:            r.classe,
          n_parcelas:        r.n_parcelas,
          consumo_medio_mwh: Number(r.consumo_medio_mwh) || 0,
          media_custo_mod:   r.media_custo_mod != null ? Number(r.media_custo_mod) : null,
          localidades:       [],
          dist_km:           distMap[chave] ?? null,
        };
      }
      porAgente[r.agente].localidades.push({
        estado_uf:  r.estado_uf,
        cidade:     r.cidade,
        ramo:       r.ramo_atividade,
        submercado: r.submercado,
        ultimo_mes: r.ultimo_mes,
        dist_km:    distMap[chave] ?? null,
      });
      // Mantém a menor distância do agente à rota
      const d = distMap[chave] ?? Infinity;
      if (d < (porAgente[r.agente].dist_km ?? Infinity)) porAgente[r.agente].dist_km = d;
    }

    const agentes = Object.values(porAgente).sort((a, b) => b.consumo_medio_mwh - a.consumo_medio_mwh);

    // Conta agentes por cidade para dimensionar os marcadores no mapa
    const agentesPerCidade = {};
    for (const ag of agentes) {
      for (const loc of ag.localidades) {
        const key = `${loc.cidade}|${loc.estado_uf}`;
        agentesPerCidade[key] = (agentesPerCidade[key] || 0) + 1;
      }
    }

    const cidadesMapa = cidadesNaRota.map(c => ({
      cidade:    c.cidade,
      estado_uf: c.estado_uf,
      lat:       c.lat,
      lon:       c.lon,
      distKm:    Math.round(c.distKm * 10) / 10,
      nAgentes:  agentesPerCidade[`${c.cidade}|${c.estado_uf}`] || 0,
    }));

    res.json({
      agentes,
      distanciaKm,
      duracaoMin,
      raioKm,
      cidadesNaRota: cidadesNaRota.length,
      rotaGeojson:   rotaOSRM.geometry,   // { type: "LineString", coordinates: [[lon,lat],...] }
      cidadesMapa,
    });
  } catch (e) {
    console.error("[localidade/rota]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /modulacao/status — visão geral de todos os agentes: carga e geração
app.get("/modulacao/status", async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        a.agente,
        a.razao_social,
        COUNT(DISTINCT d.mes) FILTER (WHERE d.mes >= $1)   AS total_meses,
        COUNT(DISTINCT m.mes_referencia)                    AS calculados_carga,
        MAX(m.mes_referencia)                               AS ultimo_mes_carga,
        ROUND(AVG(m.custo_modulacao_rs_mwh)::numeric, 4)   AS custo_medio_carga,
        COUNT(DISTINCT mg.mes_referencia)                   AS calculados_geracao,
        MAX(mg.mes_referencia)                              AS ultimo_mes_geracao,
        ROUND(AVG(mg.custo_modulacao_rs_mwh)::numeric, 4)  AS custo_medio_geracao
      FROM ccee_agentes a
      LEFT JOIN ccee_dados              d  ON d.agente  = a.agente
      LEFT JOIN ccee_modulacao          m  ON m.agente  = a.agente
      LEFT JOIN ccee_modulacao_geracao  mg ON mg.agente = a.agente
      GROUP BY a.agente, a.razao_social
      HAVING COUNT(DISTINCT d.mes) > 0
      ORDER BY a.agente
    `, [PRIMEIRO_MES_PLD]);

    const emAndamentoCarga   = [...modulacaoEmAndamento];
    const emAndamentoGeracao = [...modulacaoGeracaoEmAndamento];

    return res.json({
      em_andamento: [...new Set([...emAndamentoCarga, ...emAndamentoGeracao])],
      agentes: r.rows.map(row => ({
        agente:       row.agente,
        razao_social: row.razao_social,
        total_meses:  Number(row.total_meses),
        carga: {
          calculando:  emAndamentoCarga.includes(row.agente),
          calculados:  Number(row.calculados_carga),
          ultimo_mes:  row.ultimo_mes_carga || null,
          custo_medio: row.custo_medio_carga != null ? Number(row.custo_medio_carga) : null,
        },
        geracao: {
          calculando:  emAndamentoGeracao.includes(row.agente),
          calculados:  Number(row.calculados_geracao),
          ultimo_mes:  row.ultimo_mes_geracao || null,
          custo_medio: row.custo_medio_geracao != null ? Number(row.custo_medio_geracao) : null,
        },
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /pld/horario/csv?mes=YYYY-MM[&submercado=SE,S] — exporta PLD horário CKAN como CSV
// submercado aceita um ou mais valores separados por vírgula (ex: SE ou SE,S)
app.get("/pld/horario/csv", async (req, res) => {
  const mes = req.query.mes;
  if (!mes || !/^\d{4}-\d{2}$/.test(mes))
    return res.status(400).json({ error: "Parâmetro ?mes=YYYY-MM é obrigatório" });

  const submercadosFiltro = req.query.submercado
    ? new Set(req.query.submercado.toUpperCase().split(",").map(s => s.trim()).filter(Boolean))
    : null;

  try {
    const todos = await buscarPldHorario(mes);
    if (!todos.length)
      return res.status(404).json({ error: `Sem dados de PLD horário para ${mes}` });

    const registros = submercadosFiltro
      ? todos.filter(r => submercadosFiltro.has(r.submercado))
      : todos;

    const [ano, mesNum] = mes.split("-");
    const linhas = [
      "data,hora,submercado,pld_rs_mwh",
      ...registros.map(r => {
        const p    = Number(r.periodo);
        const dia  = Math.ceil(p / 24).toString().padStart(2, "0");
        const hora = (((p - 1) % 24) + 1).toString().padStart(2, "0");
        return `${dia}/${mesNum}/${ano},${hora},${r.submercado},${Number(r.pld_rs_mwh).toFixed(4)}`;
      }),
    ].join("\n");

    const sufixo = submercadosFiltro ? `_${[...submercadosFiltro].join("-")}` : "";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="pld_horario_${mes}${sufixo}.csv"`);
    return res.send(linhas);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /pld/resumo — PLD horário via Power BI: dia atual + médias mês atual e anterior
app.get("/pld/resumo", async (_req, res) => {
  try {
    const hoje    = new Date();
    const diaHoje = hoje.getDate();

    // Data atual em BRT (UTC-3) — os timestamps do PBI usam "naive BRT" = UTC sem offset
    const brtHoje = new Date(hoje.getTime() - 3 * 60 * 60 * 1000);
    const hojeStr = `${brtHoje.getUTCFullYear()}-${String(brtHoje.getUTCMonth()+1).padStart(2,"0")}-${String(brtHoje.getUTCDate()).padStart(2,"0")}`;
    const mesAtual  = hojeStr.slice(0, 7);
    const prevDate  = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    const mesAnterior = `${prevDate.getFullYear()}-${String(prevDate.getMonth()+1).padStart(2,"0")}`;
    const diasPrevMes = new Date(hoje.getFullYear(), hoje.getMonth(), 0).getDate();

    console.log(`[pld/resumo] hoje=${hojeStr} | mesAtual=${mesAtual} | mesAnt=${mesAnterior} | diaHoje=${diaHoje}`);

    const registros = await buscarPldBi(diaHoje, diasPrevMes);

    // Sub strings do Power BI: "se/co - sudeste", "s - sul", "ne - nordeste", "n - norte"
    const seCO   = registros.filter(r => r.sub.includes("se/co"));
    const rSul   = registros.filter(r => r.sub.includes("s - sul"));
    const rNE    = registros.filter(r => r.sub.includes("ne - nordeste"));
    const rNorte = registros.filter(r => r.sub.includes("n - norte"));
    console.log(`[pld/resumo] total=${registros.length} | seco=${seCO.length} | sul=${rSul.length} | ne=${rNE.length} | norte=${rNorte.length}`);

    const dadosHoje   = seCO.filter(r => r.data === hojeStr);
    const dadosMesAtu = seCO.filter(r => r.data.startsWith(mesAtual));
    const dadosMesAnt = seCO.filter(r => r.data.startsWith(mesAnterior));

    const media = arr => arr.length ? arr.reduce((s, r) => s + r.pld, 0) / arr.length : null;

    const mediaHoje     = media(dadosHoje);
    const mediaMesAtual = media(dadosMesAtu);
    const mediaMesAnt   = media(dadosMesAnt);
    const variacao      = mediaMesAtual != null && mediaMesAnt != null ? mediaMesAtual - mediaMesAnt : null;

    const chartHoje = dadosHoje
      .sort((a, b) => a.ts - b.ts)
      .map(r => ({ hora: r.hora, pld: Number(r.pld.toFixed(2)) }));

    // Outros submercados — média do dia e do mês vigente, diferença vs SE/CO hoje
    const outrosSubs = {
      sul:      rSul,
      nordeste: rNE,
      norte:    rNorte,
    };

    const outros_submercados = {};
    for (const [key, arr] of Object.entries(outrosSubs)) {
      const mediaHojeArr = arr.filter(r => r.data === hojeStr);
      const mediaMesArr  = arr.filter(r => r.data.startsWith(mesAtual));
      const mHoje = media(mediaHojeArr);
      const mMes  = media(mediaMesArr);
      console.log(`[pld/resumo] ${key}: hoje=${mediaHojeArr.length}pts=${mHoje?.toFixed(2)} | mes=${mediaMesArr.length}pts=${mMes?.toFixed(2)}`);
      outros_submercados[key] = {
        media_hoje: mHoje,
        media_mes:  mMes,
        diff_seco_hoje: mHoje != null && mediaHoje != null ? mHoje - mediaHoje : null,
        diff_seco_mes:  mMes  != null && mediaMesAtual != null ? mMes - mediaMesAtual : null,
      };
    }

    return res.json({
      submercado: "SE/CO",
      hoje:         { data: hojeStr,     media: mediaHoje,     chart: chartHoje },
      mes_atual:    { mes: mesAtual,     media: mediaMesAtual  },
      mes_anterior: { mes: mesAnterior,  media: mediaMesAnt    },
      variacao,
      outros_submercados,
    });
  } catch (e) {
    console.error("Erro em /pld/resumo:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ─── Mercado: PLD histórico mensal ───────────────────────────────────────────

let _pldMensalCache = { data: null, ts: 0 };
const PLD_MENSAL_TTL = 2 * 60 * 60 * 1000;

// Delega para buscarPldHorario (já faz ID discovery) e calcula médias mensais.
async function buscarPldMensal() {
  const agora = Date.now();
  if (_pldMensalCache.data && agora - _pldMensalCache.ts < PLD_MENSAL_TTL) return _pldMensalCache.data;

  const hoje = new Date();
  const meses = [];
  for (let i = 11; i >= 0; i--) {
    const d  = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    meses.push(`${d.getFullYear()}-${mm}`);
  }

  const acum = {}; // { "YYYY-MM": { SE: { soma, n }, ... } }

  const BATCH = 3;
  for (let i = 0; i < meses.length; i += BATCH) {
    await Promise.all(meses.slice(i, i + BATCH).map(async (mes) => {
      try {
        const registros = await buscarPldHorario(mes);
        for (const r of registros) {
          const sub = r.submercado;
          const v   = r.pld_rs_mwh;
          if (!sub || !v) continue;
          if (!acum[mes])      acum[mes]      = {};
          if (!acum[mes][sub]) acum[mes][sub] = { soma: 0, n: 0 };
          acum[mes][sub].soma += v;
          acum[mes][sub].n    += 1;
        }
        console.log(`[pld-mensal] ${mes}: ${registros.length} registros`);
      } catch (err) {
        console.warn(`[pld-mensal] Falha ${mes}: ${err.message}`);
      }
    }));
  }

  const data = Object.entries(acum)
    .map(([mes, subs]) => ({
      mes,
      ...Object.fromEntries(
        Object.entries(subs).map(([sub, { soma, n }]) => [sub, Math.round(soma / n * 100) / 100])
      ),
    }))
    .sort((a, b) => a.mes.localeCompare(b.mes));

  if (data.length > 0) _pldMensalCache = { data, ts: agora };
  return data;
}

// GET /mercado/pld — médias mensais de PLD por submercado (últimos 2 anos)
app.get("/mercado/pld", async (_req, res) => {
  try {
    const dados = await buscarPldMensal();
    return res.json(dados);
  } catch (e) {
    console.error("[mercado/pld] Erro:", e.message);
    return res.status(500).json({ error: e.message });
  }
});


// GET /mercado/modulacao-ramo — custo de modulação médio por ramo de atividade
app.get("/mercado/modulacao-ramo", async (_req, res) => {
  try {
    const r = await pool.query(`
      WITH agent_ramo AS (
        SELECT DISTINCT ON (agente) agente, ramo_atividade
        FROM ccee_cargas
        WHERE ramo_atividade IS NOT NULL
        ORDER BY agente, mes_referencia DESC
      )
      SELECT
        ar.ramo_atividade                                 AS ramo,
        m.mes_referencia                                  AS mes,
        ROUND(AVG(m.custo_modulacao_rs_mwh)::numeric, 4) AS custo_medio_rs_mwh,
        ROUND(SUM(m.consumo_total_mwh)::numeric, 2)      AS consumo_mwh,
        COUNT(DISTINCT m.agente)                          AS n_agentes
      FROM ccee_modulacao m
      JOIN agent_ramo ar ON m.agente = ar.agente
      WHERE m.custo_modulacao_rs_mwh IS NOT NULL
      GROUP BY ar.ramo_atividade, m.mes_referencia
      ORDER BY m.mes_referencia, ar.ramo_atividade
    `);
    return res.json(r.rows);
  } catch (e) {
    console.error("[mercado/modulacao-ramo] Erro:", e.message);
    return res.status(500).json({ error: e.message });
  }
});


// ─── Pendentes: agentes com modulação faltante ────────────────────────────────

async function queryPendentes() {
  const r = await pool.query(`
    SELECT
      sub.agente,
      sub.classe,
      json_agg(sub.mes ORDER BY sub.mes) FILTER (WHERE sub.tipo = 'carga')   AS meses_carga,
      json_agg(sub.mes ORDER BY sub.mes) FILTER (WHERE sub.tipo = 'geracao') AS meses_geracao
    FROM (
      -- Consumo: apenas classes que têm consumo próprio
      SELECT cd.agente, a.classe, cd.mes, 'carga' AS tipo
      FROM ccee_dados cd
      JOIN ccee_agentes a USING (agente)
      WHERE cd.mes >= $1
        AND a.classe NOT IN ('Comercializador', 'Gerador')
        AND cd.consumo IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ccee_modulacao cm
          WHERE cm.agente = cd.agente AND cm.mes_referencia = cd.mes
        )
      UNION ALL
      -- Geração: todos exceto Comercializadores
      SELECT DISTINCT gh.agente, a.classe, gh.mes_referencia AS mes, 'geracao' AS tipo
      FROM ccee_geracao_horaria gh
      JOIN ccee_agentes a USING (agente)
      WHERE gh.mes_referencia >= $1
        AND a.classe NOT IN ('Comercializador')
        AND NOT EXISTS (
          SELECT 1 FROM ccee_modulacao_geracao mg
          WHERE mg.agente = gh.agente AND mg.mes_referencia = gh.mes_referencia
        )
    ) sub
    GROUP BY sub.agente, sub.classe
    ORDER BY sub.agente
  `, [PRIMEIRO_MES_PLD]);

  return r.rows.map(row => ({
    agente:          row.agente,
    classe:          row.classe,
    meses_carga:     row.meses_carga     || [],
    meses_geracao:   row.meses_geracao   || [],
    total_pendentes: (row.meses_carga?.length || 0) + (row.meses_geracao?.length || 0),
  }));
}

// Atualiza ccee_dados para agentes cujo último mês fica abaixo do mês mais recente
// disponível no banco (algum agente já buscou o mês novo → usamos como referência).
async function atualizarDadosAtrasados() {
  // Consulta cargas CCEE para descobrir o mês mais recente disponível (com cache 1h)
  const mesAlvo = await ultimoMesDisponivelCCEE();
  if (!mesAlvo) {
    console.warn("[dados-auto] Não foi possível determinar o mês mais recente nas cargas CCEE.");
    return;
  }

  console.log(`[dados-auto] Mês mais recente nas cargas CCEE: ${mesAlvo}`);

  const rAtrasados = await pool.query(`
    SELECT agente, MAX(mes) AS ultimo_mes
    FROM ccee_dados
    GROUP BY agente
    HAVING MAX(mes) < $1
    ORDER BY agente
  `, [mesAlvo]);

  if (!rAtrasados.rows.length) {
    console.log(`[dados-auto] Todos os agentes já têm dados até ${mesAlvo}.`);
    return;
  }

  console.log(`[dados-auto] ${rAtrasados.rows.length} agentes atrasados (alvo=${mesAlvo}). Atualizando...`);

  for (const { agente, ultimo_mes } of rAtrasados.rows) {
    try {
      await comRetry(() => fetchSalvarRetornar(agente, mesAlvo, true), 2, `dados ${agente}`);
      console.log(`[dados-auto] ${agente}: ${ultimo_mes} → ${mesAlvo}`);
    } catch (err) {
      console.warn(`[dados-auto] ${agente}: erro ao atualizar — ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1500)); // pausa entre agentes
  }
}

async function processarTodosPendentes() {
  // 1. Garante que todos os agentes têm o mês mais recente em ccee_dados
  await atualizarDadosAtrasados();

  // 2. Agora verifica pendentes de modulação (já com ccee_dados atualizado)
  const pendentes = await queryPendentes();
  if (!pendentes.length) {
    console.log("[pendentes] Nenhuma modulação pendente.");
    return { processados: 0, pendentes: [] };
  }

  console.log(`[pendentes] ${pendentes.length} agentes com modulação pendente.`);

  let processados = 0;
  for (const { agente, classe, meses_carga, meses_geracao } of pendentes) {
    const emAndamento = modulacaoEmAndamento.has(agente) || modulacaoGeracaoEmAndamento.has(agente);
    const naFila      = filaProcessamento.tamanho > 0;
    if (emAndamento) {
      console.log(`[pendentes] ${agente}: já em andamento, pulando.`);
      continue;
    }
    console.log(`[pendentes] → ${agente} (${classe}): ${meses_carga.length} carga + ${meses_geracao.length} geração | fila: ${filaProcessamento.tamanho}`);
    if (meses_carga.length)   dispararModulacaoBackground(agente, classe);
    if (meses_geracao.length) dispararModulacaoGeracaoBackground(agente, classe);
    processados++;
  }

  return { processados, pendentes };
}

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`API rodando em http://localhost:${PORT}`);
    // Warm-up: tenta conectar ao banco com retries para acordar o Aiven free tier
    for (let i = 1; i <= 5; i++) {
      try {
        await pool.query("SELECT 1");
        console.log("[startup] Banco conectado ✓");
        break;
      } catch (err) {
        console.warn(`[startup] Banco não respondeu (tentativa ${i}/5): ${err.message}`);
        if (i < 5) await new Promise(r => setTimeout(r, 6000));
      }
    }
    // Cron: processa modulações pendentes 4× por dia (06h, 11h, 16h, 21h horário do servidor)
    cron.schedule("0 6,11,16,21 * * *", async () => {
      console.log(`\n[cron ${new Date().toISOString()}] Verificando modulações pendentes...`);
      try {
        const { processados, pendentes } = await processarTodosPendentes();
        console.log(`[cron] Concluído: ${processados}/${pendentes.length} agentes disparados.`);
      } catch (e) {
        console.error("[cron] Erro:", e.message);
      }
    });

    console.log("[cron] Agendado: verificação de pendentes às 06h, 11h, 16h, 21h.");
  });
}

module.exports = app;
