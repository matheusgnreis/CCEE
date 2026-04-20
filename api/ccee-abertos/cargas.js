// api/ccee-abertos/cargas.js
// Busca parcelas de carga por perfil de agente (SIGLA_PERFIL_AGENTE).

const {
  YEAR_DELAY_MS,
  delay,
  normalizarRegistro,
  fetchTodasPaginas,
} = require("./utils");

// IDs dos datasets CKAN por ano — atualize quando a CCEE publicar novos anos
const DATASET_IDS = {
  2024: "b854f7bc-94a3-423a-96b7-2d4756ec77d1",
  2025: "c88d04a6-fe42-413b-b7bf-86e390494fb0",
  2026: "cf753cb8-3a01-4ff0-abda-020be5908c41",
};

/**
 * Busca todas as parcelas de carga de um perfil de agente.
 *
 * @param {string}   siglaPerfilAgente - Sigla do perfil (ex: "SALITRE"). Case insensitive.
 * @param {object}   [opcoes]
 * @param {number[]} [opcoes.anos]     - Restringe a anos específicos (ex: [2025, 2026]).
 *                                       Por padrão busca todos os anos disponíveis.
 * @returns {Promise<object[]>} Registros normalizados ordenados por mes_referencia ASC
 *                              e depois por sigla_parcela_carga ASC.
 */
async function buscarCargas(siglaPerfilAgente, { anos = null } = {}) {
  siglaPerfilAgente = siglaPerfilAgente.trim().toUpperCase();

  const entradas = anos?.length
    ? anos.filter(a => DATASET_IDS[a]).map(a => [Number(a), DATASET_IDS[a]])
    : Object.entries(DATASET_IDS).map(([a, id]) => [Number(a), id]);

  if (!entradas.length)
    throw new Error(`Nenhum dos anos solicitados está disponível. Anos mapeados: ${Object.keys(DATASET_IDS).join(", ")}`);

  const filtros = { SIGLA_PERFIL_AGENTE: siglaPerfilAgente };

  console.log(`\n🔍 Cargas | sigla="${siglaPerfilAgente}" | ${entradas.length} anos`);

  const resultado = [];

  for (let i = 0; i < entradas.length; i++) {
    const [ano, datasetId] = entradas[i];
    console.log(`  📅 Buscando ${ano}...`);

    try {
      const registros = await fetchTodasPaginas(datasetId, filtros);
      console.log(`  ✓ ${registros.length} registros`);
      resultado.push(...registros.map(normalizarRegistro));
    } catch (err) {
      console.warn(`  ✗ Falha em ${ano}: ${err.message}`);
    }

    if (i < entradas.length - 1) await delay(YEAR_DELAY_MS);
  }

  resultado.sort((a, b) => {
    const porMes = (a.mes_referencia || "").localeCompare(b.mes_referencia || "");
    if (porMes !== 0) return porMes;
    return (a.sigla_parcela_carga || "").localeCompare(b.sigla_parcela_carga || "");
  });

  if (resultado.length > 0) {
    const parcelas = new Set(resultado.map(r => r.sigla_parcela_carga)).size;
    console.log(`\n✅ ${resultado.length} registros | ${parcelas} parcelas distintas | ${resultado[0].mes_referencia} → ${resultado.at(-1).mes_referencia}`);
  } else {
    console.log(`\n⚠️  Nenhuma parcela de carga encontrada para sigla="${siglaPerfilAgente}"`);
  }

  return resultado;
}

function anosDisponiveis() {
  return Object.keys(DATASET_IDS).map(Number);
}

module.exports = { buscarCargas, anosDisponiveis, normalizarRegistro };
