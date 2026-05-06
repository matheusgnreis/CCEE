// scripts/rodar-modulacao-batch.js
// Versão otimizada: baixa cada CSV mensal UMA VEZ e extrai dados de todos os agentes
// simultaneamente, em vez de um download por agente por mês.
//
// Fluxo:
//   1. Carrega todos os agentes da lista com razão social e usinas do banco
//   2. Para cada mês com dados pendentes → 1 download de consumo + 1 de geração
//   3. No streaming, filtra todos os agentes de uma vez
//   4. Salva no banco por agente
//   5. Dispara modulação via API para cada agente e aguarda
//   6. Salva contabilização por perfil
//
// Uso: node scripts/rodar-modulacao-batch.js

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const fetch  = require("node-fetch");
const zlib   = require("zlib");
const { Pool } = require("pg");
const { buscarContabilizacao } = require("../api/ccee-abertos/contabilizacao");
const { listarRecursos: listarConsumo }  = require("../api/ccee-abertos/consumo-horario");
const { listarRecursos: listarGeracao }  = require("../api/ccee-abertos/geracao-horaria");

const API            = process.env.API_URL || "http://localhost:3001";
const POLL_MS        = 8000;
const MAX_ESPERA_S   = 120;
const PRIMEIRO_MES   = "2025-01";
const USER_AGENT     = "Mozilla/5.0 (compatible; CCEEMonitor/1.0)";
const TIMEOUT_DL     = 600000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const AGENTES = [
  "ACOFORJA", "BR METALS", "CEMIG GERA CAMARGOS CONV", "CEMIG H COMERCIALIZACAO",
  "JSPS", "LPA", "MCCAIN", "MINASLIGAS", "PARTAGEMSB", "PNSN",
  "PSCG", "PSM", "PSRG", "PSSG", "SHOP 3 AMERICAS", "SHOP BOULEVARD CAMPOS I",
  "SHOP PATIO ARAPIRACA", "SHOPPING POCOS DE CALDAS", "SHOP SANTANA PARQUE",
  "SUPER BH 001", "SUPERMERCADOS BH ATAC1", "UTE WD", "VIBRA",
];

// ─── Utilitários ──────────────────────────────────────────────────────────────

const SUB_MAP = {
  SUDESTE: "SE", "SUDESTE/CENTRO-OESTE": "SE", SECO: "SE",
  SUL: "S", NORDESTE: "NE", NORTE: "N",
  SE: "SE", S: "S", NE: "NE", N: "N",
};

function stripAccents(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function diasNoMes(ano, mes) { return new Date(ano, mes, 0).getDate(); }

async function streamGzip(url, onLinha) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_DL);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    return await new Promise((resolve, reject) => {
      let headers = null, sep = ";", leftover = "", total = 0;

      const processChunk = (chunk) => {
        const text   = leftover + chunk.toString("utf8");
        const partes = text.split("\n");
        leftover = partes.pop();
        for (const linha of partes) {
          const l = linha.replace(/\r$/, "").trim();
          if (!l) continue;
          if (!headers) {
            sep = l.includes(";") ? ";" : ",";
            headers = l.split(sep).map(h => h.replace(/^"|"$/g, "").trim());
            continue;
          }
          total++;
          const vals = l.split(sep).map(v => v.replace(/^"|"$/g, "").trim());
          const row  = {};
          headers.forEach((h, i) => { row[h] = vals[i] ?? null; });
          onLinha(row);
        }
      };

      const body = res.body;
      body.once("data", (first) => {
        const isGzip = first[0] === 0x1F && first[1] === 0x8B;
        if (isGzip) {
          const gz = zlib.createGunzip();
          gz.on("error", reject);
          gz.on("data", processChunk);
          gz.on("end", () => { if (leftover.trim()) processChunk(leftover + "\n"); console.log(`  ${total.toLocaleString()} linhas`); resolve(); });
          gz.write(first);
          body.pipe(gz);
        } else {
          processChunk(first);
          body.on("data", processChunk);
          body.on("end", () => { if (leftover.trim()) processChunk(leftover + "\n"); console.log(`  ${total.toLocaleString()} linhas`); resolve(); });
        }
        body.on("error", reject);
      });
    });
  } finally { clearTimeout(timer); }
}

// ─── Carga de metadados do banco ──────────────────────────────────────────────

async function carregarMeta() {
  // Razão social por agente (para filtrar consumo por NOME_EMPRESARIAL)
  const rMeta = await pool.query(
    "SELECT agente, razao_social FROM ccee_agentes WHERE agente = ANY($1)",
    [AGENTES]
  );
  const razaoMap = {};
  rMeta.rows.forEach(r => { razaoMap[r.agente] = r.razao_social; });

  // Usinas por agente (para filtrar geração por SIGLA_USINA)
  const rUsinas = await pool.query(
    "SELECT agente, sigla_parcela_usina FROM ccee_usinas WHERE agente = ANY($1) AND sigla_parcela_usina IS NOT NULL",
    [AGENTES]
  );
  const usinasMap = {}; // agente → Set<sigla>
  rUsinas.rows.forEach(r => {
    if (!usinasMap[r.agente]) usinasMap[r.agente] = new Set();
    usinasMap[r.agente].add(r.sigla_parcela_usina.trim().toUpperCase());
  });

  // Índice inverso: NOME_EMPRESARIAL (sem acento, upper) → [agente]
  const nomeToAgentes = {};
  for (const [agente, razao] of Object.entries(razaoMap)) {
    if (!razao) continue;
    const key = stripAccents(razao.trim().toUpperCase());
    if (!nomeToAgentes[key]) nomeToAgentes[key] = [];
    nomeToAgentes[key].push(agente);
  }

  // Índice inverso: SIGLA_USINA → agente
  const siglasToAgente = {};
  for (const [agente, siglas] of Object.entries(usinasMap)) {
    siglas.forEach(s => { siglasToAgente[s] = agente; });
  }

  return { razaoMap, usinasMap, nomeToAgentes, siglasToAgente };
}

// ─── Meses pendentes ──────────────────────────────────────────────────────────

async function mesesPendentesPorAgente() {
  const [rModCarga, rModGer, rDados] = await Promise.all([
    pool.query("SELECT agente, mes_referencia FROM ccee_modulacao       WHERE agente = ANY($1)", [AGENTES]),
    pool.query("SELECT agente, mes_referencia FROM ccee_modulacao_geracao WHERE agente = ANY($1)", [AGENTES]),
    pool.query("SELECT agente, mes             FROM ccee_dados          WHERE agente = ANY($1) AND mes >= $2 ORDER BY mes", [AGENTES, PRIMEIRO_MES]),
  ]);

  const cargaOk = new Set(rModCarga.rows.map(r => `${r.agente}|${r.mes_referencia}`));
  const gerOk   = new Set(rModGer.rows.map(r => `${r.agente}|${r.mes_referencia}`));

  // pendCarga[mes] = [agente, ...], pendGer[mes] = [agente, ...]
  const pendCarga = {}, pendGer = {};
  for (const { agente, mes } of rDados.rows) {
    if (!cargaOk.has(`${agente}|${mes}`)) {
      (pendCarga[mes] = pendCarga[mes] || []).push(agente);
    }
    // geração só para agentes com usinas
    if (!gerOk.has(`${agente}|${mes}`)) {
      (pendGer[mes] = pendGer[mes] || []).push(agente);
    }
  }

  const mesesCarga = [...new Set(Object.keys(pendCarga))].sort();
  const mesesGer   = [...new Set(Object.keys(pendGer))].sort();
  return { pendCarga, pendGer, mesesCarga, mesesGer };
}

// ─── Salvar consumo ───────────────────────────────────────────────────────────

async function salvarConsumo(dadosPorAgente) {
  for (const [agente, registros] of Object.entries(dadosPorAgente)) {
    if (!registros.length) continue;
    const BATCH = 500;
    for (let i = 0; i < registros.length; i += BATCH) {
      const lote = registros.slice(i, i + BATCH);
      await pool.query(`
        INSERT INTO ccee_consumo_horario (agente, mes_referencia, periodo, submercado, consumo_mwh)
        SELECT * FROM UNNEST($1::text[], $2::char(7)[], $3::integer[], $4::text[], $5::numeric[])
        ON CONFLICT (agente, mes_referencia, periodo, submercado) DO NOTHING
      `, [
        lote.map(() => agente),
        lote.map(r => r.mes_referencia),
        lote.map(r => r.periodo),
        lote.map(r => r.submercado),
        lote.map(r => r.consumo_mwh),
      ]);
    }
    console.log(`    ${agente}: ${registros.length} períodos de consumo salvos`);
  }
}

async function salvarConsumoPerfil(dadosPorAgente) {
  for (const [agente, registros] of Object.entries(dadosPorAgente)) {
    if (!registros.length) continue;
    const BATCH = 500;
    for (let i = 0; i < registros.length; i += BATCH) {
      const lote = registros.slice(i, i + BATCH);
      await pool.query(`
        INSERT INTO ccee_consumo_horario_perfil (agente, mes_referencia, sigla_perfil, periodo, submercado, consumo_mwh)
        SELECT * FROM UNNEST($1::text[], $2::char(7)[], $3::text[], $4::integer[], $5::text[], $6::numeric[])
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
    console.log(`    ${agente}: ${registros.length} períodos por perfil salvos`);
  }
}

// ─── Download de consumo: 1 arquivo → todos os agentes ───────────────────────

async function baixarConsumoMes(mes, agentes, nomeToAgentes, urlCsv) {
  console.log(`\n  📥 Consumo ${mes} → ${agentes.length} agentes | ${urlCsv}`);

  const [ano, mesNum] = mes.split("-").map(Number);
  const agregado       = {}; // agente → { "periodo|sub": { ... } }
  const agregadoPerfil = {}; // agente → { "sigla|periodo|sub": { ... } }
  agentes.forEach(a => { agregado[a] = {}; agregadoPerfil[a] = {}; });

  const agentesSet = new Set(agentes);

  await streamGzip(urlCsv, (row) => {
    const nome = stripAccents((row.NOME_EMPRESARIAL || "").trim().toUpperCase());
    const alvos = nomeToAgentes[nome];
    if (!alvos) return;

    // Filtra só os agentes pendentes neste mês (pode haver outros no índice)
    const alvosAtivos = alvos.filter(a => agentesSet.has(a));
    if (!alvosAtivos.length) return;

    const horaDia = parseInt(row.PERIODO_COMERCIALIZACAO, 10);
    const dataStr = (row.DATA || "").trim();
    let diaMes = 1;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) diaMes = parseInt(dataStr.slice(8, 10), 10);
    else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dataStr)) diaMes = parseInt(dataStr.slice(0, 2), 10);
    const periodo = (diaMes - 1) * 24 + horaDia + 1;

    const subBruto   = (row.SUBMERCADO || "").trim().toUpperCase();
    const submercado = SUB_MAP[subBruto] || subBruto;
    const consumo    = parseFloat((row.CONSUMO_CARGA_ACL || "0").replace(",", ".")) || 0;
    const sigla      = (row.SIGLA_PERFIL_AGENTE || "").trim().toUpperCase();
    if (!periodo || !submercado) return;

    const key       = `${periodo}|${submercado}`;
    const keyPerfil = `${sigla}|${periodo}|${submercado}`;
    for (const agente of alvosAtivos) {
      if (!agregado[agente][key]) {
        agregado[agente][key] = { mes_referencia: mes, periodo, submercado, consumo_mwh: 0 };
      }
      agregado[agente][key].consumo_mwh += consumo;

      if (!agregadoPerfil[agente][keyPerfil]) {
        agregadoPerfil[agente][keyPerfil] = { mes_referencia: mes, sigla_perfil: sigla, periodo, submercado, consumo_mwh: 0 };
      }
      agregadoPerfil[agente][keyPerfil].consumo_mwh += consumo;
    }
  });

  // Converte para arrays por agente
  const resultado       = {};
  const resultadoPerfil = {};
  for (const agente of agentes) {
    resultado[agente]       = Object.values(agregado[agente]).sort((a, b) => a.periodo - b.periodo);
    resultadoPerfil[agente] = Object.values(agregadoPerfil[agente]).sort((a, b) =>
      a.sigla_perfil.localeCompare(b.sigla_perfil) || a.periodo - b.periodo
    );
    console.log(`    ${agente}: ${resultado[agente].length} períodos | ${resultadoPerfil[agente].length} por perfil`);
  }
  return { resultado, resultadoPerfil };
}

// ─── Salvar geração ───────────────────────────────────────────────────────────

async function salvarGeracao(dadosPorAgente) {
  for (const [agente, registros] of Object.entries(dadosPorAgente)) {
    if (!registros.length) continue;
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
    console.log(`    ${agente}: ${registros.length} registros de geração salvos`);
  }
}

// ─── Download de geração: 1 arquivo → todos os agentes ───────────────────────

async function baixarGeracaoMes(mes, agentes, siglasToAgente, usinasMap, urlCsv) {
  // Filtra só agentes com usinas no banco
  const agentesComUsina = agentes.filter(a => usinasMap[a]?.size > 0);
  if (!agentesComUsina.length) return {};

  const siglasRelevantes = new Set(
    agentesComUsina.flatMap(a => [...(usinasMap[a] || [])])
  );
  console.log(`\n  📥 Geração ${mes} → ${agentesComUsina.length} agentes | ${siglasRelevantes.size} usinas`);

  const agregado = {};
  agentesComUsina.forEach(a => { agregado[a] = {}; });

  await streamGzip(urlCsv, (row) => {
    const sigla = (row.SIGLA_USINA || "").trim().toUpperCase();
    if (!siglasRelevantes.has(sigla)) return;

    const agente = siglasToAgente[sigla];
    if (!agente || !agregado[agente]) return;

    const periodo    = parseInt(row.PERIODO_COMERCIALIZACAO, 10);
    const subBruto   = (row.SUBMERCADO || "").trim().toUpperCase();
    const submercado = SUB_MAP[subBruto] || subBruto;
    const geracao    = parseFloat((row.GERACAO_CENTRO_GRAVIDADE || "0").replace(",", ".")) || 0;
    if (!periodo || !submercado) return;

    const key = `${sigla}|${periodo}|${submercado}`;
    if (!agregado[agente][key]) {
      agregado[agente][key] = { mes_referencia: mes, sigla_usina: sigla, periodo, submercado, geracao_mwmed: 0 };
    }
    agregado[agente][key].geracao_mwmed += geracao;
  });

  const resultado = {};
  for (const agente of agentesComUsina) {
    resultado[agente] = Object.values(agregado[agente]).sort((a, b) => a.periodo - b.periodo || a.sigla_usina.localeCompare(b.sigla_usina));
    console.log(`    ${agente}: ${resultado[agente].length} registros encontrados`);
  }
  return resultado;
}

// ─── Modulação via API ────────────────────────────────────────────────────────

async function fetchJson(url, opts = {}) {
  const res  = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function dispararEAguardar(agente) {
  const enc = encodeURIComponent(agente);
  try {
    const j = await fetchJson(`${API}/admin/modulacao/${enc}?carga=true&geracao=true`, { method: "POST" });
    console.log(`  Trigger modulação: ${JSON.stringify(j.status)}`);
  } catch (e) { console.warn(`  Trigger falhou: ${e.message}`); return; }

  await new Promise(r => setTimeout(r, 3000));

  let tentativas = 0, jobVisto = false;
  while (true) {
    tentativas++;
    await new Promise(r => setTimeout(r, POLL_MS));
    let status;
    try { status = await fetchJson(`${API}/modulacao/status`); }
    catch { continue; }

    const info      = status.agentes?.find(a => a.agente === agente);
    const calculando = info?.carga?.calculando || info?.geracao?.calculando || status.em_andamento?.includes(agente);
    if (calculando) jobVisto = true;

    if (info) {
      const { carga, geracao } = info;
      console.log(`  [poll #${tentativas}] carga: ${carga.calculados}/${info.total_meses} | geração: ${geracao.calculados}/${info.total_meses}`);
    }
    if (jobVisto && !calculando) break;
    if (!jobVisto && tentativas * POLL_MS / 1000 >= MAX_ESPERA_S) { console.log(`  Assumindo concluído.`); break; }
  }
}

// ─── Contabilização ───────────────────────────────────────────────────────────

async function processarContabilizacao(agente) {
  const meta  = await pool.query("SELECT razao_social FROM ccee_agentes WHERE agente = $1", [agente]);
  const razao = meta.rows[0]?.razao_social;
  if (!razao) return;

  const registros = await buscarContabilizacao(razao);
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
        valor_tm_mcp = EXCLUDED.valor_tm_mcp, compensacao_mre = EXCLUDED.compensacao_mre,
        valor_encargo = EXCLUDED.valor_encargo, resultado_final = EXCLUDED.resultado_final,
        created_at = NOW()
    `, [
      lote.map(() => agente), lote.map(r => r.mes_referencia),
      lote.map(r => r.sigla_perfil_agente || null), lote.map(r => r.nome_empresarial || null),
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
  const perfis = new Set(registros.map(r => r.sigla_perfil_agente)).size;
  console.log(`  Contabilização: ${registros.length} registros | ${perfis} perfis`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🚀 BATCH — ${AGENTES.length} agentes | 1 download por mês\n`);
  console.log(`API: ${API}\n`);

  const meta = await carregarMeta();
  const { pendCarga, pendGer, mesesCarga, mesesGer } = await mesesPendentesPorAgente();

  const todosMeses = [...new Set([...mesesCarga, ...mesesGer])].sort();
  if (!todosMeses.length) { console.log("✅ Nenhum mês pendente."); await pool.end(); return; }

  console.log(`Meses a processar: ${todosMeses.join(", ")}\n`);

  // Carrega índice de recursos CKAN uma vez
  const [recursosCon, recursosGer] = await Promise.all([
    listarConsumo(),
    listarGeracao(),
  ]);
  const urlConsumo  = Object.fromEntries(recursosCon.map(r => [r.mes, r.url]));
  const urlGeracao  = Object.fromEntries(recursosGer.map(r => [r.mes, r.url]));

  // ── Fase 1: Downloads por mês ──────────────────────────────────────────────
  for (const mes of todosMeses) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`📅 Mês: ${mes}`);
    console.log(`${"═".repeat(60)}`);

    // Consumo
    const agentesConsumo = pendCarga[mes] || [];
    if (agentesConsumo.length && urlConsumo[mes]) {
      const { resultado: dados, resultadoPerfil: dadosPerfil } = await baixarConsumoMes(mes, agentesConsumo, meta.nomeToAgentes, urlConsumo[mes]);
      await salvarConsumo(dados);
      await salvarConsumoPerfil(dadosPerfil);
    } else if (agentesConsumo.length) {
      console.log(`  ⚠ Mês ${mes} não disponível no CKAN para consumo`);
    }

    // Geração
    const agentesGeracao = (pendGer[mes] || []).filter(a => meta.usinasMap[a]?.size > 0);
    if (agentesGeracao.length && urlGeracao[mes]) {
      const dados = await baixarGeracaoMes(mes, agentesGeracao, meta.siglasToAgente, meta.usinasMap, urlGeracao[mes]);
      await salvarGeracao(dados);
    } else if (agentesGeracao.length) {
      console.log(`  ⚠ Mês ${mes} não disponível no CKAN para geração`);
    }
  }

  // ── Fase 2: Modulação + Contabilização por agente ─────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log(`⚡ Calculando modulação e contabilização por agente`);
  console.log(`${"═".repeat(60)}`);

  for (const agente of AGENTES) {
    console.log(`\n▶ ${agente}`);
    await dispararEAguardar(agente);
    try { await processarContabilizacao(agente); }
    catch (e) { console.warn(`  Contabilização: ${e.message}`); }
    console.log(`  ✅ ${agente} concluído`);
  }

  await pool.end();
  console.log(`\n${"═".repeat(60)}`);
  console.log(`✅ Batch concluído.`);
  console.log(`${"═".repeat(60)}\n`);
}

main().catch(async e => {
  console.error("Erro fatal:", e.message);
  await pool.end();
  process.exit(1);
});
