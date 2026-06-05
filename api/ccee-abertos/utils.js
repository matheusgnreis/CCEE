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
  if (/^\d{4}-\d{2}$/.test(str))    return str;
  if (/^\d{6}$/.test(str))          return `${str.slice(0, 4)}-${str.slice(4, 6)}`;
  if (/^\d{4}\/\d{2}$/.test(str))   return str.replace("/", "-");
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 7); // YYYY-MM-DD → YYYY-MM
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
  console.log(`Fetching page: ${url}`);

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
  console.log(`Fetching recent month: ${url}`);
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

const CKAN_SQL_URL  = "https://dadosabertos.ccee.org.br/api/3/action/datastore_search_sql";
const CKAN_BASE_URL = "https://dadosabertos.ccee.org.br/api/3/action";

// ─── Auto-discovery de resources por ano ─────────────────────────────────────

const _pkgOfResource = {}; // anchorId  → { pkgId, ts }
const _idsOfPkg      = {}; // pkgId     → { ids: {year: id}, ts }
const DISCOVERY_TTL  = 12 * 60 * 60 * 1000; // 12 h

async function ckanAction(action, params = {}) {
  const url  = new URL(`${CKAN_BASE_URL}/${action}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res  = await fetch(url.toString(), {
      signal:  ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CCEEMonitor/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || "CKAN error");
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dado um resource ID âncora já conhecido, descobre todos os resources do mesmo
 * pacote CKAN e retorna { ano: resourceId }. Cacheado 12h.
 * Se qualquer chamada falhar, devolve fallbackIds silenciosamente.
 *
 * Fluxo: resource_show(anchorId) → package_id → package_show → resources
 */
async function descobrirIdsPorAno(anchorId, fallbackIds) {
  const agora = Date.now();

  // 1 — package_id a partir do resource âncora
  let pkgId = _pkgOfResource[anchorId]?.pkgId;
  if (!pkgId || agora - (_pkgOfResource[anchorId]?.ts || 0) > DISCOVERY_TTL) {
    try {
      const r = await ckanAction("resource_show", { id: anchorId });
      pkgId   = r.package_id;
      if (!pkgId) throw new Error("sem package_id");
      _pkgOfResource[anchorId] = { pkgId, ts: agora };
    } catch (err) {
      console.warn(`[ckan-discovery] resource_show falhou: ${err.message} — IDs fixos`);
      return fallbackIds;
    }
  }

  // 2 — todos os resources do pacote
  if (_idsOfPkg[pkgId]?.ids && agora - _idsOfPkg[pkgId].ts < DISCOVERY_TTL) {
    return { ...fallbackIds, ..._idsOfPkg[pkgId].ids };
  }

  try {
    const pkg = await ckanAction("package_show", { id: pkgId });
    const ids = {};
    for (const r of (pkg.resources || [])) {
      const texto = `${r.name || ""} ${r.description || ""} ${r.url || ""}`;
      const m     = texto.match(/(?<!\d)(20\d{2})(?!\d)/);
      if (m && r.id) ids[Number(m[1])] = r.id;
    }
    if (Object.keys(ids).length) {
      _idsOfPkg[pkgId] = { ids, ts: agora };
      console.log(`[ckan-discovery] ${pkgId}: ${Object.keys(ids).sort().join(", ")}`);
    }
    return { ...fallbackIds, ...ids };
  } catch (err) {
    console.warn(`[ckan-discovery] package_show falhou: ${err.message} — IDs fixos`);
    return fallbackIds;
  }
}

async function fetchTodasPaginasSql(sql) {
  const PAGE   = 5000;
  const result = [];
  let   offset = 0;

  while (true) {
    const paginada  = `${sql} LIMIT ${PAGE} OFFSET ${offset}`;
    const url       = `${CKAN_SQL_URL}?sql=${encodeURIComponent(paginada)}`;
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let records;
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
      if (!json.success) throw new Error(json.error?.message || JSON.stringify(json.error));
      records = json.result?.records || [];
    } catch (err) {
      if (err.name === "AbortError") throw new Error(`Timeout (>${TIMEOUT_MS}ms) na query SQL`);
      throw err;
    } finally {
      clearTimeout(timer);
    }

    result.push(...records);
    if (records.length < PAGE) break;
    offset += PAGE;
    await delay(PAGE_DELAY_MS);
  }

  return result;
}

module.exports = {
  CKAN_SEARCH_URL,
  CKAN_SQL_URL,
  CKAN_BASE_URL,
  descobrirIdsPorAno,
  PAGE_SIZE,
  YEAR_DELAY_MS,
  PAGE_DELAY_MS,
  TIMEOUT_MS,
  delay,
  normalizarMes,
  normalizarRegistro,
  fetchPagina,
  fetchTodasPaginas,
  fetchTodasPaginasSql,
  fetchMesRecente,
};
