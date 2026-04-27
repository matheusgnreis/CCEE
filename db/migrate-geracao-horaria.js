// db/migrate-geracao-horaria.js
// Adiciona tabelas de geração horária e modulação de geração.
// Uso: node db/migrate-geracao-horaria.js

require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  console.log("Aplicando migração: ccee_geracao_horaria + ccee_modulacao_geracao...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ccee_geracao_horaria (
      id             SERIAL      PRIMARY KEY,
      agente         TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
      mes_referencia CHAR(7)     NOT NULL CHECK (mes_referencia ~ '^\\d{4}-\\d{2}$'),
      periodo        INTEGER     NOT NULL,
      submercado     TEXT        NOT NULL,
      geracao_mwmed  NUMERIC     NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uniq_geracao_horaria UNIQUE (agente, mes_referencia, periodo, submercado)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gh_agente     ON ccee_geracao_horaria (agente)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gh_mes        ON ccee_geracao_horaria (mes_referencia)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gh_submercado ON ccee_geracao_horaria (submercado)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ccee_modulacao_geracao (
      id                     SERIAL      PRIMARY KEY,
      agente                 TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
      mes_referencia         CHAR(7)     NOT NULL CHECK (mes_referencia ~ '^\\d{4}-\\d{2}$'),
      submercado             TEXT        NOT NULL,
      geracao_total_mwh      NUMERIC     NOT NULL,
      n_horas                INTEGER     NOT NULL,
      soma_curva_rs          NUMERIC     NOT NULL,
      soma_flat_rs           NUMERIC     NOT NULL,
      custo_modulacao_rs_mwh NUMERIC     NOT NULL,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uniq_modulacao_geracao UNIQUE (agente, mes_referencia, submercado)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_modg_agente ON ccee_modulacao_geracao (agente)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_modg_mes    ON ccee_modulacao_geracao (mes_referencia)`);

  console.log("✅ Migração aplicada. Dados existentes preservados.");
  await pool.end();
}

run().catch(err => {
  console.error("✖ Erro:", err.message);
  process.exit(1);
});
