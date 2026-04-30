// db/migrate-geracao-por-usina.js
// Adiciona coluna sigla_usina à ccee_geracao_horaria para permitir curva por unidade geradora.
// Uso: node db/migrate-geracao-por-usina.js

require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  console.log("Migrando ccee_geracao_horaria: adicionando sigla_usina...");

  // 1. Apaga dados existentes (serão re-baixados com nova estrutura)
  const { rowCount } = await pool.query("DELETE FROM ccee_geracao_horaria");
  console.log(`  ${rowCount} linhas removidas (serão re-baixadas com sigla_usina)`);

  // 2. Remove constraint única antiga
  await pool.query(`
    ALTER TABLE ccee_geracao_horaria
      DROP CONSTRAINT IF EXISTS uniq_geracao_horaria
  `);

  // 3. Adiciona coluna sigla_usina
  await pool.query(`
    ALTER TABLE ccee_geracao_horaria
      ADD COLUMN IF NOT EXISTS sigla_usina TEXT NOT NULL DEFAULT ''
  `);

  // 4. Remove o default após adicionar
  await pool.query(`
    ALTER TABLE ccee_geracao_horaria
      ALTER COLUMN sigla_usina DROP DEFAULT
  `);

  // 5. Cria nova constraint incluindo sigla_usina
  await pool.query(`
    ALTER TABLE ccee_geracao_horaria
      ADD CONSTRAINT uniq_geracao_horaria
      UNIQUE (agente, mes_referencia, periodo, submercado, sigla_usina)
  `);

  // 6. Apaga modulação de geração (precisa recalcular com dados corretos)
  const { rowCount: modCount } = await pool.query("DELETE FROM ccee_modulacao_geracao");
  console.log(`  ${modCount} registros de modulação removidos (serão recalculados)`);

  console.log("✅ Migração concluída.");
  await pool.end();
}

run().catch(err => { console.error("✖", err.message); pool.end(); process.exit(1); });
