// scripts/buscar-agente-consumo.js
// Faz streaming parcial do CSV de consumo horário buscando um agente por sigla ou nome.
// Para logo ao encontrar a primeira ocorrência (ou ao processar MAX_LINHAS linhas).
// Uso: node scripts/buscar-agente-consumo.js "CMU" 2026-03

require("dotenv").config();
const fetch = require("node-fetch");
const zlib  = require("zlib");

const CKAN_BASE    = "https://dadosabertos.ccee.org.br/api/3/action";
const DATASET_SLUG = "consumo_horario_perfil_agente";
const TERMO        = (process.argv[2] || "CMU").toUpperCase();
const MES          = process.argv[3] || null;
const MAX_LINHAS   = parseInt(process.argv[4] || "500000", 10);

async function listarRecursos() {
  const res  = await fetch(`${CKAN_BASE}/package_show?id=${DATASET_SLUG}`, {
    headers: { "User-Agent": "CCEEMonitor/1.0" },
  });
  const json = await res.json();
  return (json.result.resources || [])
    .map(r => {
      const m = (r.name + " " + (r.description || "")).match(/(\d{4})[_\-\/\s](\d{2})(?!\d)/)
             || r.name.match(/(\d{4})(\d{2})$/);
      return { mes: m ? `${m[1]}-${m[2]}` : null, url: r.url };
    })
    .filter(r => r.mes)
    .sort((a, b) => a.mes.localeCompare(b.mes));
}

async function run() {
  const recursos = await listarRecursos();
  const alvo     = MES
    ? recursos.find(r => r.mes === MES)
    : recursos[recursos.length - 1];

  if (!alvo) {
    console.error(`Mês ${MES || "(último)"} não encontrado. Disponíveis: ${recursos.map(r => r.mes).join(", ")}`);
    process.exit(1);
  }

  console.log(`🔍 Buscando "${TERMO}" em consumo horário — mês ${alvo.mes}`);
  console.log(`   URL: ${alvo.url}`);
  console.log(`   Limite: ${MAX_LINHAS.toLocaleString()} linhas\n`);

  const res = await fetch(alvo.url, { headers: { "User-Agent": "CCEEMonitor/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  await new Promise((resolve, reject) => {
    let headers   = null;
    let sep       = ";";
    let leftover  = "";
    let linhas    = 0;
    let achados   = 0;
    let parar     = false;
    const amostras = new Set();

    function processChunk(chunk) {
      if (parar) return;
      const text   = leftover + chunk.toString("utf8");
      const partes = text.split("\n");
      leftover = partes.pop();

      for (const linha of partes) {
        if (parar) break;
        const l = linha.replace(/\r$/, "").trim();
        if (!l) continue;

        if (!headers) {
          sep     = l.includes(";") ? ";" : ",";
          headers = l.split(sep).map(h => h.replace(/^"|"$/g, "").trim());
          console.log("   Colunas:", headers.slice(0, 8).join(", "), "...");
          continue;
        }

        linhas++;
        if (linhas % 100000 === 0) {
          process.stdout.write(`\r   ${linhas.toLocaleString()} linhas | achados: ${achados} | amostras: ${amostras.size}`);
        }

        const vals = l.split(sep).map(v => v.replace(/^"|"$/g, "").trim());
        const row  = {};
        headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });

        const sigla = (row.SIGLA_PERFIL_AGENTE || "").toUpperCase();
        const nome  = (row.NOME_EMPRESARIAL     || "").toUpperCase();

        if (amostras.size < 5) amostras.add(sigla.slice(0, 20));

        if (sigla.includes(TERMO) || nome.includes(TERMO)) {
          achados++;
          if (achados <= 5) {
            console.log(`\n   ✅ ENCONTRADO [linha ${linhas}]:`);
            console.log(`      SIGLA_PERFIL_AGENTE : ${row.SIGLA_PERFIL_AGENTE}`);
            console.log(`      NOME_EMPRESARIAL    : ${row.NOME_EMPRESARIAL}`);
            console.log(`      DATA                : ${row.DATA}`);
            console.log(`      PERIODO             : ${row.PERIODO_COMERCIALIZACAO}`);
            console.log(`      SUBMERCADO          : ${row.SUBMERCADO}`);
            console.log(`      CONSUMO_CARGA_ACL   : ${row.CONSUMO_CARGA_ACL}`);
          }
          if (achados === 5) {
            console.log(`\n   (mostrando apenas primeiros 5 resultados — interrompendo stream)`);
            parar = true;
          }
        }

        if (linhas >= MAX_LINHAS && !achados) {
          console.log(`\n   ⚠ Limite de ${MAX_LINHAS.toLocaleString()} linhas atingido sem encontrar "${TERMO}".`);
          parar = true;
        }
      }
    }

    const body = res.body;
    body.once("data", firstData => {
      const isGzip = firstData[0] === 0x1F && firstData[1] === 0x8B;
      console.log(`   Formato: ${isGzip ? "GZIP" : "plain CSV"}\n`);

      function onEnd() {
        process.stdout.write("\n");
        if (!achados) {
          console.log(`\n   ❌ "${TERMO}" NÃO encontrado nas primeiras ${linhas.toLocaleString()} linhas.`);
          console.log(`   Amostras de SIGLA: ${[...amostras].join(", ")}`);
        } else {
          console.log(`\n   Total achados: ${achados} ocorrências em ${linhas.toLocaleString()} linhas`);
        }
        resolve();
      }

      if (isGzip) {
        const gunzip = zlib.createGunzip();
        gunzip.on("error", reject);
        gunzip.on("data", processChunk);
        gunzip.on("end", onEnd);

        body.on("error", reject);
        body.on("data", chunk => {
          if (!parar) gunzip.write(chunk);
          else body.destroy();
        });
        body.on("end", () => gunzip.end());

        gunzip.write(firstData);
      } else {
        processChunk(firstData);
        body.on("data", chunk => { if (!parar) processChunk(chunk); else body.destroy(); });
        body.on("end", onEnd);
        body.on("error", reject);
      }
    });
  });
}

run().catch(err => { console.error("Erro:", err.message); process.exit(1); });
