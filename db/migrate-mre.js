// db/migrate-mre.js
// Adiciona colunas mre_mais e mre_menos (MWm) em ccee_dados.
require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  console.log("Adicionando colunas mre_mais e mre_menos em ccee_dados...");
  await pool.query(`ALTER TABLE ccee_dados ADD COLUMN IF NOT EXISTS mre_mais  NUMERIC`);
  await pool.query(`ALTER TABLE ccee_dados ADD COLUMN IF NOT EXISTS mre_menos NUMERIC`);
  console.log("✅ Colunas criadas.");
  await pool.end();
}

run().catch(err => { console.error("✖", err.message); pool.end(); process.exit(1); });
