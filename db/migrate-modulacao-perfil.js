// db/migrate-modulacao-perfil.js
require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  console.log("Criando ccee_modulacao_perfil...");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ccee_modulacao_perfil (
      id                     SERIAL      PRIMARY KEY,
      agente                 TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
      mes_referencia         CHAR(7)     NOT NULL CHECK (mes_referencia ~ '^\\d{4}-\\d{2}$'),
      sigla_perfil           TEXT        NOT NULL,
      submercado             TEXT        NOT NULL,
      consumo_total_mwh      NUMERIC     NOT NULL,
      n_horas                INTEGER     NOT NULL,
      soma_curva_rs          NUMERIC     NOT NULL,
      soma_flat_rs           NUMERIC     NOT NULL,
      custo_modulacao_rs_mwh NUMERIC     NOT NULL,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uniq_modulacao_perfil UNIQUE (agente, mes_referencia, sigla_perfil, submercado)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_modp_agente ON ccee_modulacao_perfil (agente)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_modp_mes    ON ccee_modulacao_perfil (mes_referencia)`);
  console.log("✅ Tabela criada.");
  await pool.end();
}

run().catch(err => { console.error("✖", err.message); pool.end(); process.exit(1); });
