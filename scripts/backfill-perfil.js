// scripts/backfill-perfil.js
// Identifica agentes com consumo mensal (ccee_consumo_horario) mas sem dados
// por perfil (ccee_consumo_horario_perfil) para meses >= PRIMEIRO_MES,
// e deleta o consumo + modulação para forçar re-download completo via batch.
//
// Uso: node scripts/backfill-perfil.js
//      (depois rode: node scripts/rodar-modulacao-batch.js)

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { Pool } = require("pg");

const PRIMEIRO_MES = "2025-01";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log(`\n🔍 Identificando agentes com dados de consumo mas sem dados por perfil (>= ${PRIMEIRO_MES})...\n`);

  // Agentes que têm consumo horário mas NÃO têm consumo por perfil
  const r = await pool.query(`
    SELECT DISTINCT ch.agente, ch.mes_referencia
    FROM ccee_consumo_horario ch
    WHERE ch.mes_referencia >= $1
      AND NOT EXISTS (
        SELECT 1 FROM ccee_consumo_horario_perfil cp
        WHERE cp.agente = ch.agente AND cp.mes_referencia = ch.mes_referencia
      )
    ORDER BY ch.agente, ch.mes_referencia
  `, [PRIMEIRO_MES]);

  if (!r.rows.length) {
    console.log("✅ Nenhum agente precisa de backfill. Todos já têm dados por perfil.\n");
    await pool.end();
    return;
  }

  // Agrupa por agente para exibir resumo
  const porAgente = {};
  for (const { agente, mes_referencia } of r.rows) {
    (porAgente[agente] = porAgente[agente] || []).push(mes_referencia);
  }

  console.log(`📋 ${r.rows.length} combinações agente×mês precisam de backfill:\n`);
  for (const [agente, meses] of Object.entries(porAgente)) {
    console.log(`  ${agente}: ${meses.join(", ")}`);
  }

  console.log(`\n🗑  Deletando consumo e modulação para forçar re-processamento...`);

  let deletados = 0;
  for (const { agente, mes_referencia } of r.rows) {
    await Promise.all([
      pool.query("DELETE FROM ccee_consumo_horario        WHERE agente = $1 AND mes_referencia = $2", [agente, mes_referencia]),
      pool.query("DELETE FROM ccee_modulacao              WHERE agente = $1 AND mes_referencia = $2", [agente, mes_referencia]),
      pool.query("DELETE FROM ccee_consumo_horario_perfil WHERE agente = $1 AND mes_referencia = $2", [agente, mes_referencia]),
      pool.query("DELETE FROM ccee_modulacao_perfil       WHERE agente = $1 AND mes_referencia = $2", [agente, mes_referencia]),
    ]);
    deletados++;
  }

  console.log(`\n✅ ${deletados} meses limpos.`);
  console.log(`\n▶  Agora rode:`);
  console.log(`   node scripts/rodar-modulacao-batch.js\n`);
  await pool.end();
}

main().catch(async e => {
  console.error("Erro:", e.message);
  await pool.end();
  process.exit(1);
});
