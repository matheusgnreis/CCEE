// db/migrate-contabilizacao.js
// Adiciona tabela de contabilização por perfil de agente.
// Uso: node db/migrate-contabilizacao.js

require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  console.log("Aplicando migração: ccee_contabilizacao...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ccee_contabilizacao (
      id                         SERIAL      PRIMARY KEY,
      agente                     TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
      mes_referencia             CHAR(7)     NOT NULL CHECK (mes_referencia ~ '^\\d{4}-\\d{2}$'),
      sigla_perfil_agente        TEXT        NOT NULL,
      nome_empresarial           TEXT,
      cod_perf_agente            INTEGER,
      valor_tm_mcp               NUMERIC,
      compensacao_mre            NUMERIC,
      valor_encargo              NUMERIC,
      valor_ajuste_exposicao     NUMERIC,
      valor_ajuste_alivio_ret    NUMERIC,
      efeito_contrat_disp        NUMERIC,
      efeito_contrat_cota_gf     NUMERIC,
      efeito_contrat_nuclear     NUMERIC,
      ajuste_recontab            NUMERIC,
      ajuste_mcsd_ex             NUMERIC,
      resultado_financeiro_er    NUMERIC,
      efeito_ccearq              NUMERIC,
      efeito_contrat_itaipu      NUMERIC,
      efeito_repasse_risco_hidro NUMERIC,
      efeito_desloc_pld_cmo      NUMERIC,
      resultado_final            NUMERIC,
      created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uniq_contabilizacao UNIQUE (agente, mes_referencia, sigla_perfil_agente)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cont_agente ON ccee_contabilizacao (agente)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cont_mes    ON ccee_contabilizacao (mes_referencia)`);

  console.log("✅ Migração aplicada. Dados existentes preservados.");
  await pool.end();
}

run().catch(err => {
  console.error("✖ Erro:", err.message);
  process.exit(1);
});
