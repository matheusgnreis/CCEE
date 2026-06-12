// api/ccee-abertos/lista-perfil.js
// Busca a lista de perfis ativos de agentes CCEE (lista_perfil_v1).
// Campos: COD_AGENTE, SIGLA_AGENTE, NOME_EMPRESARIAL, CNPJ, COD_PERF_AGENTE,
//         SIGLA_PERFIL_AGENTE, CLASSE_PERFIL_AGENTE, STATUS_PERFIL,
//         CATEGORIA_AGENTE, SUBMERCADO, VAREJISTA, TIPO_ENERG_PERF

const { fetchTodasPaginas, descobrirIdsPorAno } = require("./utils");

// lista_perfil_v1 — versão com campo TIPO_ENERG_PERF, cobre 2025 e 2026
const _IDS_FALLBACK = {
  2025: "6a2fce01-4e40-472a-a0d9-4ff6e8130a3b",
  2026: "c140a86b-f41e-45e6-9380-ec78b15492fd",
};

const getIds = () => descobrirIdsPorAno(_IDS_FALLBACK[2025], _IDS_FALLBACK);

/**
 * Retorna todos os perfis ativos do ano mais recente disponível.
 * @returns {Promise<Array<{
 *   cod_agente: number, sigla_agente: string, nome_empresarial: string,
 *   cnpj: string, cod_perf_agente: number, sigla_perfil_agente: string,
 *   classe_perfil_agente: string, categoria_agente: string,
 *   submercado: string, varejista: string, tipo_energ_perf: string
 * }>>}
 */
async function buscarPerfisAtivos() {
  const DATASET_IDS = await getIds();
  const anoAtual = new Date().getFullYear();

  // Usa o ano mais recente disponível
  let anoAlvo = anoAtual;
  while (anoAlvo >= 2025 && !DATASET_IDS[anoAlvo]) anoAlvo--;
  const id = DATASET_IDS[anoAlvo];
  if (!id) throw new Error("lista_perfil_v1: nenhum dataset disponível");

  console.log(`\n📋 lista_perfil_v1_${anoAlvo}: buscando perfis ativos...`);
  const registros = await fetchTodasPaginas(id, { STATUS_PERFIL: "ATIVO" });
  console.log(`  ✅ ${registros.length} perfis ativos`);

  return registros.map(r => ({
    cod_agente:          parseInt(r.COD_AGENTE, 10),
    sigla_agente:        (r.SIGLA_AGENTE         || "").trim(),
    nome_empresarial:    (r.NOME_EMPRESARIAL      || "").trim(),
    cnpj:                (r.CNPJ                  || "").trim(),
    cod_perf_agente:     parseInt(r.COD_PERF_AGENTE, 10),
    sigla_perfil_agente: (r.SIGLA_PERFIL_AGENTE   || "").trim(),
    classe_perfil_agente:(r.CLASSE_PERFIL_AGENTE  || "").trim(),
    categoria_agente:    (r.CATEGORIA_AGENTE       || "").trim(),
    submercado:          (r.SUBMERCADO             || "").trim(),
    varejista:           (r.VAREJISTA              || "").trim(),
    tipo_energ_perf:     (r.TIPO_ENERG_PERF        || "").trim(),
  })).filter(r => !isNaN(r.cod_agente) && !isNaN(r.cod_perf_agente));
}

/**
 * Agrupa perfis ativos por SIGLA_AGENTE.
 * Retorna Map<sigla_agente, { cod_agente, nome_empresarial, cnpj, perfis[] }>
 */
async function buscarPerfisAtivosPorSigla() {
  const lista = await buscarPerfisAtivos();
  const mapa = new Map();
  for (const r of lista) {
    if (!mapa.has(r.sigla_agente)) {
      mapa.set(r.sigla_agente, {
        cod_agente:       r.cod_agente,
        nome_empresarial: r.nome_empresarial,
        cnpj:             r.cnpj,
        perfis:           [],
      });
    }
    mapa.get(r.sigla_agente).perfis.push({
      cod_perf_agente:     r.cod_perf_agente,
      sigla_perfil_agente: r.sigla_perfil_agente,
    });
  }
  return mapa;
}

/**
 * Busca agentes na lista_perfil_v1 pelo NOME_EMPRESARIAL (parcial, case-insensitive).
 * Usa o parâmetro `q` do CKAN datastore_search para full-text search.
 * Retorna resultados únicos por SIGLA_AGENTE, apenas perfis ATIVOS.
 * @param {string} termo
 * @returns {Promise<Array<{ agente: string, razao_social: string, cod_agente: number, perfis: number[] }>>}
 */
async function buscarPerfisNoCKAN(termo) {
  const DATASET_IDS = await getIds();
  const anoAtual    = new Date().getFullYear();
  let anoAlvo       = anoAtual;
  while (anoAlvo >= 2025 && !DATASET_IDS[anoAlvo]) anoAlvo--;
  const id = DATASET_IDS[anoAlvo];
  if (!id) return [];

  const { fetchPagina } = require("./utils");

  // CKAN q com campo específico faz substring search
  const params = new URLSearchParams({
    resource_id: id,
    limit:       50,
    offset:      0,
    q:           JSON.stringify({ NOME_EMPRESARIAL: termo }),
    filters:     JSON.stringify({ STATUS_PERFIL: "ATIVO" }),
  });

  let records = [];
  try {
    const url      = `https://dadosabertos.ccee.org.br/api/3/action/datastore_search?${params}`;
    const ctrl     = new AbortController();
    const timer    = setTimeout(() => ctrl.abort(), 10000);
    const fetch    = require("node-fetch");
    const res      = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "CCEEMonitor/1.0" } });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = await res.json();
    if (!json.success) return [];
    records = json.result?.records || [];
  } catch {
    return [];
  }

  // Agrupa por SIGLA_AGENTE, deduplica
  const porSigla = new Map();
  for (const r of records) {
    const sigla = (r.SIGLA_AGENTE || "").trim();
    if (!sigla) continue;
    if (!porSigla.has(sigla)) {
      porSigla.set(sigla, {
        agente:       sigla,
        razao_social: (r.NOME_EMPRESARIAL || "").trim(),
        cod_agente:   parseInt(r.COD_AGENTE, 10) || null,
        perfis:       [],
      });
    }
    const cod = parseInt(r.COD_PERF_AGENTE, 10);
    if (!isNaN(cod)) porSigla.get(sigla).perfis.push(cod);
  }

  return [...porSigla.values()];
}

module.exports = { buscarPerfisAtivos, buscarPerfisAtivosPorSigla, buscarPerfisNoCKAN };
