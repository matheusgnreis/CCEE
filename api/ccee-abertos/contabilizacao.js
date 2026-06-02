// api/ccee-abertos/contabilizacao.js
// Busca contabilização de montante por perfil de agente (CCEE dados abertos).
// Filtra por NOME_EMPRESARIAL e retorna todos os perfis/meses disponíveis.

const { YEAR_DELAY_MS, delay, normalizarRegistro, fetchTodasPaginas, descobrirIdsPorAno } = require("./utils");

const _IDS_FALLBACK = {
  2024: "d47f9660-28d6-4542-9dbc-9648e13b3c67",
  2025: "76d1cf4c-da8c-47a5-9f0d-8b50079be960",
  2026: "f8512d8c-9c0f-4f73-b2d2-911545084d9b",
};
const getIds = () => descobrirIdsPorAno(_IDS_FALLBACK[2024], _IDS_FALLBACK);

const CAMPOS_NUMERICOS = [
  "valor_tm_mcp", "compensacao_mre", "valor_encargo", "valor_ajuste_exposicao",
  "valor_ajuste_alivio_ret", "efeito_contrat_disp", "efeito_contrat_cota_gf",
  "efeito_contrat_nuclear", "ajuste_recontab", "ajuste_mcsd_ex",
  "resultado_financeiro_er", "efeito_ccearq", "efeito_contrat_itaipu",
  "efeito_repasse_risco_hidro", "efeito_desloc_pld_cmo", "resultado_final",
];

function parseNum(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return isNaN(n) ? null : n;
}

async function buscarContabilizacao(nomeEmpresarial, { anos = null } = {}) {
  if (!nomeEmpresarial) throw new Error("Nome empresarial é obrigatório");

  const DATASET_IDS = await getIds();
  const nomeUpper   = nomeEmpresarial.trim().toUpperCase();

  const entradas = anos?.length
    ? anos.filter(a => DATASET_IDS[a]).map(a => [Number(a), DATASET_IDS[a]])
    : Object.entries(DATASET_IDS).map(([a, id]) => [Number(a), id]);

  if (!entradas.length)
    throw new Error(`Nenhum dos anos solicitados disponível. Anos: ${Object.keys(DATASET_IDS).join(", ")}`);

  console.log(`\n🔍 Contabilização | NOME_EMPRESARIAL="${nomeUpper}" | ${entradas.length} anos`);
  const resultado = [];

  for (let i = 0; i < entradas.length; i++) {
    const [ano, datasetId] = entradas[i];
    console.log(`  📅 Buscando ${ano}...`);
    try {
      const registros = await fetchTodasPaginas(datasetId, { NOME_EMPRESARIAL: nomeUpper });
      console.log(`  ✓ ${registros.length} registros`);
      resultado.push(...registros.map(r => {
        const norm = normalizarRegistro(r);
        // Converte campos numéricos (CCEE retorna strings com vírgula)
        for (const campo of CAMPOS_NUMERICOS) {
          norm[campo] = parseNum(norm[campo]);
        }
        return norm;
      }));
    } catch (err) {
      console.warn(`  ✗ Falha em ${ano}: ${err.message}`);
    }
    if (i < entradas.length - 1) await delay(YEAR_DELAY_MS);
  }

  resultado.sort((a, b) => {
    const porMes = (a.mes_referencia || "").localeCompare(b.mes_referencia || "");
    if (porMes !== 0) return porMes;
    return (a.sigla_perfil_agente || "").localeCompare(b.sigla_perfil_agente || "");
  });

  console.log(`\n✅ Contabilização: ${resultado.length} registros | ${new Set(resultado.map(r => r.sigla_perfil_agente)).size} perfis`);
  return resultado;
}

module.exports = { buscarContabilizacao };
