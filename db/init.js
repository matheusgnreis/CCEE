require("dotenv").config();
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

  console.log("Resetando banco...");
  await pool.query(sql);
  console.log("Banco recriado com sucesso.");

  await pool.end();
}

run().catch(err => {
  console.error("Erro:", err.message);
  process.exit(1);
});
