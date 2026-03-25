require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log("🚀 criando banco...");

  // 🔥 tabela
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ccee_dados (
      id SERIAL PRIMARY KEY,
      agente TEXT,
      cnpj TEXT,
      tipo_consumidor TEXT,
      aderido TEXT,
      balanco_energetico NUMERIC,
      consumo NUMERIC,
      compra NUMERIC,
      mcp NUMERIC,
      resultado NUMERIC,
      resultado_mcp NUMERIC,
      mes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // 🔥 constraint (MELHOR QUE INDEX)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'uniq_agente_mes'
      ) THEN
        ALTER TABLE ccee_dados
        ADD CONSTRAINT uniq_agente_mes UNIQUE (agente, mes);
      END IF;
    END
    $$;
  `);

  console.log("✅ banco pronto");
  process.exit();
}

run();