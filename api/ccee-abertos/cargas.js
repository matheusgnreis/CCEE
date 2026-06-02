// api/ccee-abertos/cargas.js
// Busca parcelas de carga por perfil de agente (SIGLA_PERFIL_AGENTE).

const {
  YEAR_DELAY_MS,
  delay,
  normalizarRegistro,
  fetchPagina,
  fetchTodasPaginas,
  descobrirIdsPorAno,
} = require("./utils");

const _IDS_FALLBACK = {
  2024: "b854f7bc-94a3-423a-96b7-2d4756ec77d1",
  2025: "c88d04a6-fe42-413b-b7bf-86e390494fb0",
  2026: "cf753cb8-3a01-4ff0-abda-020be5908c41",
};
const getIds = () => descobrirIdsPorAno(_IDS_FALLBACK[2024], _IDS_FALLBACK);

/**
 * Busca todas as parcelas de carga de um agente.
 *
 * Usa NOME_EMPRESARIAL (razão social da matriz) quando disponível — é estável
 * e cobre todos os perfis do agente. Cai para SIGLA_PERFIL_AGENTE apenas
 * se razaoSocial não for fornecida.
 *
 * @param {string}   siglaPerfilAgente    - Usado como fallback se razaoSocial ausente.
 * @param {object}   [opcoes]
 * @param {number[]} [opcoes.anos]        - Restringe a anos específicos.
 * @param {string}   [opcoes.razaoSocial] - Razão social vinda do Power BI (preferida).
 */
async function buscarCargas(siglaPerfilAgente, { anos = null, razaoSocial = null } = {}) {
  const DATASET_IDS = await getIds();
  const campo = razaoSocial ? "NOME_EMPRESARIAL" : "SIGLA_PERFIL_AGENTE";
  const valor = razaoSocial
    ? razaoSocial.trim().toUpperCase()
    : siglaPerfilAgente.trim().toUpperCase();

  const entradas = anos?.length
    ? anos.filter(a => DATASET_IDS[a]).map(a => [Number(a), DATASET_IDS[a]])
    : Object.entries(DATASET_IDS).map(([a, id]) => [Number(a), id]);

  if (!entradas.length)
    throw new Error(`Nenhum dos anos solicitados está disponível. Anos mapeados: ${Object.keys(DATASET_IDS).join(", ")}`);

  console.log(`\n🔍 Cargas | ${campo}="${valor}" | ${entradas.length} anos`);

  const resultado = [];

  for (let i = 0; i < entradas.length; i++) {
    const [ano, datasetId] = entradas[i];
    console.log(`  📅 ${ano}...`);
    try {
      const registros = await fetchTodasPaginas(datasetId, { [campo]: valor });
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
    console.log(`\n✅ ${resultado.length} registros via ${campo} | ${parcelas} parcelas | ${resultado[0].mes_referencia} → ${resultado.at(-1).mes_referencia}`);
  } else {
    console.log(`\n⚠️  Nenhuma parcela encontrada via ${campo}="${valor}"`);
  }

  return resultado;
}

function anosDisponiveis() {
  return Object.keys(DATASET_IDS).map(Number);
}

module.exports = { buscarCargas, anosDisponiveis, normalizarRegistro };
