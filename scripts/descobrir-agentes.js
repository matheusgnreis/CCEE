// scripts/descobrir-agentes.js
// Descobre todos os agentes CCEE, verifica a classe de cada um
// e gera scripts-powerbi/agentes.txt pronto para uso.
//
// Estratégia:
//   1. Banco local (ccee_agentes) — fonte primária, já tem classe
//   2. CKAN (contabilização) — descobre agentes não cadastrados ainda
//   3. Power BI (Q2 metadados) — determina classe dos novos
//   Comercializadores são excluídos automaticamente.
//
// Uso:
//   node scripts/descobrir-agentes.js
//   node scripts/descobrir-agentes.js --saida outra-lista.txt
//   node scripts/descobrir-agentes.js --somente-banco   (pula CKAN/Power BI)

require("dotenv").config();
const fs    = require("fs");
const path  = require("path");
const fetch = require("node-fetch");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Configuração ─────────────────────────────────────────────────────────────

const POWERBI_URL          = "https://wabi-brazil-south-b-primary-api.analysis.windows.net/public/reports/querydata?synchronous=true";
const POWERBI_RESOURCE_KEY = process.env.POWERBI_RESOURCE_KEY;
const POWERBI_MODEL_ID     = Number(process.env.POWERBI_MODEL_ID);

const CKAN_BASE    = "https://dadosabertos.ccee.org.br/api/3/action";
const SEED_CONTAB  = "d47f9660-28d6-4542-9dbc-9648e13b3c67"; // contabilização 2024
const USER_AGENT   = "Mozilla/5.0 (compatible; CCEEMonitor/1.0)";

const CLASSES_SKIP = new Set(["Comercializador"]);
const DELAY_MS     = 1500;

const args = process.argv.slice(2);
const saidaFlag   = args.indexOf("--saida");
const SAIDA       = saidaFlag !== -1 ? args[saidaFlag + 1] : "scripts-powerbi/agentes.txt";
const SOMENTE_BANCO = args.includes("--somente-banco");

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Banco: agentes já cadastrados ────────────────────────────────────────────

async function agentesNoBanco() {
  try {
    const { rows } = await pool.query(
      "SELECT agente, classe, razao_social, sigla, cnpj, situacao FROM ccee_agentes ORDER BY agente"
    );
    console.log(`  Banco: ${rows.length} agentes encontrados`);
    return rows;
  } catch {
    console.warn("  Banco não disponível ou sem dados — pulando");
    return [];
  }
}

// ─── CKAN: nomes distintos na contabilização ──────────────────────────────────

const zlib = require("zlib");

async function resourceMaisRecente(seed) {
  const resData = await fetch(`${CKAN_BASE}/resource_show?id=${seed}`,
    { headers: { "User-Agent": USER_AGENT } }).then(r => r.json());
  if (!resData.success) throw new Error(`resource_show falhou: ${JSON.stringify(resData.error)}`);
  const pkgId   = resData.result.package_id;
  const pkgData = await fetch(`${CKAN_BASE}/package_show?id=${pkgId}`,
    { headers: { "User-Agent": USER_AGENT } }).then(r => r.json());
  if (!pkgData.success) throw new Error(`package_show falhou: ${JSON.stringify(pkgData.error)}`);

  const resources = pkgData.result?.resources || [];
  console.log(`  CKAN: ${resources.length} resources — ${resources.map(r => r.name).join(" | ")}`);

  // Extrai ano/mês do nome (sem \b — underscore é word char)
  let melhorData = -1, melhorUrl = null;
  for (const res of resources) {
    const texto = res.name + " " + (res.description || "");
    const mYYYYMM = texto.match(/(20\d{2})(\d{2})(?!\d)/);
    const mYYYY   = texto.match(/(20\d{2})(?!\d)/);
    const data    = mYYYYMM ? Number(mYYYYMM[1]) * 100 + Number(mYYYYMM[2])
                  : mYYYY   ? Number(mYYYY[1]) * 100
                  : -1;
    if (data > melhorData) { melhorData = data; melhorUrl = res.url; }
  }
  if (!melhorUrl) throw new Error("Nenhum resource com ano encontrado no package");
  const ano = Math.floor(melhorData / 100);
  console.log(`  CKAN: usando resource ano=${ano} → ${melhorUrl}`);
  return melhorUrl;
}

async function nomesNoCkan() {
  const url  = await resourceMaisRecente(SEED_CONTAB);
  const nomes = new Set();

  console.log("  Streaming CSV para coletar nomes (pode levar alguns segundos)...");
  await new Promise((resolve, reject) => {
    fetch(url, { headers: { "User-Agent": USER_AGENT } })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let headers = null, sep = ";", leftover = "";

        const processar = (chunk) => {
          const text   = leftover + chunk.toString("utf8");
          const linhas = text.split("\n");
          leftover = linhas.pop();
          for (const linha of linhas) {
            const l = linha.replace(/\r$/, "").trim();
            if (!l) continue;
            if (!headers) {
              sep     = l.includes(";") ? ";" : ",";
              headers = l.split(sep).map(h => h.replace(/^"|"$/g, "").trim());
              continue;
            }
            const vals = l.split(sep);
            const idx  = headers.indexOf("NOME_EMPRESARIAL");
            if (idx < 0) continue;
            const nome = (vals[idx] || "").replace(/^"|"$/g, "").trim();
            if (nome) nomes.add(nome);
          }
        };

        const body = res.body;
        body.once("data", first => {
          const isGzip = first[0] === 0x1F && first[1] === 0x8B;
          if (isGzip) {
            const gz = zlib.createGunzip();
            gz.on("error", reject);
            gz.on("data", processar);
            gz.on("end", resolve);
            gz.write(first);
            body.pipe(gz);
          } else {
            processar(first);
            body.on("data", processar);
            body.on("end", resolve);
          }
          body.on("error", reject);
        });
      })
      .catch(reject);
  });

  console.log(`  CKAN: ${nomes.size} nomes distintos na contabilização`);
  return [...nomes];
}

// ─── Power BI: metadados de um agente ─────────────────────────────────────────

function queryMetadados(agente) {
  return {
    version: "1.0.0",
    modelId: POWERBI_MODEL_ID,
    queries: [{
      Query: { Commands: [{ SemanticQueryDataShapeCommand: {
        Query: {
          Version: 2,
          From: [
            { Name: "s", Entity: "SEGURANCA_MERCADO",  Type: 0 },
            { Name: "m", Entity: "MEDIDAS_CALCULADAS", Type: 0 },
            { Name: "t", Entity: "TabelaBusca",        Type: 0 },
            { Name: "c", Entity: "CALENDARIO",         Type: 0 },
          ],
          Select: [
            { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "NM_CSSE"        } },
            { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "NM_RZOA_SOCI"   } },
            { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "SG_AGEN"        } },
            { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "CNPJ_Formatado" } },
            { Column:  { Expression: { SourceRef: { Source: "s" } }, Property: "DS_STAT_AGEN"   } },
            { Measure: { Expression: { SourceRef: { Source: "m" } }, Property: "Capital Social" } },
          ],
          Where: [
            { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Tipo"        } }], Values: [[{ Literal: { Value: "'Razão Social'"   } }]] } } },
            { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "c" } }, Property: "FiltroMesAno"} }], Values: [[{ Literal: { Value: "'(mais recente)'" } }]] } } },
            { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Valor"       } }], Values: [[{ Literal: { Value: `'${agente}'`      } }]] } } },
          ],
        },
        Binding: {
          Primary: { Groupings: [{ Projections: [0, 1, 2, 3, 4, 5] }] },
          DataReduction: { DataVolume: 3, Primary: { Window: { Count: 500 } } },
          Version: 1,
        },
      }}] },
    }],
    cancelQueries: [],
  };
}

async function buscarClassePowerBI(agente) {
  try {
    const resp    = await fetch(POWERBI_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "X-PowerBI-ResourceKey": POWERBI_RESOURCE_KEY },
      body:    JSON.stringify(queryMetadados(agente)),
    });
    const json    = await resp.json();
    const dsr     = json?.results?.[0]?.result?.data?.dsr?.DS?.[0];
    const dm      = dsr?.PH?.[0]?.DM0;
    const dicts   = dsr?.ValueDicts || {};
    if (!dm?.length) return null;
    const C = dm[0].C || [];
    const d = (key, idx) => {
      if (typeof idx === "string") return idx;
      return dicts[key] ? (dicts[key][idx] ?? null) : null;
    };
    return {
      classe:       d("D0", C[0]) || null,
      razao_social: d("D1", C[1]) || null,
      sigla:        d("D2", C[2]) || null,
      cnpj:         d("D3", C[3]) || null,
      situacao:     d("D4", C[4]) || null,
    };
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(60));
  console.log("Descobrindo agentes CCEE...");
  console.log("═".repeat(60));

  // 1. Agentes no banco
  console.log("\n[1/3] Banco de dados:");
  const dosBanco = await agentesNoBanco();
  const nomesNoBanco = new Set(dosBanco.map(r => r.agente.toUpperCase()));

  let todos = [...dosBanco];

  // 2. CKAN — encontra agentes não cadastrados ainda
  if (!SOMENTE_BANCO) {
    console.log("\n[2/3] CKAN (contabilização):");
    const nomesCandk = await nomesNoCkan();
    const novos = nomesCandk.filter(n => !nomesNoBanco.has(n.toUpperCase()));
    console.log(`  ${novos.length} agentes novos (não estão no banco)`);

    if (novos.length > 0) {
      console.log("\n  Consultando Power BI para os novos...\n");
      for (let i = 0; i < novos.length; i++) {
        const nome = novos[i];
        process.stdout.write(`  [${String(i+1).padStart(3)}/${novos.length}] ${nome.padEnd(45)} `);
        const meta = await buscarClassePowerBI(nome);
        if (!meta) {
          console.log("⚠  não encontrado");
        } else {
          // Usa SG_AGEN (sigla) como chave do agente — igual à API
          const agenteKey = meta.sigla || nome;
          todos.push({ agente: agenteKey, ...meta, razao_social: meta.razao_social || nome });
          console.log(`✅  ${meta.classe || "?"} | agente: ${agenteKey}`);
        }
        if (i < novos.length - 1) await delay(DELAY_MS);
      }
    }
  } else {
    console.log("\n[2/3] CKAN: pulado (--somente-banco)");
  }

  // 3. Filtra e salva
  console.log("\n[3/3] Salvando...");

  const incluidos  = todos.filter(a => !CLASSES_SKIP.has(a.classe));
  const excluidos  = todos.filter(a => CLASSES_SKIP.has(a.classe));

  // Garante que o diretório existe
  const dir = path.dirname(SAIDA);
  if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const linhas = [
    "# Gerado por descobrir-agentes.js — CCEE Monitor",
    `# Total: ${incluidos.length} agentes | ${excluidos.length} comercializadores excluídos`,
    ...incluidos.map(a => a.agente).sort(),
  ];
  fs.writeFileSync(SAIDA, linhas.join("\n") + "\n", "utf-8");
  console.log(`  ${SAIDA}: ${incluidos.length} agentes`);

  // CSV de info completa (todos, incluindo excluídos, para referência)
  const csvPath = SAIDA.replace(/\.txt$/, "_info.csv");
  const csvLinhas = [
    "agente;classe;razao_social;sigla;cnpj;situacao",
    ...[...incluidos, ...excluidos]
      .sort((a, b) => a.agente.localeCompare(b.agente))
      .map(a => [a.agente, a.classe, a.razao_social, a.sigla, a.cnpj, a.situacao]
        .map(v => `"${(v || "").replace(/"/g, '""')}"`)
        .join(";")
      ),
  ];
  fs.writeFileSync(csvPath, csvLinhas.join("\n") + "\n", "utf-8");
  console.log(`  ${csvPath}: ${incluidos.length + excluidos.length} linhas`);

  console.log("\n" + "═".repeat(60));
  console.log(`  ✅ Incluídos:   ${incluidos.length}`);
  console.log(`  ⏭  Excluídos:  ${excluidos.length} (${excluidos.map(a => a.agente).join(", ")})`);
  console.log(`\n  Próximo passo:`);
  console.log(`    Python : python buscar_dados.py --agentes ${SAIDA}`);
  console.log(`    Node.js: node api/index.js  (usa agentes do banco)`);
}

main()
  .catch(err => { console.error("\nErro:", err.message); process.exit(1); })
  .finally(() => pool.end());
