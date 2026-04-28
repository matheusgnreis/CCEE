// scripts/test-consumo.js
// Uso: node scripts/test-consumo.js AVIVAR 2025-12
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { listarRecursos } = require("../api/ccee-abertos/consumo-horario");
const fetch = require("node-fetch");
const zlib  = require("zlib");

const busca = (process.argv[2] || "AVIVAR").toUpperCase();
const mes   = process.argv[3] || "2025-12";
const USER_AGENT = "Mozilla/5.0 (compatible; CCEEMonitor/1.0)";

async function main() {
  console.log(`\nAnalisando CSV consumo horário | mês=${mes} | buscando="${busca}"\n`);

  const recursos = await listarRecursos();
  const recurso  = recursos.find(r => r.mes === mes);
  if (!recurso) { console.log("Mês não encontrado. Disponíveis:", recursos.map(r=>r.mes).join(", ")); return; }

  console.log("URL:", recurso.url);

  const res = await fetch(recurso.url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  await new Promise((resolve, reject) => {
    let headers  = null;
    let sep      = ";";
    let leftover = "";

    // (SIGLA_PERFIL_AGENTE, NOME_EMPRESARIAL) → consumo total
    const combinacoes = {};
    let totalLinhas   = 0;

    const processChunk = (chunk) => {
      const text   = leftover + chunk.toString("utf8");
      const partes = text.split("\n");
      leftover = partes.pop();

      for (const linha of partes) {
        const l = linha.replace(/\r$/, "").trim();
        if (!l) continue;
        if (!headers) {
          sep = l.includes(";") ? ";" : ",";
          headers = l.split(sep).map(h => h.replace(/^"|"$/g, "").trim());
          continue;
        }
        totalLinhas++;
        const vals = l.split(sep).map(v => v.replace(/^"|"$/g, "").trim());
        const row  = {};
        headers.forEach((h, i) => { row[h] = vals[i] ?? null; });

        const sigla = (row.SIGLA_PERFIL_AGENTE || "").trim().toUpperCase();
        const nome  = (row.NOME_EMPRESARIAL    || "").trim().toUpperCase();

        if (!sigla.includes(busca) && !nome.includes(busca)) continue;

        const key     = `${sigla} | ${nome}`;
        const consumo = parseFloat((row.CONSUMO_CARGA_ACL || "0").replace(",", ".")) || 0;
        if (!combinacoes[key]) combinacoes[key] = 0;
        combinacoes[key] += consumo;
      }
    };

    const gunzip = zlib.createGunzip();
    gunzip.on("error", reject);
    gunzip.on("data", processChunk);
    gunzip.on("end", () => {
      if (leftover.trim()) processChunk(leftover + "\n");
      console.log(`\nTotal linhas processadas: ${totalLinhas}`);
      console.log(`\n── Combinações (SIGLA_PERFIL_AGENTE | NOME_EMPRESARIAL) → consumo total ──`);
      const sorted = Object.entries(combinacoes).sort((a, b) => b[1] - a[1]);
      if (!sorted.length) {
        console.log("  Nenhuma linha encontrada com", busca);
      } else {
        sorted.forEach(([key, total]) => {
          console.log(`  ${key.padEnd(70)} → ${total.toFixed(4)} MWh`);
        });
        const totalGeral = sorted.reduce((s, [,v]) => s+v, 0);
        console.log(`\n  TOTAL: ${totalGeral.toFixed(4)} MWh`);
      }
      resolve();
    });

    res.body.on("error", reject);
    res.body.pipe(gunzip);
  });
}

main().catch(e => console.error("Erro:", e.message));
