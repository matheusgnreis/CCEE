// db/migrate-modulacao-geracao-por-usina.js
// Adiciona sigla_usina à ccee_modulacao_geracao para estratificação por unidade geradora.
// Uso: node db/migrate-modulacao-geracao-por-usina.js

require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  console.log("Migrando ccee_modulacao_geracao: adicionando sigla_usina...");

  const { rowCount } = await pool.query("DELETE FROM ccee_modulacao_geracao");
  console.log(`  ${rowCount} registros removidos (serão recalculados por usina)`);

  await pool.query(`ALTER TABLE ccee_modulacao_geracao DROP CONSTRAINT IF EXISTS uniq_modulacao_geracao`);

  await pool.query(`
    ALTER TABLE ccee_modulacao_geracao
      ADD COLUMN IF NOT EXISTS sigla_usina TEXT NOT NULL DEFAULT ''
  `);
  await pool.query(`ALTER TABLE ccee_modulacao_geracao ALTER COLUMN sigla_usina DROP DEFAULT`);

  await pool.query(`
    ALTER TABLE ccee_modulacao_geracao
      ADD CONSTRAINT uniq_modulacao_geracao
      UNIQUE (agente, mes_referencia, sigla_usina, submercado)
  `);

  console.log("✅ Migração concluída.");
  await pool.end();
}

run().catch(err => { console.error("✖", err.message); pool.end(); process.exit(1); });
