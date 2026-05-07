// db/migrate-mcp-rs-mwh.js
// Adiciona coluna mcp_rs_mwh (R$/MWh) em ccee_dados e popula retroativamente.
require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  console.log("Adicionando coluna mcp_rs_mwh em ccee_dados...");
  await pool.query(`
    ALTER TABLE ccee_dados
    ADD COLUMN IF NOT EXISTS mcp_rs_mwh NUMERIC
  `);
  console.log("✅ Coluna criada.");

  // Popula retroativamente para todos os meses com consumo > 0
  // horas_do_mes = dias_do_mes × 24, calculado via date arithmetic do Postgres
  console.log("Populando mcp_rs_mwh retroativamente...");
  const { rowCount } = await pool.query(`
    UPDATE ccee_dados
    SET mcp_rs_mwh = ROUND(
      mcp / NULLIF(
        consumo * EXTRACT(days FROM (
          DATE_TRUNC('month', (mes || '-01')::date) + INTERVAL '1 month'
          - DATE_TRUNC('month', (mes || '-01')::date)
        )) * 24,
      0),
      4
    )
    WHERE consumo IS NOT NULL AND consumo > 0 AND mcp IS NOT NULL AND mcp_rs_mwh IS NULL
  `);
  console.log(`✅ ${rowCount} linha(s) atualizadas.`);

  await pool.end();
}

run().catch(err => { console.error("✖", err.message); pool.end(); process.exit(1); });
