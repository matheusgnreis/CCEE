// db/migrate-desligamento.js
require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  console.log("Criando tabela ccee_desligamento...");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ccee_desligamento (
      id                     SERIAL      PRIMARY KEY,
      agente                 TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
      sigla                  TEXT,
      cnpj                   TEXT,
      classe                 TEXT,
      status                 TEXT,
      data_desligamento      DATE,
      inicio_monitoramento   DATE,
      fim_monitoramento      DATE,
      reuniao_cad            TEXT,
      suspensao_fornecimento DATE,
      tipos_descumprimentos  TEXT,
      caucionamento          TEXT,
      tipo_desligamento      TEXT,
      data_publicacao        DATE,
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uniq_deslig_agente UNIQUE (agente)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deslig_status ON ccee_desligamento (status)`);
  console.log("✅ Tabela criada.");
  await pool.end();
}

run().catch(err => { console.error("✖", err.message); pool.end(); process.exit(1); });
