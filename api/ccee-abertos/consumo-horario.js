// api/ccee-abertos/consumo-horario.js
// Baixa CSV gzipado de consumo horário por perfil de agente (CCEE dados abertos).
// Agrega por (SIGLA_PERFIL_AGENTE, PERIODO_COMERCIALIZACAO, SUBMERCADO)
// somando CONSUMO_CARGA_ACL de todas as cargas do agente.
// Os arquivos da CCEE são GZIP (não ZIP) — lidos via streaming para economizar memória.

const fetch  = require("node-fetch");
const zlib   = require("zlib");

const CKAN_BASE    = "https://dadosabertos.ccee.org.br/api/3/action";
const DATASET_SLUG = "consumo_horario_perfil_agente";
const TIMEOUT_CKAN = 30000;  // CKAN metadata
const TIMEOUT_DL   = 600000; // download de arquivo (até 10 min para gzip de 400MB)
const USER_AGENT   = "Mozilla/5.0 (compatible; CCEEMonitor/1.0)";

function stripAccents(s) {
  return s.normalize("NFD").replace(/̀-ͯ/g, "");
}

// Mutex por URL: evita que dois agentes baixem o mesmo arquivo simultaneamente
// (a CCEE dropa a segunda conexão para o mesmo recurso no mesmo IP)
const _dlEmAndamento = new Map(); // url → Promise

function downloadExclusivo(url, fn) {
  if (_dlEmAndamento.has(url)) {
    console.log(`  ⏳ Aguardando outro download do mesmo arquivo...`);
    return _dlEmAndamento.get(url).then(() => downloadExclusivo(url, fn));
  }
  const p = fn().finally(() => _dlEmAndamento.delete(url));
  _dlEmAndamento.set(url, p);
  return p;
}

// ─── CKAN ─────────────────────────────────────────────────────────────────────

async function ckanGet(action, params = {}) {
  const url = new URL(`${CKAN_BASE}/${action}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_CKAN);

  try {
    const res = await fetch(url.toString(), {
      signal:  controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || "CKAN error");
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

// Retorna lista de { mes: "YYYY-MM", url } ordenada ASC
async function listarRecursos() {
  const pkg = await ckanGet("package_show", { id: DATASET_SLUG });

  return (pkg.resources || [])
    .map(r => {
      // Tenta "YYYY_MM" / "YYYY-MM" (com separador); senão extrai YYYYMM no final do nome
      const fullStr = r.name + " " + (r.description || "");
      const match   = fullStr.match(/(\d{4})[_\-\/\s](\d{2})(?!\d)/)
                   || r.name.match(/(\d{4})(\d{2})$/);
      const mes = match ? `${match[1]}-${match[2]}` : null;
      return { mes, url: r.url, name: r.name };
    })
    .filter(r => r.mes)
    .sort((a, b) => a.mes.localeCompare(b.mes));
}

// ─── Download + parse streaming ───────────────────────────────────────────────

/**
 * Faz download do arquivo (GZIP ou plain), descomprime on-the-fly e
 * chama processLinha(row) para cada linha de dados.
 * Retorna os headers do CSV.
 */
async function streamCsv(url, processLinha) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_DL);

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar arquivo`);

    // Detecta gzip pelo primeiro byte do response body (peek)
    // node-fetch v2: response.body é um Node.js Readable
    const body = res.body;

    return await new Promise((resolve, reject) => {
      let headers  = null;
      let sep      = ";";
      let leftover = "";
      let linhasTotais = 0;

      const processChunk = (chunk) => {
        const text = leftover + chunk.toString("utf8");
        const partes = text.split("\n");
        leftover = partes.pop(); // última parte pode estar incompleta

        for (const linha of partes) {
          const l = linha.replace(/\r$/, "").trim();
          if (!l) continue;

          if (!headers) {
            sep     = l.includes(";") ? ";" : ",";
            headers = l.split(sep).map(h => h.replace(/^"|"$/g, "").trim());
            continue;
          }

          linhasTotais++;
          const vals = l.split(sep).map(v => v.replace(/^"|"$/g, "").trim());
          const row  = {};
          headers.forEach((h, i) => { row[h] = vals[i] ?? null; });
          processLinha(row);
        }
      };

      // Detecta se começa com bytes de gzip (1F 8B)
      let firstChunk = true;
      let pipeline;

      body.on("error", reject);

      body.once("data", (firstData) => {
        const isGzip = firstData[0] === 0x1F && firstData[1] === 0x8B;
        console.log(`  Formato detectado: ${isGzip ? "GZIP" : "plain text/CSV"}`);

        if (isGzip) {
          const gunzip = zlib.createGunzip();
          gunzip.on("error", reject);
          gunzip.on("data", processChunk);
          gunzip.on("end", () => {
            if (leftover.trim()) processChunk(leftover + "\n");
            console.log(`  Total linhas processadas: ${linhasTotais}`);
            resolve(headers);
          });
          gunzip.write(firstData);
          body.pipe(gunzip);
        } else {
          processChunk(firstData);
          body.on("data", processChunk);
          body.on("end", () => {
            if (leftover.trim()) processChunk(leftover + "\n");
            console.log(`  Total linhas processadas: ${linhasTotais}`);
            resolve(headers);
          });
        }
      });
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Baixa o CSV do mês via streaming gzip, filtra pelo agente e agrega por
 * (SIGLA_PERFIL_AGENTE, PERIODO_COMERCIALIZACAO, SUBMERCADO)
 * somando CONSUMO_CARGA_ACL de todas as cargas.
 *
 * @param {string} siglaPerfilAgente
 * @param {string} mes - "YYYY-MM"
 * @returns {Promise<Array<{ sigla_perfil_agente, mes_referencia, periodo, submercado, consumo_mwh }>>}
 */
async function buscarConsumoHorario(siglaPerfilAgente, mes, razaoSocial = null) {
  siglaPerfilAgente = siglaPerfilAgente.trim().toUpperCase();
  const nomeEmpresarial = razaoSocial ? stripAccents(razaoSocial.trim().toUpperCase()) : null;

  const recursos = await listarRecursos();
  const recurso  = recursos.find(r => r.mes === mes);

  if (!recurso) {
    const disponiveis = recursos.map(r => r.mes).join(", ");
    throw new Error(`Mês ${mes} não disponível. Meses: ${disponiveis}`);
  }

  console.log(`\n📥 Consumo horário | agente="${siglaPerfilAgente}"${nomeEmpresarial ? ` | nome="${nomeEmpresarial}"` : ""} | mês=${mes}`);
  console.log(`  URL: ${recurso.url}`);

  const SUB_MAP = {
    SUDESTE: "SE", "SUDESTE/CENTRO-OESTE": "SE", SECO: "SE",
    SUL: "S", NORDESTE: "NE", NORTE: "N",
    SE: "SE", S: "S", NE: "NE", N: "N",
  };

  const agregado        = {};
  const agregadoPerfil  = {};
  let   encontrou       = false;
  let   siglasAmostra   = new Set();
  let   subBrutoAmostra = new Set();

  const headers = await downloadExclusivo(recurso.url, () => streamCsv(recurso.url, (row) => {
    const sigla = (row.SIGLA_PERFIL_AGENTE || "").trim().toUpperCase();
    if (siglasAmostra.size < 20) siglasAmostra.add(sigla);

    // Se temos razão social, filtra exclusivamente por NOME_EMPRESARIAL (cobre todos os perfis da empresa)
    // Caso contrário cai na sigla exata
    if (nomeEmpresarial) {
      const nome = stripAccents((row.NOME_EMPRESARIAL || "").trim().toUpperCase());
      if (nome !== nomeEmpresarial) return;
    } else {
      if (sigla !== siglaPerfilAgente) return;
    }

    encontrou = true;

    // Período: CSV usa hora-do-dia base 0 (0–23); PLD usa hora-do-mês base 1 (1–744).
    // Converte: periodo_mes = (dia_do_mes - 1) * 24 + hora_dia + 1
    // O +1 alinha com a indexação do PLD: hora 0 do dia 1 → período 1, hora 23 do dia 31 → período 744
    const horaDia = parseInt(row.PERIODO_COMERCIALIZACAO, 10);
    const dataStr = (row.DATA || "").trim(); // "YYYY-MM-DD" ou "DD/MM/YYYY"
    let diaMes = 1;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) {
      diaMes = parseInt(dataStr.slice(8, 10), 10);
    } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dataStr)) {
      diaMes = parseInt(dataStr.slice(0, 2), 10);
    }
    const periodo = (diaMes - 1) * 24 + horaDia + 1;

    const subBruto  = (row.SUBMERCADO || "").trim().toUpperCase();
    if (subBrutoAmostra.size < 5) subBrutoAmostra.add(subBruto);
    const submercado = SUB_MAP[subBruto] || subBruto;

    const consumo = parseFloat((row.CONSUMO_CARGA_ACL || "0").replace(",", ".")) || 0;

    if (!periodo || !submercado) return;

    const key = `${periodo}|${submercado}`;
    if (!agregado[key]) {
      agregado[key] = { sigla_perfil_agente: siglaPerfilAgente, mes_referencia: mes, periodo, submercado, consumo_mwh: 0 };
    }
    agregado[key].consumo_mwh += consumo;

    // Agrega também por perfil individual (sigla da linha, não da empresa)
    const keyPerfil = `${sigla}|${periodo}|${submercado}`;
    if (!agregadoPerfil[keyPerfil]) {
      agregadoPerfil[keyPerfil] = { sigla_perfil: sigla, mes_referencia: mes, periodo, submercado, consumo_mwh: 0 };
    }
    agregadoPerfil[keyPerfil].consumo_mwh += consumo;
  }));

  console.log(`  Submercado bruto (amostra): ${[...subBrutoAmostra].join(", ")}`);
  console.log(`  Agente "${siglaPerfilAgente}" encontrado: ${encontrou ? "SIM ✅" : "NÃO ⚠"}`);

  if (!encontrou) {
    const parecidos = [...siglasAmostra].filter(s => s.includes(siglaPerfilAgente.slice(0, 6)));
    if (parecidos.length) console.warn(`  Nomes parecidos (sigla): ${parecidos.slice(0, 5).join(", ")}`);
    if (nomeEmpresarial) console.warn(`  Tentou NOME_EMPRESARIAL="${nomeEmpresarial}" — sem resultado`);
  }

  const resultado = Object.values(agregado).sort((a, b) => a.periodo - b.periodo);
  const resultadoPerfil = Object.values(agregadoPerfil).sort((a, b) =>
    a.sigla_perfil.localeCompare(b.sigla_perfil) || a.periodo - b.periodo
  );
  const subs = [...new Set(resultado.map(r => r.submercado))];
  const perfis = [...new Set(resultadoPerfil.map(r => r.sigla_perfil))];
  console.log(`  Submercados no consumo: ${subs.join(", ") || "(nenhum)"}`);
  console.log(`  Perfis encontrados: ${perfis.join(", ") || "(nenhum)"}`);
  console.log(`  Período mín/máx: ${resultado[0]?.periodo} – ${resultado[resultado.length - 1]?.periodo}`);
  console.log(`  ✅ ${resultado.length} períodos | ${resultadoPerfil.length} períodos por perfil`);

  return { resultado, resultadoPerfil };
}

async function mesesDisponiveis() {
  return (await listarRecursos()).map(r => r.mes);
}

module.exports = { buscarConsumoHorario, mesesDisponiveis, listarRecursos };
