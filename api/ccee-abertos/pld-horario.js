// api/ccee-abertos/pld-horario.js
// Busca PLD horário da CCEE (dados abertos) via CKAN datastore_search.
// Campos relevantes: MES_REFERENCIA (AAAAMM), SUBMERCADO, PERIODO_COMERCIALIZACAO, PLD

const { fetchTodasPaginas, normalizarMes } = require("./utils");

// Dataset novo (pld_horario_YYYY) — campo PLD_HORA, mais atualizado
const DATASET_IDS_V2 = {
  2025: "2a180a6b-f092-43eb-9f82-a48798b803dc",
  2026: "3f279d6b-1069-42f7-9b0a-217b084729c4",
};

// Dataset antigo — campo PLD, fallback para meses não cobertos pelo v2
const DATASET_IDS_V1 = {
  2025: "7267ead9-6039-4ce1-93f3-3471ae33bd98",
  2026: "554cc6f2-9f1e-4163-8a04-573b4aafcbc1",
};

/**
 * Retorna lista de { periodo, submercado, pld_rs_mwh } para o mês pedido.
 * @param {string} mes - "YYYY-MM"
 * @param {string} [submercado] - filtrar submercado (opcional)
 * @returns {Promise<Array<{ mes_referencia, periodo, submercado, pld_rs_mwh }>>}
 */
const SUB_MAP = { SUDESTE: "SE", SUL: "S", NORDESTE: "NE", NORTE: "N" };

function normalizarRegistrosPld(registros, campoPreco) {
  return registros.map(r => {
    const subBruto = (r.SUBMERCADO || "").trim().toUpperCase();
    return {
      mes_referencia: normalizarMes(r.MES_REFERENCIA),
      periodo:        parseInt(r.PERIODO_COMERCIALIZACAO, 10),
      submercado:     SUB_MAP[subBruto] || subBruto,
      pld_rs_mwh:     parseFloat((r[campoPreco] || "0").toString().replace(",", ".")) || 0,
    };
  }).filter(r => r.periodo && r.submercado);
}

async function buscarPldHorario(mes, submercado = null) {
  const ano          = parseInt(mes.slice(0, 4), 10);
  const mesFormatado = mes.replace("-", "");
  const filtros      = { MES_REFERENCIA: mesFormatado };
  if (submercado) filtros.SUBMERCADO = submercado.toUpperCase();

  console.log(`\n📥 PLD horário | mês=${mes}${submercado ? ` | sub=${submercado}` : ""}`);

  // 1. Tenta dataset novo (PLD_HORA — mais atualizado)
  const idV2 = DATASET_IDS_V2[ano];
  if (idV2) {
    const registros = await fetchTodasPaginas(idV2, filtros);
    if (registros.length > 0) {
      console.log(`  ✅ ${registros.length} registros de PLD (v2)`);
      return normalizarRegistrosPld(registros, "PLD_HORA")
        .sort((a, b) => a.periodo - b.periodo || a.submercado.localeCompare(b.submercado));
    }
    console.log(`  ⚠ Nenhum dado no dataset v2 para ${mes} — tentando v1...`);
  }

  // 2. Fallback para dataset antigo (PLD)
  const idV1 = DATASET_IDS_V1[ano];
  if (!idV1) {
    const disponiveis = Object.keys(DATASET_IDS_V1).join(", ");
    throw new Error(`PLD horário não disponível para ${ano}. Anos com dados: ${disponiveis}`);
  }

  const registros = await fetchTodasPaginas(idV1, filtros);
  console.log(`  ✅ ${registros.length} registros de PLD (v1)`);
  return normalizarRegistrosPld(registros, "PLD")
    .sort((a, b) => a.periodo - b.periodo || a.submercado.localeCompare(b.submercado));
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
  return [...new Set([
    ...Object.keys(DATASET_IDS_V2),
    ...Object.keys(DATASET_IDS_V1),
  ])].map(Number).sort();
}

module.exports = { buscarPldHorario, buscarPldHorarioMapa, anosDisponiveis };
