// api/ccee-abertos/geracao.js
// Busca parcelas de usina (geração) por NOME_EMPRESARIAL.

const {
  YEAR_DELAY_MS,
  delay,
  normalizarRegistro,
  fetchTodasPaginas,
} = require("./utils");

const DATASET_IDS = {
  2024: "5c64e360-0252-4849-9dbb-8a61cb2af8f0",
  2025: "45d04e27-ba84-44e9-8e53-e186b44d0a49",
  2026: "7c33c984-c4d5-486a-a68d-0b034ccc9580",
};

async function buscarUsinas(nomeEmpresarial, { anos = null } = {}) {
  if (!nomeEmpresarial)
    throw new Error("Nome empresarial é obrigatório para buscar usinas");

  const nomeUpper = nomeEmpresarial.trim().toUpperCase();

  const entradas = anos?.length
    ? anos.filter(a => DATASET_IDS[a]).map(a => [Number(a), DATASET_IDS[a]])
    : Object.entries(DATASET_IDS).map(([a, id]) => [Number(a), id]);

  if (!entradas.length)
    throw new Error(`Nenhum dos anos solicitados está disponível. Anos mapeados: ${Object.keys(DATASET_IDS).join(", ")}`);

  console.log(`\n🔍 Usinas | NOME_EMPRESARIAL="${nomeUpper}" | ${entradas.length} anos`);
  const resultado = [];

  for (let i = 0; i < entradas.length; i++) {
    const [ano, datasetId] = entradas[i];
    console.log(`  📅 Buscando geração ${ano}...`);
    try {
      const registros = await fetchTodasPaginas(datasetId, { NOME_EMPRESARIAL: nomeUpper });
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
    return (a.sigla_ativo || "").localeCompare(b.sigla_ativo || "");
  });

  if (resultado.length > 0) {
    const usinas = new Set(resultado.map(r => r.sigla_ativo)).size;
    console.log(`\n✅ ${resultado.length} registros | ${usinas} usinas | ${resultado[0].mes_referencia} → ${resultado.at(-1).mes_referencia}`);
  } else {
    console.log(`\n⚠️  Nenhuma usina encontrada para "${nomeUpper}"`);
  }

  return resultado;
}

function anosDisponiveis() {
  return Object.keys(DATASET_IDS).map(Number);
}

module.exports = { buscarUsinas, anosDisponiveis };
