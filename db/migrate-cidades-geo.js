// db/migrate-cidades-geo.js
// Cria tabela ccee_cidades_geo para armazenar lat/lon das cidades do banco
// Uso: node db/migrate-cidades-geo.js

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ccee_cidades_geo (
      cidade    TEXT    NOT NULL,
      estado_uf CHAR(2) NOT NULL,
      lat       DOUBLE PRECISION,
      lon       DOUBLE PRECISION,
      geocoded_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (cidade, estado_uf)
    )
  `);
  console.log("✅ Tabela ccee_cidades_geo criada (ou já existia).");
  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
