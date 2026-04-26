// api/ccee-abertos/mcp.js
// Busca dados do MCP (Mercado de Curto Prazo) por agente, filtrados por SIGLA_AGENTE.

const {
  YEAR_DELAY_MS,
  delay,
  normalizarMes,
  normalizarRegistro,
  fetchTodasPaginas,
  fetchMesRecente,
} = require("./utils");

// IDs dos datasets CKAN por ano — atualize quando a CCEE publicar novos anos
const DATASET_IDS = {
  2023: "f7177b27-74f2-49d6-b74d-817d82b846a0",
  2024: "36ae5272-3399-424c-9dbf-10857aa0b4cc",
  2025: "d9e1764c-f443-45d1-a5ea-a71812d878da",
  2026: "4e4eaf66-26c9-40b7-81e1-545b55f7e1d4",
};

/**
 * Busca dados do MCP de um agente pela sua sigla na CCEE.
 *
 * @param {string} sigla - Sigla do agente (ex: "IFG"). Case insensitive.
 * @param {object} [opcoes]
 * @param {string}   [opcoes.mes]  - Filtra um mês específico. Aceita "YYYY-MM" ou "YYYYMM".
 * @param {number[]} [opcoes.anos] - Restringe a anos específicos (ex: [2024, 2025]).
 *                                   Ignorado se `mes` for informado.
 * @returns {Promise<object[]>} Registros normalizados, ordenados por mês ASC.
 */
async function buscarMcp(sigla, { mes = null, anos = null } = {}) {
  sigla = sigla.trim().toUpperCase();
  mes   = normalizarMes(mes);

  let entradas;

  if (mes) {
    const ano = parseInt(mes.slice(0, 4), 10);
    if (!DATASET_IDS[ano])
      throw new Error(`Ano ${ano} não disponível. Anos mapeados: ${Object.keys(DATASET_IDS).join(", ")}`);
    entradas = [[ano, DATASET_IDS[ano]]];
  } else if (anos?.length) {
    entradas = anos
      .filter(a => DATASET_IDS[a])
      .map(a => [Number(a), DATASET_IDS[a]]);
    if (!entradas.length)
      throw new Error(`Nenhum dos anos solicitados (${anos.join(", ")}) está disponível`);
  } else {
    entradas = Object.entries(DATASET_IDS).map(([a, id]) => [Number(a), id]);
  }

  const filtros = { SIGLA_AGENTE: sigla };
  if (mes) filtros.MES_REFERENCIA = mes.replace("-", "");

  console.log(`\n🔍 MCP | sigla="${sigla}"${mes ? ` | mês="${mes}"` : ` | ${entradas.length} anos`}`);

  const resultado = [];

  for (let i = 0; i < entradas.length; i++) {
    const [ano, datasetId] = entradas[i];
    console.log(`  📅 Buscando mcp ${ano}...`);

    try {
      const registros = await fetchTodasPaginas(datasetId, filtros);
      console.log(`  ✓ ${registros.length} registros`);
      resultado.push(...registros.map(normalizarRegistro));
    } catch (err) {
      console.warn(`  ✗ Falha em ${ano}: ${err.message}`);
    }

    if (i < entradas.length - 1) await delay(YEAR_DELAY_MS);
  }

  resultado.sort((a, b) => (a.mes_referencia || "").localeCompare(b.mes_referencia || ""));

  if (resultado.length > 0) {
    console.log(`\n✅ ${resultado.length} registros | ${resultado[0].mes_referencia} → ${resultado.at(-1).mes_referencia}`);
  } else {
    console.log(`\n⚠️  Nenhum registro encontrado para sigla="${sigla}"`);
  }

  return resultado;
}

function anosDisponiveis() {
  return Object.keys(DATASET_IDS).map(Number);
}

/**
 * Retorna o mês mais recente disponível na API aberta para uma sigla de agente.
 * Percorre os anos do mais recente para o mais antigo, para na primeira resposta.
 * @param {string} sigla
 * @returns {Promise<string|null>} ex: "2026-03" ou null
 */
async function buscarMesRecente(sigla) {
  sigla = sigla.trim().toUpperCase();
  const anos = Object.keys(DATASET_IDS).map(Number).sort((a, b) => b - a);

  for (const ano of anos) {
    const raw = await fetchMesRecente(DATASET_IDS[ano], { SIGLA_AGENTE: sigla });
    if (raw) return normalizarMes(raw);
  }
  return null;
}

module.exports = { buscarMcp, buscarMesRecente, anosDisponiveis, normalizarMes, normalizarRegistro };
