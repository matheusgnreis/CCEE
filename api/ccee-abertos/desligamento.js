// api/ccee-abertos/desligamento.js
// Busca dados de desligamento por descumprimento (CCEE dados abertos).
// Dataset atualizado semanalmente — um recurso por semana no package.
// Filtra pelo CNPJ do agente (preferencial) ou SIGLA (fallback).

const { fetchTodasPaginas } = require("./utils");

const CKAN_BASE    = "https://dadosabertos.ccee.org.br/api/3/action";
const PKG_SLUG     = "desligamento_descumprimento";
const USER_AGENT   = "Mozilla/5.0 (compatible; CCEEMonitor/1.0)";
const TIMEOUT_META = 15000;

let _resourceIdCache = null; // ID do recurso mais recente (cache em memória)

// ─── Descobre o resource_id mais recente do package ──────────────────────────

async function resourceMaisRecente() {
  if (_resourceIdCache) return _resourceIdCache;

  const fetch = require("node-fetch");
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_META);

  try {
    const res  = await fetch(`${CKAN_BASE}/package_show?id=${PKG_SLUG}`,
      { signal: ctrl.signal, headers: { "User-Agent": USER_AGENT } });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || "CKAN error");

    // Extrai data do nome do recurso (ex: desligamento_descumprimento_20260515)
    const resources = (json.result.resources || [])
      .map(r => {
        const m = (r.name || "").match(/(\d{8})$/);
        return { id: r.id, data: m ? m[1] : "00000000", name: r.name };
      })
      .sort((a, b) => b.data.localeCompare(a.data));

    if (!resources.length) throw new Error("Nenhum recurso encontrado no package");
    _resourceIdCache = resources[0].id;
    console.log(`[desligamento] Recurso mais recente: ${resources[0].name} (${resources[0].id})`);
    return _resourceIdCache;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Normaliza uma linha do dataset ──────────────────────────────────────────

function parseDate(v) {
  if (!v) return null;
  const s = v.trim();
  // DD/MM/AAAA
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split("/");
    return `${y}-${m}-${d}`;
  }
  return s || null;
}

function normalizar(row) {
  return {
    sigla:                  (row.SIGLA                  || "").trim() || null,
    cnpj:                   (row.CNPJ                   || "").trim() || null,
    classe:                 (row.CLASSE                 || "").trim() || null,
    status:                 (row.STATUS                 || "").trim() || null,
    data_desligamento:      parseDate(row.DATA_DESLIGAMENTO),
    inicio_monitoramento:   parseDate(row.INICIO_MONITORAMENTO),
    fim_monitoramento:      parseDate(row.FIM_MONITORAMENTO),
    reuniao_cad:            (row.REUNIAO_CAD             || "").trim() || null,
    suspensao_fornecimento: parseDate(row.SUSPENSAO_DE_FORNECIMENTO),
    tipos_descumprimentos:  (row.TIPOS_DESCUMPRIMENTOS  || "").trim() || null,
    caucionamento:          (row.CAUCIONAMENTO           || "").trim() || null,
    tipo_desligamento:      (row.TIPO_DESLIGAMENTO       || "").trim() || null,
    data_publicacao:        parseDate(row.DATA_PUBLICACAO),
  };
}

// ─── Busca pública ────────────────────────────────────────────────────────────

/**
 * Busca dados de desligamento de um agente.
 * Tenta CNPJ primeiro (mais confiável), cai para SIGLA se não encontrar.
 *
 * @param {string} cnpj       - CNPJ formatado (ex: "22.482.228/0001-06")
 * @param {string} [sigla]    - Sigla do agente (fallback)
 * @returns {Promise<object|null>} - Registro normalizado ou null se não encontrado
 */
async function buscarDesligamento(cnpj, sigla = null) {
  const resourceId = await resourceMaisRecente();

  // Tenta por CNPJ
  if (cnpj) {
    const rows = await fetchTodasPaginas(resourceId, { CNPJ: cnpj.trim() });
    if (rows.length) {
      console.log(`[desligamento] Encontrado por CNPJ: ${cnpj} | status=${rows[0].STATUS}`);
      return normalizar(rows[0]);
    }
  }

  // Fallback: SIGLA
  if (sigla) {
    const rows = await fetchTodasPaginas(resourceId, { SIGLA: sigla.trim().toUpperCase() });
    if (rows.length) {
      console.log(`[desligamento] Encontrado por SIGLA: ${sigla} | status=${rows[0].STATUS}`);
      return normalizar(rows[0]);
    }
  }

  return null; // agente não está na lista de desligamento
}

/** Invalida o cache (útil para forçar re-fetch do recurso mais recente) */
function invalidarCache() { _resourceIdCache = null; }

module.exports = { buscarDesligamento, invalidarCache };
