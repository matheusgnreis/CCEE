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

async function resourceMaisRecente(seed) {
  const resData = await fetch(`${CKAN_BASE}/resource_show?id=${seed}`,
    { headers: { "User-Agent": USER_AGENT } }).then(r => r.json());
  const pkgId   = resData.result.package_id;
  const pkgData = await fetch(`${CKAN_BASE}/package_show?id=${pkgId}`,
    { headers: { "User-Agent": USER_AGENT } }).then(r => r.json());
  let melhorAno = -1, melhorId = seed;
  for (const res of pkgData.result?.resources || []) {
    const m = (res.name + " " + (res.description || "")).match(/\b(20\d{2})\b/);
    if (m && Number(m[1]) > melhorAno) { melhorAno = Number(m[1]); melhorId = res.id; }
  }
  console.log(`  CKAN: usando resource do ano ${melhorAno}`);
  return melhorId;
}

async function nomesNoCkan() {
  const resourceId = await resourceMaisRecente(SEED_CONTAB);
  const sql = `SELECT DISTINCT "NOME_EMPRESARIAL" FROM "${resourceId}" WHERE "NOME_EMPRESARIAL" IS NOT NULL ORDER BY "NOME_EMPRESARIAL"`;
  const url = `${CKAN_BASE}/datastore_search_sql?sql=${encodeURIComponent(sql)}`;
  const data = await fetch(url, { headers: { "User-Agent": USER_AGENT } }).then(r => r.json());
  if (!data.success) throw new Error(`CKAN SQL: ${JSON.stringify(data.error)}`);
  const nomes = data.result.records.map(r => r.NOME_EMPRESARIAL?.trim()).filter(Boolean);
  console.log(`  CKAN: ${nomes.length} nomes distintos na contabilização`);
  return nomes;
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
            { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Tipo"        } }], Values: [[{ Literal: { Value: "'Agente'"         } }]] } } },
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
          todos.push({ agente: nome, ...meta });
          console.log(`✅  ${meta.classe || "?"}`);
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
