// scripts/corrigir-cargas-irmaos.js
// Encontra grupos de agentes com mesmo NOME_EMPRESARIAL (irmãos) que têm
// mapeamento em ccee_agente_perfis, e corrige cargas salvas no agente errado.
//
// Uso: node scripts/corrigir-cargas-irmaos.js [--dry-run]

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { Pool } = require("pg");

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  ssl:                     { rejectUnauthorized: false },
  idleTimeoutMillis:       60000,
  connectionTimeoutMillis: 30000,
});

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log("🔧 CORRIGIR CARGAS — agentes irmãos com NOME_EMPRESARIAL compartilhado");
  if (DRY_RUN) console.log("   (modo --dry-run: nenhuma alteração será feita)");
  console.log("═".repeat(60));

  // 1. Busca grupos com mais de 1 agente na mesma razão social
  const { rows: grupos } = await pool.query(`
    SELECT
      TRIM(UPPER(a.razao_social)) AS nome,
      array_agg(a.agente ORDER BY a.agente) AS agentes
    FROM ccee_agentes a
    WHERE COALESCE(TRIM(a.razao_social), '') != ''
    GROUP BY TRIM(UPPER(a.razao_social))
    HAVING COUNT(*) > 1
  `);

  if (!grupos.length) {
    console.log("\nNenhum grupo de irmãos encontrado.");
    await pool.end();
    return;
  }

  console.log(`\n${grupos.length} grupo(s) com múltiplos agentes:\n`);

  let totalCorrigidas = 0;

  for (const { nome, agentes } of grupos) {
    console.log(`\n━━ ${nome}`);
    console.log(`   Agentes: ${agentes.join(", ")}`);

    // 2. Busca mapeamento cod_perf_agente → agente correto
    const { rows: perfisRows } = await pool.query(
      `SELECT agente, cod_perf_agente
         FROM ccee_agente_perfis
        WHERE agente = ANY($1)`,
      [agentes]
    );

    if (!perfisRows.length) {
      console.log("   ⚠  Sem mapeamento em ccee_agente_perfis — pulando");
      continue;
    }

    const perfToAgente = new Map(perfisRows.map(r => [r.cod_perf_agente, r.agente]));

    // 3. Busca cargas do grupo inteiro (todos os agentes)
    const { rows: cargasRows } = await pool.query(
      `SELECT agente, cod_perf_agente, mes_referencia, sigla_parcela_carga
         FROM ccee_cargas
        WHERE agente = ANY($1) AND cod_perf_agente IS NOT NULL`,
      [agentes]
    );

    // 4. Identifica as que estão no agente errado
    const erradas = cargasRows.filter(c => {
      const correto = perfToAgente.get(c.cod_perf_agente);
      return correto && correto !== c.agente;
    });

    if (!erradas.length) {
      console.log("   ✅ Cargas corretamente distribuídas");
      continue;
    }

    // Agrupa por (agente_errado → agente_correto)
    const porPar = {};
    for (const c of erradas) {
      const correto = perfToAgente.get(c.cod_perf_agente);
      const key = `${c.agente} → ${correto}`;
      if (!porPar[key]) porPar[key] = 0;
      porPar[key]++;
    }
    for (const [par, n] of Object.entries(porPar)) {
      console.log(`   ⚠  ${n} cargas erradas: ${par}`);
    }

    if (DRY_RUN) {
      console.log("   ↳ dry-run: nenhuma alteração feita");
      continue;
    }

    // 5. Corrige: re-atribui cada carga para o agente correto
    for (const c of erradas) {
      const correto = perfToAgente.get(c.cod_perf_agente);
      // Tenta inserir no agente correto, depois deleta do errado
      try {
        await pool.query(
          `UPDATE ccee_cargas SET agente = $1
            WHERE agente = $2
              AND cod_perf_agente = $3
              AND mes_referencia  = $4
              AND sigla_parcela_carga = $5`,
          [correto, c.agente, c.cod_perf_agente, c.mes_referencia, c.sigla_parcela_carga]
        );
      } catch (e) {
        // Conflito: já existe no agente correto — deleta do errado
        if (e.code === "23505") {
          await pool.query(
            `DELETE FROM ccee_cargas
              WHERE agente = $1
                AND cod_perf_agente = $2
                AND mes_referencia  = $3
                AND sigla_parcela_carga = $4`,
            [c.agente, c.cod_perf_agente, c.mes_referencia, c.sigla_parcela_carga]
          );
        } else {
          console.warn(`   Erro ao corrigir ${c.sigla_parcela_carga}: ${e.message}`);
        }
      }
    }
    totalCorrigidas += erradas.length;
    console.log(`   ✅ ${erradas.length} cargas corrigidas`);
  }

  console.log(`\n${"─".repeat(60)}`);
  if (DRY_RUN) {
    console.log("dry-run concluído — nenhuma alteração foi feita");
  } else {
    console.log(`Total de cargas corrigidas: ${totalCorrigidas}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
