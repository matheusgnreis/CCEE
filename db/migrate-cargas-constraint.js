// db/migrate-cargas-constraint.js
// Adiciona agente à constraint única de ccee_cargas para permitir que dois agentes
// distintos tenham as mesmas sigla_parcela_carga (ex: SUPER BH 001 e SUPERMERCADOS BH ATAC1).
// Uso: node db/migrate-cargas-constraint.js

require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  console.log("Migrando constraint de ccee_cargas...");

  await pool.query(`ALTER TABLE ccee_cargas DROP CONSTRAINT IF EXISTS uniq_carga_mes`);
  console.log("  Constraint antiga removida.");

  await pool.query(`
    ALTER TABLE ccee_cargas
    ADD CONSTRAINT uniq_carga_agente_mes
    UNIQUE (agente, sigla_parcela_carga, mes_referencia)
  `);
  console.log("  Nova constraint criada: (agente, sigla_parcela_carga, mes_referencia).");

  console.log("✅ Migração concluída.");
  await pool.end();
}

run().catch(err => { console.error("✖", err.message); pool.end(); process.exit(1); });
