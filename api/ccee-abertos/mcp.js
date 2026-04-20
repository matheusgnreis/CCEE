// api/ccee-abertos/mcp.js
// Fonte: API Aberta da CCEE (dadosabertos.ccee.org.br)
// Busca dados do MCP (Mercado de Curto Prazo) por agente, filtrados por SIGLA_AGENTE.
// Compatível com node-fetch v2 (já instalado no projeto).

const fetch = require("node-fetch");

// ─── Configuração ─────────────────────────────────────────────────────────────

// IDs dos datasets CKAN por ano — atualize quando a CCEE publicar novos anos
const DATASET_IDS = {
  2023: "f7177b27-74f2-49d6-b74d-817d82b846a0",
  2024: "36ae5272-3399-424c-9dbf-10857aa0b4cc",
  2025: "d9e1764c-f443-45d1-a5ea-a71812d878da",
  2026: "4e4eaf66-26c9-40b7-81e1-545b55f7e1d4",
};

const CKAN_SEARCH_URL = "https://dadosabertos.ccee.org.br/api/3/action/datastore_search";
const PAGE_SIZE       = 1000;   // máximo suportado pela API CKAN
const YEAR_DELAY_MS   = 1200;   // pausa entre anos (evita rate limit)
const PAGE_DELAY_MS   = 300;    // pausa entre páginas do mesmo ano
const TIMEOUT_MS      = 15000;  // alinhado com api/index.js

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ─── Normalização ─────────────────────────────────────────────────────────────

/**
 * Normaliza o mês para o formato YYYY-MM.
 * Aceita: "202403", "2024-03", "2024/03"
 */
function normalizarMes(valor) {
  if (valor == null) return null;
  const str = valor.toString().trim();
  if (/^\d{4}-\d{2}$/.test(str))  return str;
  if (/^\d{6}$/.test(str))        return `${str.slice(0, 4)}-${str.slice(4, 6)}`;
  if (/^\d{4}\/\d{2}$/.test(str)) return str.replace("/", "-");
  return str;
}

/**
 * Normaliza um registro bruto da API:
 * - Remove o campo interno `_id`
 * - Converte todas as chaves para lowercase
 * - Normaliza MES_REFERENCIA → mes_referencia (YYYY-MM)
 */
function normalizarRegistro(record) {
  const normalizado = {};
  for (const [chave, valor] of Object.entries(record)) {
    if (chave === "_id") continue;
    normalizado[chave.toLowerCase()] = valor;
  }
  if (normalizado.mes_referencia != null) {
    normalizado.mes_referencia = normalizarMes(normalizado.mes_referencia);
  }
  return normalizado;
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
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      const corpo = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${corpo ? ` — ${corpo.slice(0, 120)}` : ""}`);
    }

    const json = await res.json();

    if (!json.success) {
      const msg = json.error?.message || JSON.stringify(json.error);
      throw new Error(`API CCEE erro: ${msg}`);
    }

    return json.result; // { total, records, ... }
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

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Busca dados do MCP de um agente pela sua sigla na CCEE.
 *
 * @param {string} sigla - Sigla do agente (ex: "IFG"). Case insensitive.
 * @param {object} [opcoes]
 * @param {string}   [opcoes.mes]  - Filtra um mês específico. Aceita "YYYY-MM" ou "YYYYMM".
 * @param {number[]} [opcoes.anos] - Restringe a anos específicos (ex: [2024, 2025]).
 *                                   Ignorado se `mes` for informado.
 * @returns {Promise<object[]>} Registros normalizados (chaves lowercase), ordenados por mês ASC.
 */
async function buscarMcp(sigla, { mes = null, anos = null } = {}) {
  sigla = sigla.trim().toUpperCase();
  mes   = normalizarMes(mes);

  let entradas; // [[ano, datasetId], ...]

  if (mes) {
    const ano = parseInt(mes.slice(0, 4), 10);
    if (!DATASET_IDS[ano])
      throw new Error(`Ano ${ano} não disponível. Anos mapeados: ${Object.keys(DATASET_IDS).join(", ")}`);
    entradas = [[ano, DATASET_IDS[ano]]];
  } else if (anos?.length) {
    entradas = anos
      .filter(a => DATASET_IDS[a])
      .map(a => [Number(a), DATASET_IDS[a]]);
    if (!entradas.length)
      throw new Error(`Nenhum dos anos solicitados (${anos.join(", ")}) está disponível`);
  } else {
    entradas = Object.entries(DATASET_IDS).map(([a, id]) => [Number(a), id]);
  }

  const filtros = { SIGLA_AGENTE: sigla };
  // A API armazena MES_REFERENCIA como YYYYMM (sem traço)
  if (mes) filtros.MES_REFERENCIA = mes.replace("-", "");

  console.log(`\n🔍 MCP | sigla="${sigla}"${mes ? ` | mês="${mes}"` : ` | ${entradas.length} anos`}`);

  const resultado = [];

  for (let i = 0; i < entradas.length; i++) {
    const [ano, datasetId] = entradas[i];
    console.log(`  📅 Buscando ${ano}...`);

    try {
      const registros = await fetchTodasPaginas(datasetId, filtros);
      console.log(`  ✓ ${registros.length} registros`);
      resultado.push(...registros.map(normalizarRegistro));
    } catch (err) {
      // Falha em um ano não interrompe os demais
      console.warn(`  ✗ Falha em ${ano}: ${err.message}`);
    }

    if (i < entradas.length - 1) await delay(YEAR_DELAY_MS);
  }

  resultado.sort((a, b) => (a.mes_referencia || "").localeCompare(b.mes_referencia || ""));

  if (resultado.length > 0) {
    console.log(`\n✅ ${resultado.length} registros | ${resultado[0].mes_referencia} → ${resultado.at(-1).mes_referencia}`);
  } else {
    console.log(`\n⚠️  Nenhum registro encontrado para sigla="${sigla}"`);
  }

  return resultado;
}

/**
 * Retorna os anos com datasets disponíveis na API aberta da CCEE.
 * @returns {number[]}
 */
function anosDisponiveis() {
  return Object.keys(DATASET_IDS).map(Number);
}

module.exports = { buscarMcp, anosDisponiveis, normalizarMes };
