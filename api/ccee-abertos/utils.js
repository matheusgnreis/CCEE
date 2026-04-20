// api/ccee-abertos/utils.js
// Utilitários compartilhados entre os módulos da API aberta da CCEE.

const fetch = require("node-fetch");

// ─── Constantes ───────────────────────────────────────────────────────────────

const CKAN_SEARCH_URL = "https://dadosabertos.ccee.org.br/api/3/action/datastore_search";
const PAGE_SIZE       = 1000;
const YEAR_DELAY_MS   = 1200;
const PAGE_DELAY_MS   = 300;
const TIMEOUT_MS      = 15000;

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ─── Normalização ─────────────────────────────────────────────────────────────

function normalizarMes(valor) {
  if (valor == null) return null;
  const str = valor.toString().trim();
  if (/^\d{4}-\d{2}$/.test(str))  return str;
  if (/^\d{6}$/.test(str))        return `${str.slice(0, 4)}-${str.slice(4, 6)}`;
  if (/^\d{4}\/\d{2}$/.test(str)) return str.replace("/", "-");
  return str;
}

function normalizarRegistro(record) {
  const norm = {};
  for (const [chave, valor] of Object.entries(record)) {
    if (chave === "_id") continue;
    norm[chave.toLowerCase()] = valor;
  }
  if (norm.mes_referencia != null) {
    norm.mes_referencia = normalizarMes(norm.mes_referencia);
  }
  return norm;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchPagina(datasetId, filtros, offset = 0) {
  const params = new URLSearchParams({
    resource_id: datasetId,
    limit:       PAGE_SIZE,
    offset,
    filters:     JSON.stringify(filtros),
  });

  const url        = `${CKAN_SEARCH_URL}?${params}`;
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CCEEMonitor/1.0)" },
    });

    if (!res.ok) {
      const corpo = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${corpo ? ` — ${corpo.slice(0, 120)}` : ""}`);
    }

    const json = await res.json();

    if (!json.success) {
      const msg = json.error?.message || JSON.stringify(json.error);
      throw new Error(`API CCEE erro: ${msg}`);
    }

    return json.result;
  } catch (err) {
    if (err.name === "AbortError")
      throw new Error(`Timeout (>${TIMEOUT_MS}ms) ao buscar dataset=${datasetId} offset=${offset}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTodasPaginas(datasetId, filtros) {
  const primeira  = await fetchPagina(datasetId, filtros, 0);
  const total     = primeira.total;
  let   registros = primeira.records;

  if (total > PAGE_SIZE) {
    const paginasExtras = Math.ceil((total - PAGE_SIZE) / PAGE_SIZE);
    for (let i = 0; i < paginasExtras; i++) {
      await delay(PAGE_DELAY_MS);
      const pagina = await fetchPagina(datasetId, filtros, PAGE_SIZE * (i + 1));
      registros = registros.concat(pagina.records);
    }
  }

  return registros;
}

// Busca apenas o mês mais recente disponível para um agente (1 request, limit=1)
async function fetchMesRecente(datasetId, filtros) {
  const params = new URLSearchParams({
    resource_id: datasetId,
    limit:   1,
    offset:  0,
    filters: JSON.stringify(filtros),
    sort:    "MES_REFERENCIA desc",
  });

  const url        = `${CKAN_SEARCH_URL}?${params}`;
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CCEEMonitor/1.0)" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.success || !json.result?.records?.length) return null;
    return json.result.records[0].MES_REFERENCIA?.toString() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  CKAN_SEARCH_URL,
  PAGE_SIZE,
  YEAR_DELAY_MS,
  PAGE_DELAY_MS,
  TIMEOUT_MS,
  delay,
  normalizarMes,
  normalizarRegistro,
  fetchPagina,
  fetchTodasPaginas,
  fetchMesRecente,
};
