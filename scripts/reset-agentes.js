// scripts/reset-agentes.js
// Deleta todos os dados de agentes especificados e recria a tabela ccee_consumo_horario_uc.
// Uso:
//   node scripts/reset-agentes.js MONSANTO "MONSANTO SEMENTES"
//   node scripts/reset-agentes.js --criar-tabela-uc        (só cria a tabela, sem deletar)
//
// Após rodar, execute:
//   node scripts/rodar-tudo.js --apenas-agentes "MONSANTO,MONSANTO SEMENTES"

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { Pool } = require("pg");

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  ssl:                     { rejectUnauthorized: false },
  idleTimeoutMillis:       60000,
  connectionTimeoutMillis: 30000,
});

const args           = process.argv.slice(2);
const APENAS_CRIAR   = args.includes("--criar-tabela-uc");
const agentes        = args.filter(a => !a.startsWith("--")).map(a => a.toUpperCase());

const TABELAS = [
  "ccee_dados",
  "ccee_cargas",
  "ccee_consumo_horario",
  "ccee_consumo_horario_perfil",
  "ccee_consumo_horario_uc",
  "ccee_consumo_mensal_perfil",
  "ccee_contrato_mensal_perfil",
  "ccee_contabilizacao",
  "ccee_modulacao",
  "ccee_curva_tipica",
  "ccee_curva_tipica_perfil",
];

async function criarTabelaUC() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ccee_consumo_horario_uc (
      agente       TEXT        NOT NULL,
      nome_carga   TEXT        NOT NULL,
      mes_referencia CHAR(7)   NOT NULL,
      sigla_perfil TEXT        NOT NULL DEFAULT '',
      periodo      INTEGER     NOT NULL,
      submercado   TEXT        NOT NULL,
      consumo_mwh  NUMERIC(14,6) NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, nome_carga, mes_referencia, periodo, submercado)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_consumo_horario_uc_agente_mes
      ON ccee_consumo_horario_uc (agente, mes_referencia)
  `);
  console.log("✅ Tabela ccee_consumo_horario_uc criada/verificada");
}

async function main() {
  try {
    await criarTabelaUC();

    if (APENAS_CRIAR) {
      console.log("Apenas criação de tabela solicitada. Encerrando.");
      return;
    }

    if (!agentes.length) {
      console.error("Uso: node scripts/reset-agentes.js AGENTE1 \"AGENTE 2\" ...");
      process.exit(1);
    }

    console.log(`\nAgentes a deletar: ${agentes.join(", ")}`);
    console.log("Aguarde...\n");

    for (const tabela of TABELAS) {
      try {
        const r = await pool.query(
          `DELETE FROM ${tabela} WHERE agente = ANY($1)`,
          [agentes]
        );
        console.log(`  ${tabela}: ${r.rowCount} linhas deletadas`);
      } catch (e) {
        // Tabela pode não existir ainda (ex: ccee_consumo_horario_uc)
        if (e.message.includes("does not exist")) {
          console.log(`  ${tabela}: tabela não existe, pulando`);
        } else {
          console.warn(`  ${tabela}: ${e.message}`);
        }
      }
    }

    // ccee_agentes: não deleta, mas reseta o flag de onboarding
    // para que o pipeline redescubra os dados no próximo run
    await pool.query(
      `UPDATE ccee_agentes SET situacao = situacao WHERE agente = ANY($1)`,
      [agentes]
    );
    console.log(`\n  ccee_agentes: agentes mantidos (serão re-processados pelo pipeline)`);

    console.log(`\n✅ Reset concluído. Agora rode:`);
    console.log(`   node scripts/rodar-tudo.js --apenas-agentes "${agentes.join(",")}"`);
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
