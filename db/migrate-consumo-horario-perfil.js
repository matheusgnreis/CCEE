// db/migrate-consumo-horario-perfil.js
// Cria tabela de consumo horário por perfil de agente (SIGLA_PERFIL_AGENTE).
// Uso: node db/migrate-consumo-horario-perfil.js

require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  console.log("Criando ccee_consumo_horario_perfil...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ccee_consumo_horario_perfil (
      id               SERIAL      PRIMARY KEY,
      agente           TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
      mes_referencia   CHAR(7)     NOT NULL CHECK (mes_referencia ~ '^\\d{4}-\\d{2}$'),
      sigla_perfil     TEXT        NOT NULL,
      periodo          INTEGER     NOT NULL,
      submercado       TEXT        NOT NULL,
      consumo_mwh      NUMERIC     NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uniq_consumo_perfil UNIQUE (agente, mes_referencia, sigla_perfil, periodo, submercado)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chp_agente ON ccee_consumo_horario_perfil (agente)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chp_mes    ON ccee_consumo_horario_perfil (mes_referencia)`);

  console.log("✅ Tabela criada.");
  await pool.end();
}

run().catch(err => { console.error("✖", err.message); pool.end(); process.exit(1); });
