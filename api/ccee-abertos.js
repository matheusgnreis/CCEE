// api/ccee-abertos.js
// Fonte: API Aberta da CCEE (dadosabertos.ccee.org.br)
// Retorna dados de MCP por agente, filtrados por SIGLA_AGENTE.
// Compatível com node-fetch v2 (já instalado no projeto).

const fetch = require("node-fetch");

// ─── Configuração ─────────────────────────────────────────────────────────────

// Resource IDs por ano — dataset MCP da CCEE (dados abertos)
const RECURSOS_POR_ANO = {
  2023: "f7177b27-74f2-49d6-b74d-817d82b846a0",
  2024: "36ae5272-3399-424c-9dbf-10857aa0b4cc",
  2025: "d9e1764c-f443-45d1-a5ea-a71812d878da",
  2026: "4e4eaf66-26c9-40b7-81e1-545b55f7e1d4",
};

const BASE_URL          = "https://dadosabertos.ccee.org.br/api/3/action/datastore_search";
const LIMITE_POR_PAGINA = 1000;   // máximo suportado pela API CKAN
const DELAY_ANOS_MS     = 1200;   // pausa entre anos (evita rate limit)
const DELAY_PAGINAS_MS  = 300;    // pausa entre páginas do mesmo ano
const TIMEOUT_MS        = 20000;  // abort após 20s por request

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ─── Normalização ─────────────────────────────────────────────────────────────

/**
 * Normaliza o mês para o formato YYYY-MM.
 * Aceita: "202403", "2024-03", "2024/03"
 */
function normalizarMes(valor) {
  if (valor == null) return null;
  const str = valor.toString().trim();
  if (/^\d{4}-\d{2}$/.test(str)) return str;
  if (/^\d{6}$/.test(str))       return `${str.slice(0, 4)}-${str.slice(4, 6)}`;
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

function compararMes(a, b) {
  return (a.mes_referencia || "").localeCompare(b.mes_referencia || "");
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

/**
 * Faz um GET na API CKAN com timeout e trata erros de forma explícita.
 */
async function fetchPagina(resourceId, filtros, offset = 0) {
  const params = new URLSearchParams({
    resource_id: resourceId,
    limit:       LIMITE_POR_PAGINA,
    offset,
    filters:     JSON.stringify(filtros),
  });

  const url        = `${BASE_URL}?${params}`;
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
      throw new Error(`Timeout (>${TIMEOUT_MS}ms) ao buscar resource=${resourceId} offset=${offset}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Busca todos os registros de um resource, paginando automaticamente se
 * o total ultrapassar LIMITE_POR_PAGINA.
 */
async function fetchTodosRegistros(resourceId, filtros) {
  const primeira  = await fetchPagina(resourceId, filtros, 0);
  const total     = primeira.total;
  let   registros = primeira.records;

  if (total > LIMITE_POR_PAGINA) {
    const paginasExtras = Math.ceil((total - LIMITE_POR_PAGINA) / LIMITE_POR_PAGINA);
    for (let i = 0; i < paginasExtras; i++) {
      await delay(DELAY_PAGINAS_MS);
      const pagina = await fetchPagina(resourceId, filtros, LIMITE_POR_PAGINA * (i + 1));
      registros = registros.concat(pagina.records);
    }
  }

  return registros;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Busca dados de MCP de um agente pela sua SIGLA na CCEE.
 *
 * @param {string} sigla - Sigla do agente (ex: "IFG"). Case insensitive.
 * @param {object} [opcoes]
 * @param {string}   [opcoes.mes]  - Filtra um mês específico. Aceita "YYYY-MM" ou "YYYYMM".
 * @param {number[]} [opcoes.anos] - Restringe a anos específicos (ex: [2024, 2025]).
 *                                   Ignorado se `mes` for informado.
 * @returns {Promise<object[]>} Registros normalizados (chaves lowercase), ordenados por mês ASC.
 *
 * Campos típicos retornados pela API (podem variar por dataset/ano):
 *   mes_referencia, sigla_agente, nm_agente, ... (inspecione o retorno para detalhes)
 */
async function buscaDados(sigla, { mes = null, anos = null } = {}) {
  sigla = sigla.trim().toUpperCase();
  mes   = normalizarMes(mes);

  // Monta a lista de [ano, resourceId] a percorrer
  let entradas;
  if (mes) {
    const ano = parseInt(mes.slice(0, 4), 10);
    if (!RECURSOS_POR_ANO[ano])
      throw new Error(`Ano ${ano} não mapeado. Disponíveis: ${Object.keys(RECURSOS_POR_ANO).join(", ")}`);
    entradas = [[ano, RECURSOS_POR_ANO[ano]]];
  } else if (anos?.length) {
    entradas = anos
      .filter(a => RECURSOS_POR_ANO[a])
      .map(a => [Number(a), RECURSOS_POR_ANO[a]]);
    if (!entradas.length)
      throw new Error(`Nenhum dos anos solicitados (${anos.join(", ")}) está disponível`);
  } else {
    entradas = Object.entries(RECURSOS_POR_ANO).map(([a, id]) => [Number(a), id]);
  }

  const filtros = { SIGLA_AGENTE: sigla };
  // A API armazena MES_REFERENCIA como YYYYMM (sem traço)
  if (mes) filtros.MES_REFERENCIA = mes.replace("-", "");

  console.log(`\n🔍 CCEE Abertos | sigla="${sigla}"${mes ? ` | mês="${mes}"` : ` | ${entradas.length} anos`}`);

  const todosDados = [];

  for (let i = 0; i < entradas.length; i++) {
    const [ano, resourceId] = entradas[i];
    console.log(`  📅 Buscando ${ano}...`);

    try {
      const registros   = await fetchTodosRegistros(resourceId, filtros);
      const normalizados = registros.map(normalizarRegistro);
      console.log(`  ✓ ${normalizados.length} registros`);
      todosDados.push(...normalizados);
    } catch (err) {
      // Falha em um ano não interrompe os demais
      console.warn(`  ✗ Falha em ${ano}: ${err.message}`);
    }

    if (i < entradas.length - 1) await delay(DELAY_ANOS_MS);
  }

  todosDados.sort(compararMes);

  if (todosDados.length > 0) {
    const primeiro = todosDados[0].mes_referencia;
    const ultimo   = todosDados.at(-1).mes_referencia;
    console.log(`\n✅ ${todosDados.length} registros | ${primeiro} → ${ultimo}`);
  } else {
    console.log(`\n⚠️  Nenhum registro encontrado para sigla="${sigla}"`);
  }

  return todosDados;
}

/**
 * Retorna os anos mapeados na API aberta.
 * @returns {number[]}
 */
function anosDisponiveis() {
  return Object.keys(RECURSOS_POR_ANO).map(Number);
}

module.exports = { buscaDados, anosDisponiveis, normalizarMes };
