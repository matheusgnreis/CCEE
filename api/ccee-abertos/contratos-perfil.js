// api/ccee-abertos/contratos-perfil.js
// Montante modulado de compra e venda por perfil de agente (CCEE dados abertos).
// Dataset: contrato_montante_compra_venda_perfil_agente_YYYY
// CONTRATACAO_COMPRA = quantidade modulada de compra [MWmed] — soma por mes+perfil
// CONTRATACAO_VENDA  = quantidade modulada de venda  [MWmed] — soma por mes+perfil

const { descobrirIdsPorAno, fetchTodasPaginas, YEAR_DELAY_MS, delay, normalizarMes } = require("./utils");

const _IDS_FALLBACK = {
  2024: "f6b478a0-bf4d-4d18-8f7f-067d01fefbd0",
  2025: "e14c30bf-e02e-40a5-afd2-0491e41e03c7",
  2026: "e1c163d5-c36e-43e7-a474-b4f54e4a33dd",
};
const getIds = () => descobrirIdsPorAno(_IDS_FALLBACK[2026], _IDS_FALLBACK);

function parseNum(v) {
  if (v == null || v === "") return 0;
  const n = Number(String(v).replace(",", "."));
  return isNaN(n) ? 0 : n;
}

// Converte MWmed para MWh multiplicando pelas horas do mês
function horasNoMes(mes) {
  const [ano, m] = mes.split("-").map(Number);
  return new Date(ano, m, 0).getDate() * 24;
}

/**
 * Busca montante modulado de compra/venda por perfil.
 * Agrega (soma) contratos por (mes_referencia, sigla_perfil).
 * Converte de MWmed para MWh.
 *
 * @param {string} nomeEmpresarial
 * @param {{ anos?: number[] }} opts
 * @returns {Promise<Array<{ mes_referencia, sigla_perfil, compra_mwh, venda_mwh }>>}
 */
async function buscarContratosPerfil(nomeEmpresarial, { anos = null } = {}) {
  if (!nomeEmpresarial) throw new Error("nomeEmpresarial obrigatório");

  const nomeUpper   = nomeEmpresarial.trim().toUpperCase();
  const DATASET_IDS = await getIds();

  const entradas = anos?.length
    ? anos.filter(a => DATASET_IDS[a]).map(a => [Number(a), DATASET_IDS[a]])
    : Object.entries(DATASET_IDS).map(([a, id]) => [Number(a), id]);

  const idsUnicos = [...new Map(entradas.map(([, id]) => [id, id])).values()];

  // Agrega por (mes_referencia, sigla_perfil)
  const mapa = new Map();

  for (let i = 0; i < idsUnicos.length; i++) {
    const id = idsUnicos[i];
    try {
      const registros = await fetchTodasPaginas(id, { NOME_EMPRESARIAL: nomeUpper });
      for (const r of registros) {
        const mes   = normalizarMes(r.mes_referencia ?? r.MES_REFERENCIA);
        const sigla = (r.sigla_perfil_agente || r.SIGLA_PERFIL_AGENTE || "").trim().toUpperCase();
        if (!mes || !sigla) continue;

        const k = `${mes}|${sigla}`;
        if (!mapa.has(k)) mapa.set(k, { mes_referencia: mes, sigla_perfil: sigla, compra_mwmed: 0, venda_mwmed: 0 });
        const e = mapa.get(k);
        e.compra_mwmed += parseNum(r.contratacao_compra ?? r.CONTRATACAO_COMPRA);
        e.venda_mwmed  += parseNum(r.contratacao_venda  ?? r.CONTRATACAO_VENDA);
      }
    } catch (e) {
      console.warn(`  ✗ contratos-perfil (${id}): ${e.message}`);
    }
    if (i < idsUnicos.length - 1) await delay(YEAR_DELAY_MS);
  }

  // Converte MWmed → MWh
  return [...mapa.values()].map(r => ({
    mes_referencia: r.mes_referencia,
    sigla_perfil:   r.sigla_perfil,
    compra_mwh:     Math.round(r.compra_mwmed * horasNoMes(r.mes_referencia) * 1000) / 1000,
    venda_mwh:      Math.round(r.venda_mwmed  * horasNoMes(r.mes_referencia) * 1000) / 1000,
  })).sort((a, b) =>
    a.mes_referencia.localeCompare(b.mes_referencia) || a.sigla_perfil.localeCompare(b.sigla_perfil)
  );
}

module.exports = { buscarContratosPerfil };
