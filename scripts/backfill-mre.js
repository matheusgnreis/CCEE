// scripts/backfill-mre.js
// Re-faz fetch Power BI para agentes com resultado salvo mas mre_mais NULL.
// Rate limit: 1 req / 7s (Power BI aceita ~10/min).
require("dotenv").config();
const fetch  = require("node-fetch");
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const API_BASE = process.env.API_BASE || "http://localhost:3001";
const DELAY_MS = 7000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (agente) agente, mes
    FROM ccee_dados
    WHERE mre_mais IS NULL AND resultado IS NOT NULL
    ORDER BY agente, mes DESC
  `);

  console.log(`${rows.length} agentes para atualizar\n`);

  for (let i = 0; i < rows.length; i++) {
    const { agente, mes } = rows[i];
    const encoded = encodeURIComponent(agente);
    const url     = `${API_BASE}/inteligencia/${encoded}?mes=${mes}&refresh=true`;

    process.stdout.write(`[${i + 1}/${rows.length}] ${agente} (${mes})... `);
    try {
      const r    = await fetch(url, { timeout: 20000 });
      const json = await r.json();
      if (json.error) throw new Error(json.error);
      const mre = json.mre_mais != null ? `MRE+=${json.mre_mais}` : "MRE+=null";
      console.log(`✅ ${mre}`);
    } catch (e) {
      console.log(`❌ ${e.message}`);
    }

    if (i < rows.length - 1) await sleep(DELAY_MS);
  }

  console.log("\nConcluído.");
  await pool.end();
}

run().catch(err => { console.error(err.message); pool.end(); process.exit(1); });
