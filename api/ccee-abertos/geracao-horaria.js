// api/ccee-abertos/geracao-horaria.js
// Baixa CSV gzipado de geração horária por usina (CCEE dados abertos).
// Agrega GERACAO_CENTRO_GRAVIDADE por (periodo, submercado) somando todas as usinas do agente.
// Formato idêntico ao consumo-horario.js: streaming GZIP, período base 1, submercado normalizado.

const fetch = require("node-fetch");
const zlib  = require("zlib");

const CKAN_BASE    = "https://dadosabertos.ccee.org.br/api/3/action";
const DATASET_SLUG = "geracao_horaria_usina";
const TIMEOUT_CKAN = 30000;
const TIMEOUT_DL   = 600000;
const USER_AGENT   = "Mozilla/5.0 (compatible; CCEEMonitor/1.0)";

const SUB_MAP = { SUDESTE: "SE", SUL: "S", NORDESTE: "NE", NORTE: "N", SE: "SE", S: "S", NE: "NE", N: "N" };

async function ckanGet(action, params = {}) {
  const url  = new URL(`${CKAN_BASE}/${action}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_CKAN);
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal, headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || "CKAN error");
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function listarRecursos() {
  const pkg = await ckanGet("package_show", { id: DATASET_SLUG });
  return (pkg.resources || [])
    .map(r => {
      const fullStr = r.name + " " + (r.description || "");
      const match   = fullStr.match(/(\d{4})[_\-\/\s](\d{2})(?!\d)/)
                   || r.name.match(/(\d{4})(\d{2})$/);
      const mes = match ? `${match[1]}-${match[2]}` : null;
      return { mes, url: r.url, name: r.name };
    })
    .filter(r => r.mes)
    .sort((a, b) => a.mes.localeCompare(b.mes));
}

async function streamCsv(url, processLinha) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_DL);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    return await new Promise((resolve, reject) => {
      let headers  = null;
      let sep      = ";";
      let leftover = "";
      let total    = 0;
      const body   = res.body;

      const processChunk = (chunk) => {
        const text   = leftover + chunk.toString("utf8");
        const partes = text.split("\n");
        leftover = partes.pop();
        for (const linha of partes) {
          const l = linha.replace(/\r$/, "").trim();
          if (!l) continue;
          if (!headers) {
            sep     = l.includes(";") ? ";" : ",";
            headers = l.split(sep).map(h => h.replace(/^"|"$/g, "").trim());
            continue;
          }
          total++;
          const vals = l.split(sep).map(v => v.replace(/^"|"$/g, "").trim());
          const row  = {};
          headers.forEach((h, i) => { row[h] = vals[i] ?? null; });
          processLinha(row);
        }
      };

      body.once("data", (firstData) => {
        const isGzip = firstData[0] === 0x1F && firstData[1] === 0x8B;
        if (isGzip) {
          const gunzip = zlib.createGunzip();
          gunzip.on("error", reject);
          gunzip.on("data", processChunk);
          gunzip.on("end", () => {
            if (leftover.trim()) processChunk(leftover + "\n");
            console.log(`  Total linhas: ${total}`);
            resolve(headers);
          });
          gunzip.write(firstData);
          body.pipe(gunzip);
        } else {
          processChunk(firstData);
          body.on("data", processChunk);
          body.on("end", () => {
            if (leftover.trim()) processChunk(leftover + "\n");
            console.log(`  Total linhas: ${total}`);
            resolve(headers);
          });
        }
        body.on("error", reject);
      });
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Baixa o CSV de geração horária do mês, filtra pelas siglas das usinas do agente
 * e agrega GERACAO_CENTRO_GRAVIDADE por (periodo, submercado).
 *
 * @param {string}   mes          - "YYYY-MM"
 * @param {string[]} siglasUsinas - sigla_parcela_usina das usinas do agente
 * @returns {Promise<Array<{ mes_referencia, periodo, submercado, geracao_mwmed }>>}
 */
async function buscarGeracaoHoraria(mes, siglasUsinas) {
  if (!siglasUsinas.length) return [];

  const recursos = await listarRecursos();
  const recurso  = recursos.find(r => r.mes === mes);
  if (!recurso) {
    const disponiveis = recursos.map(r => r.mes).join(", ");
    throw new Error(`Mês ${mes} não disponível em geracao_horaria_usina. Disponíveis: ${disponiveis}`);
  }

  const siglasSet = new Set(siglasUsinas.map(s => s.trim().toUpperCase()));
  console.log(`\n📥 Geração horária | mês=${mes} | usinas=${[...siglasSet].join(",")}`);
  console.log(`  URL: ${recurso.url}`);

  const agregado    = {};
  let   encontrou   = false;
  let   amostraSubs = new Set();

  await streamCsv(recurso.url, (row) => {
    const sigla = (row.SIGLA_USINA || "").trim().toUpperCase();
    if (!siglasSet.has(sigla)) return;

    encontrou = true;
    const horaDia = parseInt(row.PERIODO_COMERCIALIZACAO, 10);
    const dataStr = (row.DATA || "").trim();
    let diaMes    = 1;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataStr))     diaMes = parseInt(dataStr.slice(8, 10), 10);
    else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dataStr)) diaMes = parseInt(dataStr.slice(0, 2), 10);
    const periodo = (diaMes - 1) * 24 + horaDia + 1;

    const subBruto   = (row.SUBMERCADO || "").trim().toUpperCase();
    if (amostraSubs.size < 5) amostraSubs.add(subBruto);
    const submercado = SUB_MAP[subBruto] || subBruto;

    const geracao = parseFloat((row.GERACAO_CENTRO_GRAVIDADE || "0").replace(",", ".")) || 0;
    if (!periodo || !submercado) return;

    const key = `${periodo}|${submercado}`;
    if (!agregado[key]) {
      agregado[key] = { mes_referencia: mes, periodo, submercado, geracao_mwmed: 0 };
    }
    agregado[key].geracao_mwmed += geracao;
  });

  console.log(`  Submercado bruto (amostra): ${[...amostraSubs].join(", ")}`);
  console.log(`  Usinas encontradas: ${encontrou ? "SIM ✅" : "NÃO ⚠"}`);

  const resultado = Object.values(agregado).sort((a, b) => a.periodo - b.periodo);
  const subs      = [...new Set(resultado.map(r => r.submercado))];
  console.log(`  Submercados: ${subs.join(", ") || "(nenhum)"} | Período ${resultado[0]?.periodo}–${resultado[resultado.length - 1]?.periodo}`);
  console.log(`  ✅ ${resultado.length} períodos de geração`);
  return resultado;
}

async function mesesDisponiveis() {
  return (await listarRecursos()).map(r => r.mes);
}

module.exports = { buscarGeracaoHoraria, mesesDisponiveis };
