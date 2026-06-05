// api/ccee-abertos/consumo-mensal-perfil.js
// Consumo mensal por perfil de agente (CCEE dados abertos).
// Dataset: consumo_mensal_perfil_agente_YYYY
// VALOR_TRC  = consumo total do perfil por submercado [MWh] — soma por mes+perfil
// VALOR_TGGC = consumo da geração por submercado [MWh]    — soma por mes+perfil

const { descobrirIdsPorAno, fetchTodasPaginas, YEAR_DELAY_MS, delay, normalizarMes } = require("./utils");

// Âncora = recurso 2026 conhecido. descobrirIdsPorAno encontra 2024 e 2025 automaticamente.
const _IDS_FALLBACK = {
  2024: "3211839f-54b1-460e-92f3-e4c4b307f376",
  2025: "a26026a8-e270-441f-bb5e-4607ed39d068",
  2026: "85bc3ec0-6bde-4362-a555-ee127ea7ff48",
};
const getIds = () => descobrirIdsPorAno(_IDS_FALLBACK[2026], _IDS_FALLBACK);

function parseNum(v) {
  if (v == null || v === "") return 0;
  const n = Number(String(v).replace(",", "."));
  return isNaN(n) ? 0 : n;
}

/**
 * Busca consumo mensal por perfil de um agente.
 * Agrega (soma) VALOR_TRC e VALOR_TGGC por (mes_referencia, sigla_perfil)
 * pois o dataset tem uma linha por submercado.
 *
 * @param {string} nomeEmpresarial  razão social (será convertida para uppercase)
 * @param {{ anos?: number[] }} opts
 * @returns {Promise<Array<{ mes_referencia, sigla_perfil, consumo_mwh, consumo_geracao_mwh }>>}
 */
async function buscarConsumoMensalPerfil(nomeEmpresarial, { anos = null } = {}) {
  if (!nomeEmpresarial) throw new Error("nomeEmpresarial obrigatório");

  const nomeUpper   = nomeEmpresarial.trim().toUpperCase();
  const DATASET_IDS = await getIds();

  const entradas = anos?.length
    ? anos.filter(a => DATASET_IDS[a]).map(a => [Number(a), DATASET_IDS[a]])
    : Object.entries(DATASET_IDS).map(([a, id]) => [Number(a), id]);

  // Deduplica IDs caso todos os anos apontem para o mesmo recurso
  const idsUnicos = [...new Map(entradas.map(([, id]) => [id, id])).values()];

  // Agrega por (mes_referencia, sigla_perfil)
  const mapa = new Map(); // key = "mes|perfil"

  for (let i = 0; i < idsUnicos.length; i++) {
    const id = idsUnicos[i];
    try {
      const registros = await fetchTodasPaginas(id, { NOME_EMPRESARIAL: nomeUpper });
      for (const r of registros) {
        const mes   = normalizarMes(r.mes_referencia ?? r.MES_REFERENCIA);
        const sigla = (r.sigla_perfil_agente || r.SIGLA_PERFIL_AGENTE || "").trim().toUpperCase();
        if (!mes || !sigla) continue;

        const k = `${mes}|${sigla}`;
        if (!mapa.has(k)) mapa.set(k, { mes_referencia: mes, sigla_perfil: sigla, consumo_mwh: 0, consumo_geracao_mwh: 0 });
        const e = mapa.get(k);
        e.consumo_mwh          += parseNum(r.valor_trc  ?? r.VALOR_TRC);
        e.consumo_geracao_mwh  += parseNum(r.valor_tggc ?? r.VALOR_TGGC);
      }
    } catch (e) {
      console.warn(`  ✗ consumo-mensal-perfil (${id}): ${e.message}`);
    }
    if (i < idsUnicos.length - 1) await delay(YEAR_DELAY_MS);
  }

  return [...mapa.values()].sort((a, b) =>
    a.mes_referencia.localeCompare(b.mes_referencia) || a.sigla_perfil.localeCompare(b.sigla_perfil)
  );
}

module.exports = { buscarConsumoMensalPerfil };
