// scripts/rodar-tudo.js
// Pipeline completo:
//   1. Streama CKAN consumo horário → descobre TODOS os agentes do arquivo
//   2. Novos (não no banco) → Power BI Q2 (metadata) → insere ccee_agentes
//   3. Novos → CKAN cargas + usinas + contabilização → salva no banco
//   4. Todos → salva consumo horário + calcula modulação
//
// Uso:
//   node scripts/rodar-tudo.js
//   node scripts/rodar-tudo.js --mes 2025-03   (mês específico)
//   node scripts/rodar-tudo.js --sem-powerbi    (pula onboarding de novos agentes)

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const fetch  = require("node-fetch");
const zlib   = require("zlib");
const { Pool } = require("pg");
const { buscarContabilizacao }          = require("../api/ccee-abertos/contabilizacao");
const { buscarConsumoMensalPerfil }     = require("../api/ccee-abertos/consumo-mensal-perfil");
const { buscarContratosPerfil }         = require("../api/ccee-abertos/contratos-perfil");
const { buscarHistoricoPowerBI }        = require("../api/powerbi-batch");
const { buscarUsinas }                  = require("../api/ccee-abertos/geracao");
const { buscarCargas }                  = require("../api/ccee-abertos/cargas");
const { buscarPldHorarioMapa }          = require("../api/ccee-abertos/pld-horario");
const { listarRecursos: listarConsumo } = require("../api/ccee-abertos/consumo-horario");
const { buscarGeracaoHoraria, listarRecursos: listarGeracao } = require("../api/ccee-abertos/geracao-horaria");

// ─── Configuração ─────────────────────────────────────────────────────────────

const POWERBI_URL          = "https://wabi-brazil-south-b-primary-api.analysis.windows.net/public/reports/querydata?synchronous=true";
const POWERBI_RESOURCE_KEY = process.env.POWERBI_RESOURCE_KEY;
const POWERBI_MODEL_ID     = Number(process.env.POWERBI_MODEL_ID);

const PRIMEIRO_MES   = "2025-01";
const PRIMEIRO_ANO_CONTAB = 2024; // busca contabilização a partir deste ano
const USER_AGENT     = "Mozilla/5.0 (compatible; CCEEMonitor/1.0)";
const TIMEOUT_DL     = 600000;
const CLASSES_SKIP   = new Set(["Comercializador"]);
const DELAY_MS       = 1500;

const args          = process.argv.slice(2);
const MES_FIXO      = (() => { const i = args.indexOf("--mes"); return i !== -1 ? (args[i + 1] || null) : null; })();
const SO_MODULACAO  = args.includes("--so-modulacao");
const SEM_POWERBI   = args.includes("--sem-powerbi") || SO_MODULACAO;
const SEM_CONTAB    = args.includes("--sem-contab")  || SO_MODULACAO;
const SEM_PERFIL    = args.includes("--sem-perfil")  || SO_MODULACAO;
const TODOS_MESES   = args.includes("--todos-meses"); // streama todos os meses p/ descoberta
const APENAS_UF     = (() => {                        // --apenas-uf MG  ou  --apenas-uf PB,PE,CE,RN,BA,...
  const idx = args.indexOf("--apenas-uf");
  if (idx === -1) return null;
  const lista = (args[idx + 1] || "").toUpperCase().split(",").map(s => s.trim()).filter(Boolean);
  return lista.length ? lista : null;
})();

// Limite de tamanho do banco (MB). Lê de DB_MAX_MB no .env, padrão 4500 MB (~4,4 GB)
// Seta para o tamanho INCLUÍDO no plano (sem o espaço extra).
const DB_MAX_MB     = Number(process.env.DB_MAX_MB || 4500);
const DB_ALERTA_PCT = 0.92; // para de inserir ao atingir 92% do limite

const pool = new Pool({
  connectionString:              process.env.DATABASE_URL,
  ssl:                           { rejectUnauthorized: false },
  idleTimeoutMillis:             60000,
  connectionTimeoutMillis:       30000,
  keepAlive:                     true,
  keepAliveInitialDelayMillis:   10000,
});

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Limitador de espaço ──────────────────────────────────────────────────────

let _espacoOk = true; // flag global — false = banco cheio, para inserções pesadas

async function checarEspaco(label = "") {
  try {
    const { rows } = await pool.query(
      "SELECT pg_database_size(current_database()) AS bytes, pg_size_pretty(pg_database_size(current_database())) AS legivel"
    );
    const bytes   = Number(rows[0].bytes);
    const legivel = rows[0].legivel;
    const usadoMB = bytes / (1024 * 1024);
    const limiteMB = DB_MAX_MB;
    const pct      = usadoMB / limiteMB;

    const status = pct >= DB_ALERTA_PCT ? "🔴 CHEIO" : pct >= 0.80 ? "🟡 atencao" : "🟢 ok";
    console.log(`  💾 Banco: ${legivel} / ${limiteMB.toLocaleString("pt-BR")} MB (${(pct * 100).toFixed(1)}%) ${status}${label ? ` [${label}]` : ""}`);

    _espacoOk = pct < DB_ALERTA_PCT;
    return _espacoOk;
  } catch (e) {
    console.warn(`  checarEspaco: ${e.message}`);
    return true; // em caso de erro na consulta, não bloqueia
  }
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

const SUB_MAP = {
  SUDESTE: "SE", "SUDESTE/CENTRO-OESTE": "SE", SECO: "SE",
  SUL: "S", NORDESTE: "NE", NORTE: "N",
  SE: "SE", S: "S", NE: "NE", N: "N",
};

function stripAccents(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Normaliza nome para matching: remove acentos e aspas simples (que podem ou não estar no valor)
function normalizarNome(s) {
  return stripAccents((s || "").replace(/'/g, "").trim().toUpperCase());
}

async function streamGzip(url, onLinha) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_DL);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    return await new Promise((resolve, reject) => {
      let headers = null, sep = ";", leftover = "", total = 0;

      const processar = (chunk) => {
        const text   = leftover + chunk.toString("utf8");
        const linhas = text.split("\n");
        leftover = linhas.pop();
        for (const linha of linhas) {
          const l = linha.replace(/\r$/, "").trim();
          if (!l) continue;
          if (!headers) {
            sep     = l.includes(";") ? ";" : ",";
            headers = l.split(sep).map(h => h.replace(/^"|"$/g, "").trim());
            continue;
          }
          total++;
          const vals = l.split(sep).map(v => v.replace(/^"+|"+$/g, "").trim());
          const row  = {};
          headers.forEach((h, i) => { row[h] = vals[i] ?? null; });
          onLinha(row);
        }
      };

      const body = res.body;
      body.once("data", first => {
        const isGzip = first[0] === 0x1F && first[1] === 0x8B;
        if (isGzip) {
          const gz = zlib.createGunzip();
          gz.on("error", reject);
          gz.on("data", processar);
          gz.on("end", () => { if (leftover.trim()) processar(leftover + "\n"); console.log(`    ${total.toLocaleString()} linhas lidas`); resolve(); });
          gz.write(first);
          body.pipe(gz);
        } else {
          processar(first);
          body.on("data", processar);
          body.on("end", () => { if (leftover.trim()) processar(leftover + "\n"); console.log(`    ${total.toLocaleString()} linhas lidas`); resolve(); });
        }
        body.on("error", reject);
      });
    });
  } finally { clearTimeout(timer); }
}

async function withRetry(fn, tentativas = 4, delayBase = 10000) {
  for (let t = 1; t <= tentativas; t++) {
    try { return await fn(); } catch (e) {
      if (t === tentativas) throw e;
      const delay = delayBase * t;
      console.log(`\n  [retry ${t}/${tentativas - 1}] ${e.message} — aguardando ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ─── Fase 1: Descobrir agentes no CKAN ───────────────────────────────────────

async function descobrirAgentesNoCKAN(recursos) {
  const disponíveis = recursos.filter(r => r.mes >= PRIMEIRO_MES);
  if (!disponíveis.length) throw new Error("Nenhum recurso CKAN disponível");

  // Quais meses streama para descoberta:
  //   --todos-meses  → todos disponíveis (mais completo, mais lento)
  //   --mes YYYY-MM  → só esse mês
  //   default        → mais recente apenas
  let paraBuscar;
  if (MES_FIXO) {
    const r = disponíveis.find(r => r.mes === MES_FIXO);
    paraBuscar = r ? [r] : [];
  } else if (TODOS_MESES) {
    paraBuscar = disponíveis;
  } else {
    paraBuscar = [disponíveis[disponíveis.length - 1]];
  }

  if (!paraBuscar.length) throw new Error("Nenhum recurso CKAN para descoberta");

  const nomes = new Set();
  for (const recurso of paraBuscar) {
    console.log(`\n  Descobrindo agentes em ${recurso.mes}...`);
    await withRetry(() => streamGzip(recurso.url, row => {
      const nome = (row.NOME_EMPRESARIAL || "").trim();
      if (nome) nomes.add(nome);
    }));
  }

  console.log(`  ${nomes.size} agentes distintos nos ${paraBuscar.length} meses verificados`);
  return [...nomes];
}

// ─── Power BI Q2: metadata de um agente ──────────────────────────────────────

async function buscarMetaPowerBI(agente) {
  const body = {
    version: "1.0.0",
    modelId: POWERBI_MODEL_ID,
    queries: [{
      Query: { Commands: [{ SemanticQueryDataShapeCommand: {
        Query: {
          Version: 2,
          From: [
            { Name: "s", Entity: "SEGURANCA_MERCADO",  Type: 0 },
            { Name: "m", Entity: "MEDIDAS_CALCULADAS", Type: 0 },
            { Name: "t", Entity: "TabelaBusca",        Type: 0 },
            { Name: "c", Entity: "CALENDARIO",         Type: 0 },
          ],
          Select: [
            { Column: { Expression: { SourceRef: { Source: "s" } }, Property: "NM_CSSE"        } },
            { Column: { Expression: { SourceRef: { Source: "s" } }, Property: "NM_RZOA_SOCI"   } },
            { Column: { Expression: { SourceRef: { Source: "s" } }, Property: "SG_AGEN"        } },
            { Column: { Expression: { SourceRef: { Source: "s" } }, Property: "CNPJ_Formatado" } },
            { Column: { Expression: { SourceRef: { Source: "s" } }, Property: "DS_STAT_AGEN"   } },
          ],
          Where: [
            { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Tipo"  } }], Values: [[{ Literal: { Value: "'Razão Social'"   } }]] } } },
            { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "c" } }, Property: "FiltroMesAno" } }], Values: [[{ Literal: { Value: "'(mais recente)'" } }]] } } },
            { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Valor" } }], Values: [[{ Literal: { Value: `'${agente.replace(/'/g, "''")}'` } }]] } } },
          ],
        },
        Binding: {
          Primary: { Groupings: [{ Projections: [0, 1, 2, 3, 4] }] },
          DataReduction: { DataVolume: 3, Primary: { Window: { Count: 10 } } },
          Version: 1,
        },
      }}] },
    }],
    cancelQueries: [],
  };

  const resp = await fetch(POWERBI_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "X-PowerBI-ResourceKey": POWERBI_RESOURCE_KEY },
    body:    JSON.stringify(body),
  });
  const json  = await resp.json();
  const dsr   = json?.results?.[0]?.result?.data?.dsr?.DS?.[0];
  const dm    = dsr?.PH?.[0]?.DM0;
  const dicts = dsr?.ValueDicts || {};
  if (!dm?.length) return null;

  const C = dm[0].C || [];
  const d = (key, idx) => {
    if (typeof idx === "string") return idx;
    return dicts[key] ? (dicts[key][idx] ?? null) : null;
  };
  return {
    classe:       d("D0", C[0]) || null,
    razao_social: d("D1", C[1]) || null,
    sigla:        d("D2", C[2]) || null,
    cnpj:         d("D3", C[3]) || null,
    situacao:     d("D4", C[4]) || null,
  };
}

// ─── Fase 2: Inserir agente novo no banco ─────────────────────────────────────

async function inserirAgente(agente, meta) {
  await pool.query(`
    INSERT INTO ccee_agentes (agente, razao_social, sigla, cnpj, classe, situacao)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (agente) DO UPDATE SET
      razao_social = COALESCE(EXCLUDED.razao_social, ccee_agentes.razao_social),
      sigla        = COALESCE(EXCLUDED.sigla,        ccee_agentes.sigla),
      cnpj         = COALESCE(EXCLUDED.cnpj,         ccee_agentes.cnpj),
      classe       = COALESCE(EXCLUDED.classe,       ccee_agentes.classe),
      situacao     = COALESCE(EXCLUDED.situacao,     ccee_agentes.situacao),
      updated_at   = NOW()
  `, [agente, meta.razao_social, meta.sigla, meta.cnpj, meta.classe, meta.situacao]);
}

// ─── Fase 3: CKAN — cargas, usinas, contabilização ───────────────────────────

async function salvarCargas(agente, registros) {
  if (!registros.length) return;
  const BATCH = 200;
  for (let i = 0; i < registros.length; i += BATCH) {
    const lote = registros.slice(i, i + BATCH);
    await pool.query(`
      INSERT INTO ccee_cargas (
        agente, sigla_perfil_agente, mes_referencia, cod_perf_agente, nome_empresarial,
        cod_parcela_carga, sigla_parcela_carga, cnpj_carga, cidade, estado_uf,
        ramo_atividade, submercado, capacidade_carga, consumo_acl,
        consumo_cativo_parc_livre, consumo_total
      )
      SELECT * FROM UNNEST(
        $1::text[],$2::text[],$3::char(7)[],$4::text[],$5::text[],
        $6::text[],$7::text[],$8::text[],$9::text[],$10::char(2)[],
        $11::text[],$12::text[],$13::numeric[],$14::numeric[],
        $15::numeric[],$16::numeric[]
      )
      ON CONFLICT (agente, sigla_parcela_carga, mes_referencia) DO NOTHING
    `, [
      lote.map(() => agente),
      lote.map(r => r.sigla_perfil_agente || null),
      lote.map(r => r.mes_referencia),
      lote.map(r => r.cod_perf_agente || null),
      lote.map(r => r.nome_empresarial || null),
      lote.map(r => r.cod_parcela_carga || null),
      lote.map(r => r.sigla_parcela_carga || null),
      lote.map(r => r.cnpj_carga || null),
      lote.map(r => r.cidade || null),
      lote.map(r => r.estado_uf || null),
      lote.map(r => r.ramo_atividade || null),
      lote.map(r => r.submercado || null),
      lote.map(r => r.capacidade_carga ?? null),
      lote.map(r => r.consumo_acl ?? null),
      lote.map(r => r.consumo_cativo_parc_livre ?? null),
      lote.map(r => r.consumo_total ?? null),
    ]);
  }
  console.log(`    cargas: ${registros.length} registros`);
}

async function salvarUsinas(agente, registros) {
  if (!registros.length) return;
  const BATCH = 200;
  for (let i = 0; i < registros.length; i += BATCH) {
    const lote = registros.slice(i, i + BATCH);
    await pool.query(`
      INSERT INTO ccee_usinas (
        agente, sigla_perfil, mes_referencia, sigla_ativo, cod_parcela_usina,
        sigla_parcela_usina, tipo_despacho, fonte_energia_primaria, submercado,
        estado_uf, caracteristica_parcela, participante_mre, participante_regime_cotas,
        percentual_desconto_usina, cap_t, geracao_centro_gravidade, gf_centro_gravidade
      )
      SELECT * FROM UNNEST(
        $1::text[],$2::text[],$3::char(7)[],$4::text[],$5::text[],
        $6::text[],$7::text[],$8::text[],$9::text[],
        $10::char(2)[],$11::text[],$12::text[],$13::text[],
        $14::numeric[],$15::numeric[],$16::numeric[],$17::numeric[]
      )
      ON CONFLICT (sigla_parcela_usina, mes_referencia) DO NOTHING
    `, [
      lote.map(() => agente),
      lote.map(r => r.sigla_perfil_agente || null),
      lote.map(r => r.mes_referencia),
      lote.map(r => r.sigla_ativo || null),
      lote.map(r => r.cod_parcela_usina || null),
      lote.map(r => r.sigla_parcela_usina || null),
      lote.map(r => r.tipo_despacho || null),
      lote.map(r => r.fonte_energia_primaria || null),
      lote.map(r => r.submercado || null),
      lote.map(r => r.estado_uf || null),
      lote.map(r => r.caracteristica_parcela || null),
      lote.map(r => r.participante_mre || null),
      lote.map(r => r.participante_regime_cotas || null),
      lote.map(r => r.percentual_desconto_usina ?? null),
      lote.map(r => r.cap_t ?? null),
      lote.map(r => r.geracao_centro_gravidade ?? null),
      lote.map(r => r.gf_centro_gravidade ?? null),
    ]);
  }
  console.log(`    usinas: ${registros.length} registros`);
}

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
        $1::text[],$2::char(7)[],$3::text[],$4::text[],$5::integer[],
        $6::numeric[],$7::numeric[],$8::numeric[],$9::numeric[],
        $10::numeric[],$11::numeric[],$12::numeric[],
        $13::numeric[],$14::numeric[],$15::numeric[],
        $16::numeric[],$17::numeric[],$18::numeric[],
        $19::numeric[],$20::numeric[],$21::numeric[]
      )
      ON CONFLICT (agente, mes_referencia, sigla_perfil_agente) DO UPDATE SET
        resultado_final = EXCLUDED.resultado_final
    `, [
      lote.map(() => agente),
      lote.map(r => r.mes_referencia),
      lote.map(r => r.sigla_perfil_agente || null),
      lote.map(r => r.nome_empresarial || null),
      lote.map(r => r.cod_perf_agente != null ? Number(r.cod_perf_agente) : null),
      lote.map(r => r.valor_tm_mcp), lote.map(r => r.compensacao_mre),
      lote.map(r => r.valor_encargo), lote.map(r => r.valor_ajuste_exposicao),
      lote.map(r => r.valor_ajuste_alivio_ret), lote.map(r => r.efeito_contrat_disp),
      lote.map(r => r.efeito_contrat_cota_gf), lote.map(r => r.efeito_contrat_nuclear),
      lote.map(r => r.ajuste_recontab), lote.map(r => r.ajuste_mcsd_ex),
      lote.map(r => r.resultado_financeiro_er), lote.map(r => r.efeito_ccearq),
      lote.map(r => r.efeito_contrat_itaipu), lote.map(r => r.efeito_repasse_risco_hidro),
      lote.map(r => r.efeito_desloc_pld_cmo), lote.map(r => r.resultado_final),
    ]);
  }
  console.log(`    contabilização: ${registros.length} registros`);
}

async function salvarConsumoMensalPerfilDB(agente, registros) {
  if (!registros.length) return;
  const BATCH = 500;
  for (let i = 0; i < registros.length; i += BATCH) {
    const lote = registros.slice(i, i + BATCH);
    await pool.query(`
      INSERT INTO ccee_consumo_mensal_perfil (agente, mes_referencia, sigla_perfil, consumo_mwh, consumo_geracao_mwh)
      SELECT * FROM UNNEST($1::text[], $2::char(7)[], $3::text[], $4::numeric[], $5::numeric[])
      ON CONFLICT (agente, mes_referencia, sigla_perfil) DO UPDATE
        SET consumo_mwh = EXCLUDED.consumo_mwh, consumo_geracao_mwh = EXCLUDED.consumo_geracao_mwh
    `, [
      lote.map(() => agente),
      lote.map(r => r.mes_referencia),
      lote.map(r => r.sigla_perfil),
      lote.map(r => r.consumo_mwh),
      lote.map(r => r.consumo_geracao_mwh ?? null),
    ]);
  }
}

async function salvarContratosMensalPerfilDB(agente, registros) {
  if (!registros.length) return;
  const BATCH = 500;
  for (let i = 0; i < registros.length; i += BATCH) {
    const lote = registros.slice(i, i + BATCH);
    await pool.query(`
      INSERT INTO ccee_contrato_mensal_perfil (agente, mes_referencia, sigla_perfil, compra_mwh, venda_mwh)
      SELECT * FROM UNNEST($1::text[], $2::char(7)[], $3::text[], $4::numeric[], $5::numeric[])
      ON CONFLICT (agente, mes_referencia, sigla_perfil) DO UPDATE
        SET compra_mwh = EXCLUDED.compra_mwh, venda_mwh = EXCLUDED.venda_mwh
    `, [
      lote.map(() => agente),
      lote.map(r => r.mes_referencia),
      lote.map(r => r.sigla_perfil),
      lote.map(r => r.compra_mwh ?? null),
      lote.map(r => r.venda_mwh  ?? null),
    ]);
  }
}

async function salvarDadosPowerBI(agente, registros) {
  if (!registros.length) return;
  const BATCH = 200;
  for (let i = 0; i < registros.length; i += BATCH) {
    const lote = registros.slice(i, i + BATCH);
    await pool.query(`
      INSERT INTO ccee_dados (agente, mes, balanco_energetico, mcp, compra, consumo, geracao)
      SELECT * FROM UNNEST($1::text[], $2::char(7)[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[])
      ON CONFLICT (agente, mes) DO UPDATE SET
        balanco_energetico = EXCLUDED.balanco_energetico,
        mcp                = EXCLUDED.mcp,
        compra             = COALESCE(EXCLUDED.compra,  ccee_dados.compra),
        consumo            = COALESCE(EXCLUDED.consumo, ccee_dados.consumo),
        geracao            = COALESCE(EXCLUDED.geracao, ccee_dados.geracao)
    `, [
      lote.map(() => agente),
      lote.map(r => r.mes),
      lote.map(r => r.balanco_energetico ?? 0),
      lote.map(r => r.mcp ?? 0),
      lote.map(r => r.compra  ?? null),
      lote.map(r => r.consumo ?? null),
      lote.map(r => r.geracao ?? null),
    ]);
  }
}

async function onboardarAgente(agente, razaoSocial, sigla) {
  console.log(`\n  ► Onboarding: ${agente}`);
  try {
    const [cargas, usinas, contab] = await Promise.allSettled([
      buscarCargas(sigla, { razaoSocial }),
      buscarUsinas(razaoSocial || agente),
      buscarContabilizacao(razaoSocial || agente, { anos: Array.from({ length: new Date().getFullYear() - PRIMEIRO_ANO_CONTAB + 1 }, (_, i) => PRIMEIRO_ANO_CONTAB + i) }),
    ]);
    if (cargas.status  === "fulfilled") await salvarCargas(agente, cargas.value);
    if (usinas.status  === "fulfilled") await salvarUsinas(agente, usinas.value);
    if (contab.status  === "fulfilled") await salvarContabilizacao(agente, contab.value);
  } catch (e) {
    console.warn(`    Erro no onboarding CKAN: ${e.message}`);
  }
}

// ─── Fase 4: consumo horário + modulação (igual rodar-modulacao-batch) ────────

async function salvarConsumo(agente, registros) {
  if (!registros.length) return;
  const BATCH = 500;
  for (let i = 0; i < registros.length; i += BATCH) {
    const lote = registros.slice(i, i + BATCH);
    await pool.query(`
      INSERT INTO ccee_consumo_horario (agente, mes_referencia, periodo, submercado, consumo_mwh)
      SELECT * FROM UNNEST($1::text[],$2::char(7)[],$3::integer[],$4::text[],$5::numeric[])
      ON CONFLICT (agente, mes_referencia, periodo, submercado) DO NOTHING
    `, [
      lote.map(() => agente), lote.map(r => r.mes_referencia),
      lote.map(r => r.periodo), lote.map(r => r.submercado), lote.map(r => r.consumo_mwh),
    ]);
  }
}

async function salvarConsumoPerfil(agente, registros) {
  if (!registros.length) return;
  const BATCH = 500;
  for (let i = 0; i < registros.length; i += BATCH) {
    const lote = registros.slice(i, i + BATCH);
    await pool.query(`
      INSERT INTO ccee_consumo_horario_perfil (agente, mes_referencia, sigla_perfil, periodo, submercado, consumo_mwh)
      SELECT * FROM UNNEST($1::text[],$2::char(7)[],$3::text[],$4::integer[],$5::text[],$6::numeric[])
      ON CONFLICT (agente, mes_referencia, sigla_perfil, periodo, submercado) DO NOTHING
    `, [
      lote.map(() => agente), lote.map(r => r.mes_referencia), lote.map(r => r.sigla_perfil),
      lote.map(r => r.periodo), lote.map(r => r.submercado), lote.map(r => r.consumo_mwh),
    ]);
  }
}

async function salvarGeracaoHoraria(agente, registros) {
  if (!registros.length) return;
  const BATCH = 500;
  for (let i = 0; i < registros.length; i += BATCH) {
    const lote = registros.slice(i, i + BATCH);
    await pool.query(`
      INSERT INTO ccee_geracao_horaria (agente, mes_referencia, sigla_usina, periodo, submercado, geracao_mwmed)
      SELECT * FROM UNNEST($1::text[],$2::char(7)[],$3::text[],$4::integer[],$5::text[],$6::numeric[])
      ON CONFLICT (agente, mes_referencia, periodo, submercado, sigla_usina) DO NOTHING
    `, [
      lote.map(() => agente), lote.map(r => r.mes_referencia), lote.map(r => r.sigla_usina),
      lote.map(r => r.periodo), lote.map(r => r.submercado), lote.map(r => r.geracao_mwmed),
    ]);
  }
}

// Mantém no máximo 3 meses no cache de PLD para evitar acúmulo de memória
const _pldCache = {};
async function getPldMapa(mes) {
  if (!_pldCache[mes]) {
    const chaves = Object.keys(_pldCache);
    if (chaves.length >= 3) delete _pldCache[chaves[0]];
    _pldCache[mes] = await buscarPldHorarioMapa(mes);
  }
  return _pldCache[mes];
}

function calcularModulacaoPorSub(consumo, pldMapa, sub) {
  const registros = consumo.filter(r => r.submercado === sub);
  if (!registros.length) return null;
  let totalConsumo = 0, somaCurva = 0;
  for (const r of registros) {
    const mwh = Number(r.consumo_mwh) || 0;
    const pld = pldMapa[`${r.periodo}|${sub}`];
    if (pld == null) continue;
    totalConsumo += mwh;
    somaCurva    += mwh * pld;
  }
  let somaPld = 0, nHoras = 0;
  for (const [key, pld] of Object.entries(pldMapa)) {
    if (key.endsWith(`|${sub}`)) { somaPld += pld; nHoras++; }
  }
  if (!nHoras || !totalConsumo) return null;
  const flat  = totalConsumo / nHoras;
  const custo = (somaCurva - flat * somaPld) / totalConsumo;
  return {
    submercado: sub, consumo_total_mwh: Number(totalConsumo.toFixed(4)),
    n_horas: nHoras, soma_curva_rs: Number(somaCurva.toFixed(4)),
    soma_flat_rs: Number((flat * somaPld).toFixed(4)),
    custo_modulacao_rs_mwh: Number(custo.toFixed(4)),
  };
}

async function calcularModulacao(agente, meses) {
  for (const mes of meses) {
    const { rows } = await pool.query(
      "SELECT periodo, submercado, consumo_mwh FROM ccee_consumo_horario WHERE agente=$1 AND mes_referencia=$2",
      [agente, mes]
    );
    if (!rows.length) continue;
    let pldMapa;
    try { pldMapa = await getPldMapa(mes); } catch (e) { console.warn(`    PLD ${mes}: ${e.message}`); continue; }
    const subs      = [...new Set(rows.map(r => r.submercado))];
    const resultados = subs.map(s => calcularModulacaoPorSub(rows, pldMapa, s)).filter(Boolean);
    if (!resultados.length) continue;
    await pool.query(`
      INSERT INTO ccee_modulacao
        (agente, mes_referencia, submercado, consumo_total_mwh, n_horas, soma_curva_rs, soma_flat_rs, custo_modulacao_rs_mwh)
      SELECT * FROM UNNEST($1::text[],$2::char(7)[],$3::text[],$4::numeric[],$5::integer[],$6::numeric[],$7::numeric[],$8::numeric[])
      ON CONFLICT (agente, mes_referencia, submercado) DO UPDATE SET
        consumo_total_mwh=$4[1], n_horas=$5[1], soma_curva_rs=$6[1], soma_flat_rs=$7[1], custo_modulacao_rs_mwh=$8[1]
    `, [
      resultados.map(() => agente), resultados.map(() => mes),
      resultados.map(r => r.submercado), resultados.map(r => r.consumo_total_mwh),
      resultados.map(r => r.n_horas), resultados.map(r => r.soma_curva_rs),
      resultados.map(r => r.soma_flat_rs), resultados.map(r => r.custo_modulacao_rs_mwh),
    ]);
    resultados.forEach(r => console.log(`    ${mes} ${r.submercado}: ${r.consumo_total_mwh} MWh | ${r.custo_modulacao_rs_mwh} R$/MWh`));
  }
}

function calcularModulacaoGeracaoUsinaSub(geracao, pldMapa, siglaUsina, submercadoFiltro) {
  const registros = geracao.filter(r => r.sigla_usina === siglaUsina && r.submercado === submercadoFiltro);
  if (!registros.length) return null;
  let totalGeracao = 0, somaCurva = 0;
  for (const r of registros) {
    const geracaoMwmed = Number(r.geracao_mwmed) || 0;
    const pld = pldMapa[`${r.periodo}|${submercadoFiltro}`];
    if (pld == null) continue;
    totalGeracao += geracaoMwmed;
    somaCurva    += geracaoMwmed * pld;
  }
  let somaPldTotal = 0, nHorasPld = 0;
  for (const [key, pld] of Object.entries(pldMapa)) {
    if (key.endsWith(`|${submercadoFiltro}`)) { somaPldTotal += pld; nHorasPld++; }
  }
  if (!nHorasPld || !totalGeracao) return null;
  const flat  = totalGeracao / nHorasPld;
  const custo = (somaCurva - flat * somaPldTotal) / totalGeracao;
  return {
    sigla_usina:            siglaUsina,
    submercado:             submercadoFiltro,
    geracao_total_mwh:      Number(totalGeracao.toFixed(4)),
    n_horas:                nHorasPld,
    soma_curva_rs:          Number(somaCurva.toFixed(4)),
    soma_flat_rs:           Number((flat * somaPldTotal).toFixed(4)),
    custo_modulacao_rs_mwh: Number(custo.toFixed(4)),
  };
}

async function salvarModulacaoGeracao(agente, mes, resultados) {
  if (!resultados.length) return;
  await pool.query(`
    INSERT INTO ccee_modulacao_geracao
      (agente, mes_referencia, sigla_usina, submercado, geracao_total_mwh, n_horas, soma_curva_rs, soma_flat_rs, custo_modulacao_rs_mwh)
    SELECT * FROM UNNEST($1::text[],$2::char(7)[],$3::text[],$4::text[],$5::numeric[],$6::integer[],$7::numeric[],$8::numeric[],$9::numeric[])
    ON CONFLICT (agente, mes_referencia, sigla_usina, submercado) DO UPDATE SET
      geracao_total_mwh      = EXCLUDED.geracao_total_mwh,
      n_horas                = EXCLUDED.n_horas,
      soma_curva_rs          = EXCLUDED.soma_curva_rs,
      soma_flat_rs           = EXCLUDED.soma_flat_rs,
      custo_modulacao_rs_mwh = EXCLUDED.custo_modulacao_rs_mwh,
      created_at             = NOW()
  `, [
    resultados.map(() => agente), resultados.map(() => mes),
    resultados.map(r => r.sigla_usina), resultados.map(r => r.submercado),
    resultados.map(r => r.geracao_total_mwh), resultados.map(r => r.n_horas),
    resultados.map(r => r.soma_curva_rs), resultados.map(r => r.soma_flat_rs),
    resultados.map(r => r.custo_modulacao_rs_mwh),
  ]);
}

async function calcularModulacaoGeracao(agente, meses, siglasUsinas) {
  for (const mes of meses) {
    const nDB = await pool.query(
      "SELECT COUNT(*) AS n FROM ccee_geracao_horaria WHERE agente=$1 AND mes_referencia=$2",
      [agente, mes]
    );
    if (Number(nDB.rows[0].n) === 0) {
      const espacoOk = await checarEspaco(`ger ${agente} ${mes}`);
      if (!espacoOk) {
        console.log(`\n  🔴 Banco cheio — interrompendo modulação de geração.`);
        return;
      }
      try {
        const registros = await buscarGeracaoHoraria(mes, siglasUsinas);
        if (registros.length > 0) await salvarGeracaoHoraria(agente, registros);
        else { console.log(`    ${mes}: sem geração`); continue; }
      } catch (e) { console.warn(`    Geração ${mes}: ${e.message}`); continue; }
    }

    const rGeracao = await pool.query(
      "SELECT sigla_usina, periodo, submercado, geracao_mwmed FROM ccee_geracao_horaria WHERE agente=$1 AND mes_referencia=$2 ORDER BY sigla_usina, periodo",
      [agente, mes]
    );
    if (!rGeracao.rows.length) continue;

    let pldMapa;
    try { pldMapa = await getPldMapa(mes); } catch (e) { console.warn(`    PLD ${mes}: ${e.message}`); continue; }

    const combos = [...new Set(rGeracao.rows.map(r => `${r.sigla_usina}|${r.submercado}`))];
    const resultados = combos
      .map(c => { const [u, s] = c.split("|"); return calcularModulacaoGeracaoUsinaSub(rGeracao.rows, pldMapa, u, s); })
      .filter(Boolean);
    if (!resultados.length) continue;
    await salvarModulacaoGeracao(agente, mes, resultados);
    resultados.forEach(r => console.log(`    ${mes} ${r.sigla_usina} ${r.submercado}: ${r.geracao_total_mwh} MWh | ${r.custo_modulacao_rs_mwh} R$/MWh`));
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("🚀 PIPELINE COMPLETO — CCEE Monitor");
  console.log("═".repeat(60));

  // Carrega CKAN resources
  const [recursosCon, recursosGer] = await Promise.all([listarConsumo(), listarGeracao()]);
  const mesesDisponiveis = recursosCon.map(r => r.mes).filter(m => m >= PRIMEIRO_MES);
  const urlConsumo = Object.fromEntries(recursosCon.map(r => [r.mes, r.url]));
  const urlGeracao = Object.fromEntries(recursosGer.map(r => [r.mes, r.url]));

  // ── Fase 1: Descobrir agentes no CKAN ──────────────────────────────────────
  console.log("\n[1/5] Descobrindo agentes no CKAN...");
  const nomesNoCKAN = await descobrirAgentesNoCKAN(recursosCon);

  // Agentes já no banco (por razao_social e por agente)
  const { rows: agentesBanco } = await pool.query(
    "SELECT agente, razao_social, sigla, cnpj, classe FROM ccee_agentes"
  );
  const porNome  = new Map(agentesBanco.map(r => [
    normalizarNome(r.razao_social || r.agente), r
  ]));
  const nomeToAgente = new Map(); // NOME_EMPRESARIAL (upper) → { agente, razao_social, sigla }

  // Mapeia nomes do CKAN para agentes do banco
  for (const nome of nomesNoCKAN) {
    const key = normalizarNome(nome);
    if (porNome.has(key)) {
      nomeToAgente.set(nome, porNome.get(key));
    }
  }

  const novosNomes = nomesNoCKAN.filter(n => !nomeToAgente.has(n));
  console.log(`  ${nomesNoCKAN.length} total | ${nomeToAgente.size} já no banco | ${novosNomes.length} novos`);

  // ── Fase 2: Onboarding de novos agentes ───────────────────────────────────
  if (novosNomes.length > 0 && !SEM_POWERBI) {
    console.log(`\n[2/5] Onboarding de ${novosNomes.length} novos agentes via Power BI...`);
    for (let i = 0; i < novosNomes.length; i++) {
      const nome = novosNomes[i];
      process.stdout.write(`  [${String(i + 1).padStart(3)}/${novosNomes.length}] ${nome.slice(0, 50).padEnd(52)} `);

      let meta = null;
      try { meta = await buscarMetaPowerBI(nome); } catch {}

      if (!meta) { console.log("⚠  não encontrado no Power BI"); continue; }
      if (CLASSES_SKIP.has(meta.classe)) { console.log(`⏭  ${meta.classe} — pulado`); continue; }

      // Usa SG_AGEN (sigla) como chave do agente — igual ao que a API usa
      const agenteKey = meta.sigla || nome;
      console.log(`✅  ${meta.classe || "?"} | agente: ${agenteKey}`);
      await inserirAgente(agenteKey, { ...meta, razao_social: meta.razao_social || nome });
      nomeToAgente.set(nome, { agente: agenteKey, razao_social: meta.razao_social || nome, sigla: meta.sigla, cnpj: meta.cnpj, classe: meta.classe });

      await onboardarAgente(agenteKey, meta.razao_social || nome, meta.sigla);
      if (i < novosNomes.length - 1) await delay(DELAY_MS);
    }
  } else if (novosNomes.length > 0) {
    console.log(`\n[2/5] ${novosNomes.length} novos ignorados (--sem-powerbi)`);
  } else {
    console.log("\n[2/5] Nenhum agente novo — pulando onboarding");
  }

  // Lista final de agentes a processar (todos que têm match no CKAN)
  let agentesAtivos = [...new Map(
    [...nomeToAgente.values()].map(a => [a.agente, a])
  ).values()].filter(a => !CLASSES_SKIP.has(a.classe));

  const nomeToAgenteKey = new Map(); // NOME_normalizado → agente_key
  for (const [nome, meta] of nomeToAgente) {
    nomeToAgenteKey.set(normalizarNome(nome), meta.agente);
  }

  // Filtro por UF (ex: --apenas-uf MG  ou  --apenas-uf PB,PE,CE,RN,BA,AL,SE,MA,PI)
  if (APENAS_UF) {
    const { rows: comUF } = await pool.query(
      "SELECT DISTINCT agente FROM ccee_cargas WHERE agente = ANY($1) AND estado_uf = ANY($2)",
      [agentesAtivos.map(a => a.agente), APENAS_UF]
    );
    const comUFSet = new Set(comUF.map(r => r.agente));
    const antes = agentesAtivos.length;
    agentesAtivos = agentesAtivos.filter(a => comUFSet.has(a.agente));
    console.log(`\n  Filtro UF=${APENAS_UF.join(",")}: ${agentesAtivos.length} de ${antes} agentes têm carga no(s) estado(s)`);
  }

  console.log(`\n  ${agentesAtivos.length} agentes para processar`);

  const ultimoMesDisp = mesesDisponiveis[mesesDisponiveis.length - 1] || "0000-00";

  // ── Fase 2.5: Atualiza contabilização de todos os agentes ativos ────────────
  if (SEM_CONTAB) {
    console.log(`\n[2.5/4] Contabilização pulada (--sem-contab)`);
  } else {
  console.log(`\n[2.5/4] Atualizando contabilização (${agentesAtivos.length} agentes)`);
  let contabAtualizados = 0;
  const totalContab = agentesAtivos.filter(a => a.razao_social).length;
  let contabIdx = 0;
  for (const { agente, razao_social } of agentesAtivos) {
    if (!razao_social) continue;
    contabIdx++;
    const { rows: contabMax } = await pool.query(
      "SELECT MAX(mes_referencia) AS m FROM ccee_contabilizacao WHERE agente=$1",
      [agente]
    );
    const maxMes = contabMax[0]?.m || "0000-00";
    if (maxMes >= ultimoMesDisp) { process.stdout.write("."); continue; }
    // Só busca a partir do ano do último registro — anos anteriores já estão completos
    const anoInicioContab = maxMes !== "0000-00" ? parseInt(maxMes.slice(0, 4), 10) : PRIMEIRO_ANO_CONTAB;
    const anosContab = Array.from({ length: new Date().getFullYear() - anoInicioContab + 1 }, (_, i) => anoInicioContab + i);
    process.stdout.write(`\n  [${contabIdx}/${totalContab}] ${agente} (${anosContab.join(",")})...`);
    try {
      const registros = await buscarContabilizacao(razao_social, { anos: anosContab });
      if (registros.length) { await salvarContabilizacao(agente, registros); contabAtualizados++; }
      process.stdout.write(` ${registros.length} registros`);
    } catch (e) {
      process.stdout.write(` ⚠ ${e.message.slice(0, 60)}`);
    }
    await delay(DELAY_MS);
  }
  console.log(`\n  ${contabAtualizados} agentes atualizados`);
  } // fim else SEM_CONTAB

  // ── Fase 2.6: Consumo mensal e contratos por perfil ─────────────────────────
  if (SEM_PERFIL) {
    console.log(`\n[2.6/4] Consumo/contratos por perfil pulado (--sem-perfil)`);
  } else {
  console.log(`\n[2.6/4] Atualizando consumo mensal e contratos por perfil`);
  let perfAtualizados = 0;
  const totalPerf = agentesAtivos.filter(a => a.razao_social).length;
  let perfIdx = 0;
  for (const { agente, razao_social } of agentesAtivos) {
    if (!razao_social) continue;
    perfIdx++;
    const { rows: mmCmp } = await pool.query(
      "SELECT MIN(mes_referencia) AS mn, MAX(mes_referencia) AS mx FROM ccee_consumo_mensal_perfil WHERE agente=$1", [agente]
    );
    const minMesPerf = mmCmp[0]?.mn || "0000-00";
    const maxMesPerf = mmCmp[0]?.mx || "0000-00";
    const primeiromes = `${PRIMEIRO_ANO_CONTAB}-01`;
    if (maxMesPerf >= ultimoMesDisp && minMesPerf <= primeiromes) { process.stdout.write("."); continue; }
    const anoAtual = new Date().getFullYear();
    const anosSet  = new Set();
    if (maxMesPerf === "0000-00") {
      for (let a = PRIMEIRO_ANO_CONTAB; a <= anoAtual; a++) anosSet.add(a);
    } else {
      const anoMax = parseInt(maxMesPerf.slice(0, 4), 10);
      for (let a = anoMax; a <= anoAtual; a++) anosSet.add(a);
      if (minMesPerf > primeiromes) {
        const anoMin = parseInt(minMesPerf.slice(0, 4), 10);
        for (let a = PRIMEIRO_ANO_CONTAB; a < anoMin; a++) anosSet.add(a);
      }
    }
    const anosPerf = [...anosSet].sort((a, b) => a - b);
    process.stdout.write(`\n  [${perfIdx}/${totalPerf}] ${agente} (${anosPerf.join(",")})...`);
    try {
      const [consumo, contratos] = await Promise.allSettled([
        buscarConsumoMensalPerfil(razao_social, { anos: anosPerf }),
        buscarContratosPerfil(razao_social, { anos: anosPerf }),
      ]);
      if (consumo.status  === "fulfilled" && consumo.value.length)  await salvarConsumoMensalPerfilDB(agente, consumo.value);
      if (contratos.status === "fulfilled" && contratos.value.length) await salvarContratosMensalPerfilDB(agente, contratos.value);
      process.stdout.write(` consumo:${consumo.value?.length ?? 0} contratos:${contratos.value?.length ?? 0}`);
      perfAtualizados++;
    } catch (e) {
      process.stdout.write(` ⚠ ${e.message.slice(0, 60)}`);
    }
    await delay(DELAY_MS);
  }
  console.log(`\n  ${perfAtualizados} agentes atualizados`);
  } // fim else SEM_PERFIL

  // ── Fase 2.7: Histórico Power BI (balanco, mcp, compra, consumo, geracao) ───
  if (!SEM_POWERBI) {
    // Usa TODOS os agentes do banco, não só os ativos no CKAN desta semana
    const { rows: todosAgentesBanco } = await pool.query(
      "SELECT agente FROM ccee_agentes WHERE COALESCE(classe,'') != 'Comercializador' ORDER BY agente"
    );
    const totalNoBanco = todosAgentesBanco.length;

    // Mês de referência = mês mais recente já salvo em ccee_dados
    // Se o banco estiver vazio, usa o mês anterior como estimativa
    const { rows: refRow } = await pool.query("SELECT MAX(mes) AS m FROM ccee_dados");
    let mesRef = refRow[0]?.m;
    if (!mesRef) {
      const prev = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
      mesRef = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
    }

    // Uma única query para saber quais agentes já têm o mês de referência → não há loop por agente
    const { rows: jaFeitosRows } = await pool.query(
      "SELECT DISTINCT agente FROM ccee_dados WHERE mes = $1 AND agente = ANY($2)",
      [mesRef, todosAgentesBanco.map(r => r.agente)]
    );
    const jaFeitosSet = new Set(jaFeitosRows.map(r => r.agente));
    const pendentes   = todosAgentesBanco.filter(r => !jaFeitosSet.has(r.agente));

    console.log(`\n[2.7/4] Power BI histórico`);
    console.log(`  Banco: ${totalNoBanco} agentes | mês ref: ${mesRef}`);
    console.log(`  ${jaFeitosSet.size} já atualizados | ${pendentes.length} a buscar`);

    let pbiAtualizados = 0;
    for (let i = 0; i < pendentes.length; i++) {
      const { agente } = pendentes[i];
      process.stdout.write(`\n  [${i + 1}/${pendentes.length}] ${agente}...`);
      try {
        const historico = await buscarHistoricoPowerBI(agente);
        // Limita a 2024+ — anos anteriores só sob demanda via frontend
        const filtrado = historico.filter(r => r.mes >= "2024-01");
        if (filtrado.length) {
          await salvarDadosPowerBI(agente, filtrado);
          process.stdout.write(` ${filtrado.length} meses`);
          pbiAtualizados++;
          // Atualiza referência caso encontre mês mais recente
          const maxMesFetch = filtrado[filtrado.length - 1]?.mes;
          if (maxMesFetch && maxMesFetch > mesRef) mesRef = maxMesFetch;
        } else {
          process.stdout.write(` sem dados`);
        }
      } catch (e) {
        process.stdout.write(` ⚠ ${e.message.slice(0, 60)}`);
      }
      await delay(DELAY_MS);
    }
    console.log(`\n  ${pbiAtualizados} agentes atualizados`);
  } else {
    console.log(`\n[2.7/4] Power BI pulado (--sem-powerbi)`);
  }

  // Modulação já calculada
  const { rows: modOk } = await pool.query(
    "SELECT agente, mes_referencia FROM ccee_modulacao WHERE agente = ANY($1) AND mes_referencia >= $2",
    [agentesAtivos.map(a => a.agente), PRIMEIRO_MES]
  );
  const modOkSet = new Set(modOk.map(r => `${r.agente}|${r.mes_referencia}`));

  // Agentes sem curva típica — precisam re-baixar histórico para calculá-la
  const { rows: semCurvaRows } = await pool.query(`
    SELECT DISTINCT m.agente FROM ccee_modulacao m
    WHERE m.agente = ANY($1) AND m.mes_referencia >= $2
      AND NOT EXISTS (SELECT 1 FROM ccee_curva_tipica ct WHERE ct.agente = m.agente)
  `, [agentesAtivos.map(a => a.agente), PRIMEIRO_MES]);
  const agentesSemCurva = new Set(semCurvaRows.map(r => r.agente));
  if (agentesSemCurva.size > 0)
    console.log(`\n  ${agentesSemCurva.size} agentes sem curva típica — histórico será re-baixado`);

  // Meses a processar: faltando modulação OU agente sem curva típica (re-download histórico)
  const mesesParaProcessar = MES_FIXO ? [MES_FIXO]
    : mesesDisponiveis.filter(mes =>
        agentesAtivos.some(a => !modOkSet.has(`${a.agente}|${mes}`)) ||
        agentesAtivos.some(a => agentesSemCurva.has(a.agente) && modOkSet.has(`${a.agente}|${mes}`))
      );

  if (!mesesParaProcessar.length) {
    console.log("\n✅ Tudo calculado. Nada a fazer.");
    await pool.end();
    return;
  }

  // ── Fase 3: Download + curva típica + modulação (por mês, em único passe) ──
  console.log(`\n[3/5] Processando consumo horário — ${mesesParaProcessar.length} meses`);

  for (const mes of mesesParaProcessar) {
    if (!urlConsumo[mes]) { console.log(`  ⚠ ${mes}: sem URL de consumo`); continue; }

    const espacoOk = await checarEspaco(mes);
    if (!espacoOk) {
      console.log(`\n  🔴 Banco atingiu ${(DB_ALERTA_PCT * 100).toFixed(0)}% de ${DB_MAX_MB} MB — inserções interrompidas.`);
      console.log(`  Ajuste DB_MAX_MB no .env ou libere espaço antes de continuar.`);
      break;
    }

    // Agentes a processar neste mês: faltando modulação OU sem curva típica (re-download)
    const agentesDoMes = agentesAtivos.filter(a =>
      !modOkSet.has(`${a.agente}|${mes}`) ||
      (agentesSemCurva.has(a.agente) && modOkSet.has(`${a.agente}|${mes}`))
    );
    if (!agentesDoMes.length) continue;

    console.log(`\n  📥 ${mes} (${agentesDoMes.length} agentes)`);
    const agentesSet = new Set(agentesDoMes.map(a => a.agente));

    const agregado       = {};
    const agregadoPerfil = {};

    // Ping periódico para evitar que o pool caia ocioso durante downloads longos
    const pingInterval = setInterval(() => pool.query("SELECT 1").catch(() => {}), 30000);
    await withRetry(() => {
      agentesDoMes.forEach(a => { agregado[a.agente] = {}; agregadoPerfil[a.agente] = {}; });
      return streamGzip(urlConsumo[mes], row => {
      const nome  = normalizarNome(row.NOME_EMPRESARIAL);
      const aKey  = nomeToAgenteKey.get(nome);
      if (!aKey || !agentesSet.has(aKey)) return;

      const horaDia = parseInt(row.PERIODO_COMERCIALIZACAO, 10);
      const dataStr = (row.DATA || "").trim();
      let diaMes = 1;
      if (/^\d{4}-\d{2}-\d{2}$/.test(dataStr))  diaMes = parseInt(dataStr.slice(8, 10), 10);
      else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dataStr)) diaMes = parseInt(dataStr.slice(0, 2), 10);
      const periodo    = (diaMes - 1) * 24 + horaDia + 1;
      const subBruto   = (row.SUBMERCADO || "").trim().toUpperCase();
      const submercado = SUB_MAP[subBruto] || subBruto;
      const consumo    = parseFloat((row.CONSUMO_CARGA_ACL || "0").replace(",", ".")) || 0;
      const sigla      = (row.SIGLA_PERFIL_AGENTE || "").trim().toUpperCase();
      if (!periodo || !submercado) return;

      const key       = `${periodo}|${submercado}`;
      const keyPerfil = `${sigla}|${periodo}|${submercado}`;
      if (!agregado[aKey][key]) agregado[aKey][key] = { mes_referencia: mes, periodo, submercado, consumo_mwh: 0 };
      agregado[aKey][key].consumo_mwh += consumo;
      if (!agregadoPerfil[aKey][keyPerfil]) agregadoPerfil[aKey][keyPerfil] = { mes_referencia: mes, sigla_perfil: sigla, periodo, submercado, consumo_mwh: 0 };
      agregadoPerfil[aKey][keyPerfil].consumo_mwh += consumo;
      });
    });
    clearInterval(pingInterval);

    for (const { agente } of agentesDoMes) {
      const regs      = Object.values(agregado[agente]);
      const regsPerfil = Object.values(agregadoPerfil[agente]);
      if (!regs.length) continue;

      console.log(`    ${agente}: ${regs.length} períodos`);
      await salvarConsumo(agente, regs);
      await salvarConsumoPerfil(agente, regsPerfil);

      // Atualiza curva típica com média ponderada incremental (não distorce histórico)
      await pool.query(`
        INSERT INTO ccee_curva_tipica (agente, submercado, hora, consumo_med, n_amostras, updated_at)
        SELECT $1, submercado, ((periodo-1)%24)+1 AS hora, AVG(consumo_mwh), COUNT(*), NOW()
        FROM ccee_consumo_horario WHERE agente=$1 AND mes_referencia=$2
        GROUP BY submercado, hora
        ON CONFLICT (agente, submercado, hora) DO UPDATE SET
          consumo_med = (
            ccee_curva_tipica.consumo_med * ccee_curva_tipica.n_amostras +
            EXCLUDED.consumo_med * EXCLUDED.n_amostras
          ) / (ccee_curva_tipica.n_amostras + EXCLUDED.n_amostras),
          n_amostras  = ccee_curva_tipica.n_amostras + EXCLUDED.n_amostras,
          updated_at  = NOW()
      `, [agente, mes]);

      await pool.query(`
        INSERT INTO ccee_curva_tipica_perfil (agente, sigla_perfil, hora, consumo_med, n_amostras, updated_at)
        SELECT $1, sigla_perfil, ((periodo-1)%24)+1 AS hora, AVG(consumo_mwh), COUNT(*), NOW()
        FROM ccee_consumo_horario_perfil WHERE agente=$1 AND mes_referencia=$2
        GROUP BY sigla_perfil, hora
        ON CONFLICT (agente, sigla_perfil, hora) DO UPDATE SET
          consumo_med = (
            ccee_curva_tipica_perfil.consumo_med * ccee_curva_tipica_perfil.n_amostras +
            EXCLUDED.consumo_med * EXCLUDED.n_amostras
          ) / (ccee_curva_tipica_perfil.n_amostras + EXCLUDED.n_amostras),
          n_amostras  = ccee_curva_tipica_perfil.n_amostras + EXCLUDED.n_amostras,
          updated_at  = NOW()
      `, [agente, mes]);

      // Calcula modulação se ainda não foi feita
      if (!modOkSet.has(`${agente}|${mes}`)) {
        await calcularModulacao(agente, [mes]);
        modOkSet.add(`${agente}|${mes}`);
      }

      // Bruto processado — apaga imediatamente (curva típica e modulação já salvos)
      await pool.query(
        "DELETE FROM ccee_consumo_horario WHERE agente=$1 AND mes_referencia=$2",
        [agente, mes]
      );
      await pool.query(
        "DELETE FROM ccee_consumo_horario_perfil WHERE agente=$1 AND mes_referencia=$2",
        [agente, mes]
      );

      // Libera referências para o GC
      delete agregado[agente];
      delete agregadoPerfil[agente];
    }
  }

  // ── Fase 4: Modulação de geração ──────────────────────────────────────────
  console.log(`\n[4/4] Calculando modulação de geração`);
  for (const { agente } of agentesAtivos) {
    const rUsinas = await pool.query(
      "SELECT DISTINCT sigla_parcela_usina FROM ccee_usinas WHERE agente=$1 AND sigla_parcela_usina IS NOT NULL",
      [agente]
    );
    if (!rUsinas.rows.length) continue;
    const siglasUsinas = rUsinas.rows.map(r => r.sigla_parcela_usina);

    const { rows: pend } = await pool.query(`
      SELECT mes FROM ccee_dados
      WHERE agente=$1 AND mes >= $2
        AND NOT EXISTS (SELECT 1 FROM ccee_modulacao_geracao m WHERE m.agente=$1 AND m.mes_referencia=ccee_dados.mes)
      ORDER BY mes
    `, [agente, PRIMEIRO_MES]);

    if (!pend.length) continue;
    console.log(`\n  ${agente} — ${pend.length} meses pendentes (${siglasUsinas.length} usinas)`);
    await calcularModulacaoGeracao(agente, pend.map(r => r.mes), siglasUsinas);
  }

  await pool.end();
  console.log("\n" + "═".repeat(60));
  console.log("✅ Pipeline concluído.");
  console.log("═".repeat(60) + "\n");
}

main().catch(async e => {
  console.error("Erro fatal:", e.message);
  await pool.end();
  process.exit(1);
});
