require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log("Aplicando migração: tabela ccee_cargas...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ccee_cargas (
      id                            SERIAL       PRIMARY KEY,
      agente                        TEXT         NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
      sigla_perfil_agente           TEXT         NOT NULL,
      mes_referencia                CHAR(7)      NOT NULL CHECK (mes_referencia ~ '^\\d{4}-\\d{2}$'),
      cod_perf_agente               TEXT,
      nome_empresarial              TEXT,
      cod_parcela_carga             TEXT,
      sigla_parcela_carga           TEXT,
      cnpj_carga                    TEXT,
      cidade                        TEXT,
      estado_uf                     CHAR(2),
      ramo_atividade                TEXT,
      submercado                    TEXT,
      data_migracao                 DATE,
      cod_perf_agente_conectado     TEXT,
      sigla_perfil_agente_conectado TEXT,
      capacidade_carga              NUMERIC,
      consumo_acl                   NUMERIC,
      consumo_cativo_parc_livre     NUMERIC,
      consumo_total                 NUMERIC,
      created_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT uniq_carga_mes UNIQUE (sigla_parcela_carga, mes_referencia)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ccee_cargas_agente     ON ccee_cargas (agente)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ccee_cargas_mes        ON ccee_cargas (mes_referencia)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ccee_cargas_estado     ON ccee_cargas (estado_uf)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ccee_cargas_cidade     ON ccee_cargas (cidade)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ccee_cargas_ramo       ON ccee_cargas (ramo_atividade)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ccee_cargas_submercado ON ccee_cargas (submercado)`);

  console.log("Migração aplicada com sucesso. Dados existentes preservados.");
  await pool.end();
}

run().catch(err => {
  console.error("Erro na migração:", err.message);
  process.exit(1);
});
