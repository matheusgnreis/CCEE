// api/ccee-abertos/encargos-eer.js
// Busca o total mensal de EER (Encargo de Energia de Reserva) da CCEE.
// Fonte: energia_reserva_liquidacao — campo VALOR_TOTAL_LIQUID (R$ total do sistema/mês)

const { fetchTodasPaginas, normalizarMes, delay, YEAR_DELAY_MS, descobrirIdsPorAno } = require("./utils");

const _IDS_FALLBACK = {
  2024: "b0dcf91b-7f59-4dd4-9c2b-ddc9a93153a6",
  2025: "172c1dc9-7507-4453-8b4c-ede4273f2b70",
  2026: "a8f020d6-0c4d-4298-9940-03268f50131c",
};
const getIds = () => descobrirIdsPorAno(_IDS_FALLBACK[2024], _IDS_FALLBACK);

function parseNum(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(",", ".").trim());
  return isNaN(n) ? 0 : n;
}

/**
 * Retorna lista de { mes, eer_rs } com o total mensal de EER.
 * @param {number[]} [anos] - restringe a anos específicos (default: todos disponíveis)
 */
async function buscarEerMensal(anos = null) {
  const RESERVA_IDS = await getIds();
  const entradas = Object.entries(RESERVA_IDS)
    .map(([a, id]) => [Number(a), id])
    .filter(([a]) => !anos || anos.includes(a));

  if (!entradas.length) return [];

  const porMes = {};

  for (let i = 0; i < entradas.length; i++) {
    const [ano, id] = entradas[i];
    console.log(`[eer] Buscando EER ${ano}...`);
    try {
      const registros = await fetchTodasPaginas(id, {});
      for (const r of registros) {
        const mes = normalizarMes(r.MES_REFERENCIA);
        if (!mes) continue;
        const v = parseNum(r.VALOR_TOTAL_LIQUID);
        porMes[mes] = (porMes[mes] || 0) + v;
      }
      console.log(`[eer] ${registros.length} registros em ${ano}`);
    } catch (err) {
      console.warn(`[eer] Falha em ${ano}: ${err.message}`);
    }
    if (i < entradas.length - 1) await delay(YEAR_DELAY_MS);
  }

  return Object.entries(porMes)
    .map(([mes, eer_rs]) => ({ mes, eer_rs: Math.round(eer_rs * 100) / 100 }))
    .sort((a, b) => a.mes.localeCompare(b.mes));
}

module.exports = { buscarEerMensal };
