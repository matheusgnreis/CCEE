// db/migrar-curva-tipica.js
// Migração one-time:
//   1. Cria ccee_curva_tipica e ccee_curva_tipica_perfil (se não existirem)
//   2. Popula a partir de ccee_consumo_horario / ccee_consumo_horario_perfil
//   3. Deleta o dado horário bruto para meses que já têm modulação calculada
//
// Uso: node db/migrar-curva-tipica.js
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  console.log("=== Migração: ccee_curva_tipica ===\n");

  // ── 1. Cria tabelas se não existirem ────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ccee_curva_tipica (
      agente       TEXT    NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
      submercado   TEXT    NOT NULL,
      hora         INTEGER NOT NULL,
      consumo_med  NUMERIC NOT NULL,
      n_amostras   INTEGER NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, submercado, hora)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ct_agente ON ccee_curva_tipica (agente)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ccee_curva_tipica_perfil (
      agente       TEXT    NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
      sigla_perfil TEXT    NOT NULL,
      hora         INTEGER NOT NULL,
      consumo_med  NUMERIC NOT NULL,
      n_amostras   INTEGER NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, sigla_perfil, hora)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ctp_agente ON ccee_curva_tipica_perfil (agente)`);
  console.log("✔ Tabelas criadas (ou já existiam)");

  // ── 2. Lista agentes com dado bruto ─────────────────────────────────────────
  const { rows: agentes } = await pool.query(
    "SELECT DISTINCT agente FROM ccee_consumo_horario ORDER BY agente"
  );
  console.log(`\nAgentes com dados brutos: ${agentes.length}`);

  let i = 0;
  for (const { agente } of agentes) {
    i++;
    process.stdout.write(`  [${i}/${agentes.length}] ${agente}...`);

    await pool.query(`
      INSERT INTO ccee_curva_tipica (agente, submercado, hora, consumo_med, n_amostras, updated_at)
      SELECT
        $1,
        submercado,
        ((periodo - 1) % 24) + 1 AS hora,
        AVG(consumo_mwh),
        COUNT(*),
        NOW()
      FROM ccee_consumo_horario
      WHERE agente = $1
      GROUP BY submercado, hora
      ON CONFLICT (agente, submercado, hora) DO UPDATE
        SET consumo_med = EXCLUDED.consumo_med,
            n_amostras  = EXCLUDED.n_amostras,
            updated_at  = NOW()
    `, [agente]);

    await pool.query(`
      INSERT INTO ccee_curva_tipica_perfil (agente, sigla_perfil, hora, consumo_med, n_amostras, updated_at)
      SELECT
        $1,
        sigla_perfil,
        ((periodo - 1) % 24) + 1 AS hora,
        AVG(consumo_mwh),
        COUNT(*),
        NOW()
      FROM ccee_consumo_horario_perfil
      WHERE agente = $1
      GROUP BY sigla_perfil, hora
      ON CONFLICT (agente, sigla_perfil, hora) DO UPDATE
        SET consumo_med = EXCLUDED.consumo_med,
            n_amostras  = EXCLUDED.n_amostras,
            updated_at  = NOW()
    `, [agente]);

    process.stdout.write(" curva ok\n");
  }

  // ── 3. Deleta bruto para meses com modulação já calculada ───────────────────
  console.log("\nDeletando dados brutos para meses já modulados...");

  const { rowCount: delCH } = await pool.query(`
    DELETE FROM ccee_consumo_horario ch
    WHERE EXISTS (
      SELECT 1 FROM ccee_modulacao m
      WHERE m.agente = ch.agente AND m.mes_referencia = ch.mes_referencia
    )
  `);

  const { rowCount: delCHP } = await pool.query(`
    DELETE FROM ccee_consumo_horario_perfil chp
    WHERE EXISTS (
      SELECT 1 FROM ccee_modulacao m
      WHERE m.agente = chp.agente AND m.mes_referencia = chp.mes_referencia
    )
  `);

  console.log(`  Removido de ccee_consumo_horario:        ${delCH} linhas`);
  console.log(`  Removido de ccee_consumo_horario_perfil: ${delCHP} linhas`);

  // ── 4. Tamanho final das tabelas ─────────────────────────────────────────────
  const { rows: sizes } = await pool.query(`
    SELECT table_name,
           pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) AS tamanho
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'ccee_consumo_horario','ccee_consumo_horario_perfil',
        'ccee_curva_tipica','ccee_curva_tipica_perfil'
      )
    ORDER BY pg_total_relation_size(quote_ident(table_name)) DESC
  `);
  console.log("\nTamanhos após migração:");
  sizes.forEach(r => console.log(`  ${r.table_name.padEnd(35)} ${r.tamanho}`));

  await pool.end();
  console.log("\n✅ Migração concluída.");
}

run().catch(async e => {
  console.error("Erro:", e.message);
  await pool.end();
  process.exit(1);
});
