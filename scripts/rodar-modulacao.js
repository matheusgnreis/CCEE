// scripts/rodar-modulacao.js
// Roda tudo para uma lista de agentes em sequência:
//   1. Histórico (cargas + usinas) via /inteligencia/:agente
//   2. Modulação de carga e geração via /admin/modulacao/:agente
//   3. Contabilização por perfil (MCP, encargos, efeitos) via DB direto
// Uso: node scripts/rodar-modulacao.js

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { Pool } = require("pg");
const { buscarContabilizacao } = require("../api/ccee-abertos/contabilizacao");

const API     = process.env.API_URL || "http://localhost:3001";
const POLL_MS = 8000;
const MAX_ESPERA_INICIO_S = 120;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const AGENTES = [
  "AVIVAR",
  "LPA",
  "SUPERMERCADOS ABC",
  "SUPER BH 001",
  "MARTMINAS",
  "UTE WD",
];

// ─── helpers ──────────────────────────────────────────────────────────────────

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// ─── 1. Histórico ─────────────────────────────────────────────────────────────

async function buscarHistorico(agente) {
  const enc = encodeURIComponent(agente);
  try {
    await fetch(`${API}/inteligencia/${enc}`); // dispara cargas+usinas em background
    console.log(`  Histórico: trigger enviado`);
  } catch (e) {
    console.warn(`  Histórico: erro ao disparar — ${e.message}`);
  }
}

// ─── 2. Modulação ─────────────────────────────────────────────────────────────

// Retorna quais meses já têm consumo e geração no banco
async function checarMesesExistentes(agente) {
  const [rCarga, rGer, rMeses] = await Promise.all([
    pool.query(
      "SELECT DISTINCT mes_referencia FROM ccee_modulacao WHERE agente = $1",
      [agente]
    ),
    pool.query(
      "SELECT DISTINCT mes_referencia FROM ccee_modulacao_geracao WHERE agente = $1",
      [agente]
    ),
    pool.query(
      "SELECT mes FROM ccee_dados WHERE agente = $1 ORDER BY mes DESC",
      [agente]
    ),
  ]);
  const cargaOk  = new Set(rCarga.rows.map(r => r.mes_referencia));
  const geracaoOk = new Set(rGer.rows.map(r => r.mes_referencia));
  const todos    = rMeses.rows.map(r => r.mes);
  const pendCarga = todos.filter(m => !cargaOk.has(m));
  const pendGer   = todos.filter(m => !geracaoOk.has(m));
  return { todos, pendCarga, pendGer, cargaOk, geracaoOk };
}

async function dispararModulacao(agente) {
  const enc  = encodeURIComponent(agente);
  // Dispara carga e geração — o backend já pula meses com dados corretos
  const json = await fetchJson(`${API}/admin/modulacao/${enc}?carga=true&geracao=true`, { method: "POST" });
  console.log(`  Trigger: ${JSON.stringify(json.status)}`);
}

async function aguardarModulacao(agente) {
  let tentativas = 0;
  let jobVisto   = false;

  while (true) {
    tentativas++;
    await new Promise(r => setTimeout(r, POLL_MS));

    let status;
    try { status = await fetchJson(`${API}/modulacao/status`); }
    catch (e) { console.log(`  [poll] ${e.message}`); continue; }

    const info        = status.agentes?.find(a => a.agente === agente);
    const emAndamento = status.em_andamento?.includes(agente);
    const calculando  = info?.carga?.calculando || info?.geracao?.calculando || emAndamento;

    if (calculando) jobVisto = true;

    if (info) {
      const { carga, geracao } = info;
      console.log(`  [poll #${tentativas}] carga: ${carga.calculados}/${info.total_meses} (calc=${carga.calculando}) | geração: ${geracao.calculados}/${info.total_meses} (calc=${geracao.calculando})`);
    } else {
      console.log(`  [poll #${tentativas}] agente não encontrado no status...`);
    }

    if (jobVisto && !calculando) return info || null;
    if (!jobVisto && tentativas * POLL_MS / 1000 >= MAX_ESPERA_INICIO_S) {
      console.log(`  [poll] Não apareceu como calculando após ${MAX_ESPERA_INICIO_S}s — assumindo concluído.`);
      return info || null;
    }
  }
}

// ─── 3. Contabilização ────────────────────────────────────────────────────────

async function salvarContabilizacao(agente, registros) {
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
      lote.map(r => r.cod_perf_agente != null ? Number(r.cod_perf_agente) : null),
      lote.map(r => r.valor_tm_mcp),            lote.map(r => r.compensacao_mre),
      lote.map(r => r.valor_encargo),           lote.map(r => r.valor_ajuste_exposicao),
      lote.map(r => r.valor_ajuste_alivio_ret), lote.map(r => r.efeito_contrat_disp),
      lote.map(r => r.efeito_contrat_cota_gf),  lote.map(r => r.efeito_contrat_nuclear),
      lote.map(r => r.ajuste_recontab),         lote.map(r => r.ajuste_mcsd_ex),
      lote.map(r => r.resultado_financeiro_er), lote.map(r => r.efeito_ccearq),
      lote.map(r => r.efeito_contrat_itaipu),   lote.map(r => r.efeito_repasse_risco_hidro),
      lote.map(r => r.efeito_desloc_pld_cmo),   lote.map(r => r.resultado_final),
    ]);
  }
}

async function processarContabilizacao(agente) {
  const meta = await pool.query("SELECT razao_social FROM ccee_agentes WHERE agente = $1", [agente]);
  const razao = meta.rows[0]?.razao_social;
  if (!razao) { console.log(`  Contabilização: sem razão social, pulando`); return; }

  const registros = await buscarContabilizacao(razao);
  if (!registros.length) { console.log(`  Contabilização: nenhum registro encontrado`); return; }

  await salvarContabilizacao(agente, registros);
  const perfis = new Set(registros.map(r => r.sigla_perfil_agente)).size;
  console.log(`  Contabilização: ${registros.length} registros | ${perfis} perfis`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🚀 Processando ${AGENTES.length} agentes (histórico + modulação + contabilização)\n`);
  console.log(`API: ${API}\n`);

  for (const agente of AGENTES) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`▶  ${agente}`);
    console.log(`${"─".repeat(60)}`);

    // 1. Histórico (cargas + usinas)
    await buscarHistorico(agente);

    // 2. Checa situação atual antes de disparar
    let pend;
    try {
      pend = await checarMesesExistentes(agente);
      console.log(`  Situação: ${pend.todos.length} meses total | carga pendente: ${pend.pendCarga.length} | geração pendente: ${pend.pendGer.length}`);
      if (pend.pendCarga.length) console.log(`    Carga faltando: ${pend.pendCarga.slice(0,6).join(", ")}${pend.pendCarga.length > 6 ? "…" : ""}`);
      if (pend.pendGer.length)   console.log(`    Geração faltando: ${pend.pendGer.slice(0,6).join(", ")}${pend.pendGer.length > 6 ? "…" : ""}`);
    } catch(e) {
      console.warn(`  Checa meses: ${e.message}`);
      pend = { pendCarga: [1], pendGer: [1] }; // força disparo se não conseguiu checar
    }

    if (!pend.pendCarga.length && !pend.pendGer.length) {
      console.log(`  ✔ Todos os meses já calculados, pulando modulação.`);
    } else {
      // 3. Modulação (carga + geração)
      try {
        await dispararModulacao(agente);
        await new Promise(r => setTimeout(r, 3000));
        const resultado = await aguardarModulacao(agente);
        if (resultado) {
          const { carga, geracao, total_meses } = resultado;
          console.log(`  Modulação: carga ${carga.calculados}/${total_meses} | geração ${geracao.calculados}/${total_meses}`);
        }
      } catch (e) {
        console.warn(`  Modulação: ${e.message}`);
      }
    }

    // 4. Contabilização
    try {
      await processarContabilizacao(agente);
    } catch (e) {
      console.warn(`  Contabilização: ${e.message}`);
    }

    console.log(`  ✅ ${agente} concluído`);
  }

  await pool.end();
  console.log(`\n${"═".repeat(60)}`);
  console.log(`✅ Todos os agentes processados.`);
  console.log(`${"═".repeat(60)}\n`);
}

main().catch(async e => {
  console.error("Erro fatal:", e.message);
  await pool.end();
  process.exit(1);
});
