// api/ccee-abertos/encargos-ess.js
// Busca o total mensal de ESS (Encargo de Serviços do Sistema) da CCEE.
// Fonte: encargo_pgto_mensal — campo PAGAMENTO_ENCARGO_ESS (R$ total do sistema/mês)

const { fetchTodasPaginas, normalizarMes, delay, YEAR_DELAY_MS, descobrirIdsPorAno } = require("./utils");

const _PGTO_FALLBACK = {
  2024: "fd544bed-b47f-48b2-8975-4ee449d4e3ce",
  2025: "ca6de693-4a45-4f1b-ad58-42239d665bc9",
};
const _ANCILAR_FALLBACK = {
  2024: "b06431bc-e509-4d65-94cc-6d81b0f1db5c",
  2025: "d93904d1-6a35-400b-927d-2dc52dfef4d8",
};
const getPgtoIds    = () => descobrirIdsPorAno(_PGTO_FALLBACK[2024],    _PGTO_FALLBACK);
const getAncilIds   = () => descobrirIdsPorAno(_ANCILAR_FALLBACK[2024], _ANCILAR_FALLBACK);

function parseNum(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(",", ".").trim());
  return isNaN(n) ? 0 : n;
}

/**
 * Retorna lista de { mes, pagamento_ess_rs } com o total mensal de ESS.
 * @param {number[]} [anos] - restringe a anos específicos (default: todos disponíveis)
 */
async function buscarEssMensal(anos = null) {
  const PGTO_IDS = await getPgtoIds();
  const entradas = Object.entries(PGTO_IDS)
    .map(([a, id]) => [Number(a), id])
    .filter(([a]) => !anos || anos.includes(a));

  if (!entradas.length) return [];

  const porMes = {};

  for (let i = 0; i < entradas.length; i++) {
    const [ano, id] = entradas[i];
    console.log(`[ess] Buscando pagamento ESS ${ano}...`);
    try {
      const registros = await fetchTodasPaginas(id, {});
      for (const r of registros) {
        const mes = normalizarMes(r.MES_REFERENCIA);
        if (!mes) continue;
        const v = parseNum(r.PAGAMENTO_ENCARGO_ESS);
        porMes[mes] = (porMes[mes] || 0) + v;
      }
      console.log(`[ess] ${registros.length} registros em ${ano}`);
    } catch (err) {
      console.warn(`[ess] Falha em ${ano}: ${err.message}`);
    }
    if (i < entradas.length - 1) await delay(YEAR_DELAY_MS);
  }

  return Object.entries(porMes)
    .map(([mes, pagamento_ess_rs]) => ({ mes, pagamento_ess_rs: Math.round(pagamento_ess_rs * 100) / 100 }))
    .sort((a, b) => a.mes.localeCompare(b.mes));
}

/**
 * Retorna breakdown de componentes ESS por mês:
 * { mes, const_on, const_off, cs, seg_ener, rest_op, importacao }
 */
async function buscarEssAncilar(anos = null) {
  const ANCILAR_IDS = await getAncilIds();
  const entradas = Object.entries(ANCILAR_IDS)
    .map(([a, id]) => [Number(a), id])
    .filter(([a]) => !anos || anos.includes(a));

  if (!entradas.length) return [];

  const porMes = {};

  for (let i = 0; i < entradas.length; i++) {
    const [ano, id] = entradas[i];
    console.log(`[ess-ancilar] Buscando breakdown ESS ${ano}...`);
    try {
      const registros = await fetchTodasPaginas(id, {});
      for (const r of registros) {
        const mes = normalizarMes(r.MES_REFERENCIA);
        if (!mes) continue;
        if (!porMes[mes]) porMes[mes] = { const_on: 0, const_off: 0, cs: 0, seg_ener: 0, rest_op: 0, importacao: 0 };
        porMes[mes].const_on    += parseNum(r.ENCARGO_CONST_ON);
        porMes[mes].const_off   += parseNum(r.ENCARGO_CONST_OFF);
        porMes[mes].cs          += parseNum(r.ENCARGO_CS);
        porMes[mes].seg_ener    += parseNum(r.ENCARGO_SEG_ENER);
        porMes[mes].rest_op     += parseNum(r.ENCARGO_REST_OP_UNIT_COMT);
        porMes[mes].importacao  += parseNum(r.ENCARGO_IMPORTACAO);
      }
    } catch (err) {
      console.warn(`[ess-ancilar] Falha em ${ano}: ${err.message}`);
    }
    if (i < entradas.length - 1) await delay(YEAR_DELAY_MS);
  }

  return Object.entries(porMes)
    .map(([mes, v]) => ({
      mes,
      const_on:   Math.round(v.const_on * 100) / 100,
      const_off:  Math.round(v.const_off * 100) / 100,
      cs:         Math.round(v.cs * 100) / 100,
      seg_ener:   Math.round(v.seg_ener * 100) / 100,
      rest_op:    Math.round(v.rest_op * 100) / 100,
      importacao: Math.round(v.importacao * 100) / 100,
    }))
    .sort((a, b) => a.mes.localeCompare(b.mes));
}

module.exports = { buscarEssMensal, buscarEssAncilar };
