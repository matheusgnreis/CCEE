// api/ccee-abertos/pld-horario.js
// Busca PLD horário da CCEE (dados abertos) via CKAN datastore_search.
// Campos relevantes: MES_REFERENCIA (AAAAMM), SUBMERCADO, PERIODO_COMERCIALIZACAO, PLD

const { fetchTodasPaginas, normalizarMes } = require("./utils");

// resource_id por ano — adicionar anos futuros aqui
const DATASET_IDS = {
  2025: "7267ead9-6039-4ce1-93f3-3471ae33bd98",
  2026: "554cc6f2-9f1e-4163-8a04-573b4aafcbc1",
};

/**
 * Retorna lista de { periodo, submercado, pld_rs_mwh } para o mês pedido.
 * @param {string} mes - "YYYY-MM"
 * @param {string} [submercado] - filtrar submercado (opcional)
 * @returns {Promise<Array<{ mes_referencia, periodo, submercado, pld_rs_mwh }>>}
 */
async function buscarPldHorario(mes, submercado = null) {
  const ano = parseInt(mes.slice(0, 4), 10);
  const datasetId = DATASET_IDS[ano];

  if (!datasetId) {
    const disponiveis = Object.keys(DATASET_IDS).join(", ");
    throw new Error(`PLD horário não disponível para ${ano}. Anos disponíveis: ${disponiveis}`);
  }

  // MES_REFERENCIA no CKAN está em formato AAAAMM (ex: 202503)
  const mesFormatado = mes.replace("-", "");

  const filtros = { MES_REFERENCIA: mesFormatado };
  if (submercado) filtros.SUBMERCADO = submercado.toUpperCase();

  console.log(`\n📥 PLD horário | mês=${mes}${submercado ? ` | sub=${submercado}` : ""}`);

  const registros = await fetchTodasPaginas(datasetId, filtros);
  console.log(`  ✅ ${registros.length} registros de PLD`);

  // Normaliza submercado para código curto — igual ao consumo horário
  const SUB_MAP = { SUDESTE: "SE", SUL: "S", NORDESTE: "NE", NORTE: "N" };

  return registros.map(r => {
    const subBruto = (r.SUBMERCADO || "").trim().toUpperCase();
    return {
      mes_referencia: normalizarMes(r.MES_REFERENCIA),
      periodo:        parseInt(r.PERIODO_COMERCIALIZACAO, 10),
      submercado:     SUB_MAP[subBruto] || subBruto,
      pld_rs_mwh:     parseFloat((r.PLD || "0").toString().replace(",", ".")) || 0,
    };
  }).filter(r => r.periodo && r.submercado);
}

/**
 * Retorna mapa { "periodo|submercado" → pld_rs_mwh } para lookup rápido.
 */
async function buscarPldHorarioMapa(mes, submercado = null) {
  const lista = await buscarPldHorario(mes, submercado);
  const mapa  = {};
  for (const r of lista) {
    mapa[`${r.periodo}|${r.submercado}`] = r.pld_rs_mwh;
  }
  return mapa;
}

function anosDisponiveis() {
  return Object.keys(DATASET_IDS).map(Number);
}

module.exports = { buscarPldHorario, buscarPldHorarioMapa, anosDisponiveis };
