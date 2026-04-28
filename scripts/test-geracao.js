// scripts/test-geracao.js
// Uso: node scripts/test-geracao.js AVIVAR 2026-01
// Mostra: colunas do CSV, quais SIGLA_USINA/NOME_EMPRESARIAL aparecem, total de geração por usina,
// e quantos períodos por usina para ajudar a detectar divisão por 2 ou mismatch de sigla.
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { listarRecursos } = require("../api/ccee-abertos/geracao-horaria");
const fetch = require("node-fetch");
const zlib  = require("zlib");

const busca      = (process.argv[2] || "AVIVAR").toUpperCase();
const mes        = process.argv[3] || "2026-01";
const USER_AGENT = "Mozilla/5.0 (compatible; CCEEMonitor/1.0)";

async function main() {
  console.log(`\nAnalisando CSV geração horária | mês=${mes} | buscando="${busca}"\n`);

  const recursos = await listarRecursos();
  const recurso  = recursos.find(r => r.mes === mes);
  if (!recurso) {
    console.log("Mês não encontrado. Disponíveis:", recursos.map(r => r.mes).join(", "));
    return;
  }
  console.log("URL:", recurso.url, "\n");

  const res = await fetch(recurso.url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  await new Promise((resolve, reject) => {
    let headers   = null;
    let sep       = ";";
    let leftover  = "";
    let totalLinhas = 0;
    let headersImpressos = false;

    // Por SIGLA_USINA: { geracao_total, n_periodos, min_periodo, max_periodo }
    const porUsina = {};
    const amostraSignlas = new Set(); // primeiras 30 siglas para entender o padrão

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
          if (!headersImpressos) {
            console.log("── Colunas do CSV ──");
            headers.forEach((h, i) => console.log(`  [${i}] ${h}`));
            console.log();
            headersImpressos = true;
          }
          continue;
        }

        totalLinhas++;
        const vals = l.split(sep).map(v => v.replace(/^"|"$/g, "").trim());
        const row  = {};
        headers.forEach((h, i) => { row[h] = vals[i] ?? null; });

        // Tenta campos prováveis para sigla e nome
        const siglaUsina = (row.SIGLA_USINA || row.SIGLA_PARCELA_USINA || "").trim().toUpperCase();
        const nomeEmp    = (row.NOME_EMPRESARIAL || row.NOME_AGENTE || "").trim().toUpperCase();
        const codParcela = (row.CODIGO_PARCELA_USINA || row.COD_PARCELA_USINA || "").trim();

        if (amostraSignlas.size < 30) amostraSignlas.add(`${siglaUsina} [cod=${codParcela}]`);

        if (!siglaUsina.includes(busca) && !nomeEmp.includes(busca) && !codParcela.includes(busca)) continue;

        const periodo = parseInt(row.PERIODO_COMERCIALIZACAO, 10) || 0;
        const geracao = parseFloat((row.GERACAO_CENTRO_GRAVIDADE || row.GERACAO || "0").replace(",", ".")) || 0;
        const sub     = (row.SUBMERCADO || "").trim().toUpperCase();

        const key = `${siglaUsina} | ${nomeEmp} | ${sub}`;
        if (!porUsina[key]) porUsina[key] = { geracao_total: 0, n_periodos: 0, min_periodo: Infinity, max_periodo: -Infinity };
        porUsina[key].geracao_total += geracao;
        porUsina[key].n_periodos++;
        porUsina[key].min_periodo = Math.min(porUsina[key].min_periodo, periodo);
        porUsina[key].max_periodo = Math.max(porUsina[key].max_periodo, periodo);
      }
    };

    const gunzip = zlib.createGunzip();
    gunzip.on("error", reject);
    gunzip.on("data", processChunk);
    gunzip.on("end", () => {
      if (leftover.trim()) processChunk(leftover + "\n");

      console.log(`Total linhas processadas: ${totalLinhas}\n`);
      console.log("── Amostra de SIGLA_USINA no CSV (primeiras 30) ──");
      [...amostraSignlas].forEach(s => console.log(`  ${s}`));
      console.log();
      console.log("── Resultados por (SIGLA_USINA | NOME_EMPRESARIAL | SUBMERCADO) ──");

      const sorted = Object.entries(porUsina).sort((a, b) => b[1].geracao_total - a[1].geracao_total);
      if (!sorted.length) {
        console.log(`  Nenhuma linha encontrada com "${busca}"`);
      } else {
        sorted.forEach(([key, d]) => {
          const n_horas_mes  = new Date(mes.slice(0, 4), mes.slice(5, 7), 0).getDate() * 24;
          const media_mwmed  = d.n_periodos > 0 ? (d.geracao_total / d.n_periodos).toFixed(4) : "0";
          console.log(`  ${key}`);
          console.log(`    Total: ${d.geracao_total.toFixed(4)} MWh | Períodos: ${d.n_periodos} (esperado: ${n_horas_mes}) | Média: ${media_mwmed} MWmed | Intervalo: ${d.min_periodo}–${d.max_periodo}`);
        });

        const totalGeral = sorted.reduce((s, [, d]) => s + d.geracao_total, 0);
        console.log(`\n  TOTAL GERAL: ${totalGeral.toFixed(4)} MWh`);
      }
      resolve();
    });

    res.body.on("error", reject);
    res.body.pipe(gunzip);
  });
}

main().catch(e => console.error("Erro:", e.message));
