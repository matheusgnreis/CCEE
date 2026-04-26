// db/reset.js — apaga e recria todas as tabelas a partir do schema.sql
// Uso: node db/reset.js

require("dotenv").config();
const { Pool } = require("pg");
const fs       = require("fs");
const path     = require("path");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  console.log("Resetando banco de dados...");
  await pool.query(sql);
  console.log("✅ Banco resetado com sucesso.");
  await pool.end();
}

run().catch(err => {
  console.error("✖ Erro:", err.message);
  process.exit(1);
});
