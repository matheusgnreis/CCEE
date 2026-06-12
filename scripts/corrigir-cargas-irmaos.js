// scripts/corrigir-cargas-irmaos.js
// Encontra grupos de agentes com mesmo NOME_EMPRESARIAL (irmãos) que têm
// mapeamento em ccee_agente_perfis, e corrige dados salvos no agente errado.
//
// Tabelas corrigidas:
//   - ccee_cargas              (cargas físicas)
//   - ccee_consumo_horario_perfil
//   - ccee_consumo_horario_uc
//   - ccee_modulacao_uc
//
// Uso: node scripts/corrigir-cargas-irmaos.js [--dry-run]

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { Pool } = require("pg");
const fs   = require("fs");
const path = require("path");

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  ssl:                     { rejectUnauthorized: false },
  idleTimeoutMillis:       60000,
  connectionTimeoutMillis: 30000,
});

const DRY_RUN = process.argv.includes("--dry-run");

let logStream = null;
let outFile   = null;
if (DRY_RUN) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  outFile  = path.join(__dirname, `../logs/dry-run-cargas-irmaos-${ts}.txt`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  logStream = fs.createWriteStream(outFile, { flags: "w" });
}

function logFile(line) {
  if (logStream) logStream.write(line + "\n");
}

function log(line) {
  console.log(line);
  logFile(line);
}

// ─── Corrige uma tabela genérica por (agente_errado, cod_perf_agente) ─────────
//
// dry-run: retorna contagem de linhas afetadas
// real:    DELETE duplicatas no destino + UPDATE agente
//
// pkCols: colunas da PK exceto "agente"

async function contarErradas(tabela, pkCols, errado, correto, codPerf) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n FROM ${tabela}
      WHERE agente = $1 AND cod_perf_agente = $2`,
    [errado, codPerf]
  );
  return parseInt(rows[0].n, 10);
}

async function corrigirTabela(tabela, pkCols, errado, correto, codPerf) {
  // 1. Remove do destino as linhas que colidiriam (duplicadas)
  const pkList = pkCols.join(", ");
  await pool.query(
    `DELETE FROM ${tabela}
      WHERE agente = $1
        AND (${pkList}) IN (
          SELECT ${pkList} FROM ${tabela}
          WHERE agente = $2 AND cod_perf_agente = $3
        )`,
    [correto, errado, codPerf]
  );

  // 2. Move linhas do agente errado para o correto
  const { rowCount } = await pool.query(
    `UPDATE ${tabela} SET agente = $1
      WHERE agente = $2 AND cod_perf_agente = $3`,
    [correto, errado, codPerf]
  );
  return rowCount;
}

// ─── Tabelas a corrigir ───────────────────────────────────────────────────────

const TABELAS = [
  {
    nome:    "ccee_cargas",
    pkCols:  ["cod_perf_agente", "mes_referencia", "sigla_parcela_carga"],
    label:   "cargas",
  },
  {
    nome:    "ccee_consumo_horario_perfil",
    pkCols:  ["mes_referencia", "sigla_perfil", "periodo", "submercado"],
    label:   "consumo horário por perfil",
  },
  {
    nome:    "ccee_consumo_horario_uc",
    pkCols:  ["nome_carga", "mes_referencia", "periodo", "submercado"],
    label:   "consumo horário por UC",
  },
  {
    nome:    "ccee_modulacao_uc",
    pkCols:  ["nome_carga", "mes_referencia", "submercado"],
    label:   "modulação por UC",
  },
];

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log("CORRIGIR IRMÃOS — agentes com NOME_EMPRESARIAL compartilhado");
  if (DRY_RUN) console.log("   (modo --dry-run: nenhuma alteração será feita)");
  console.log("═".repeat(60));

  // 1. Grupos com mais de 1 agente na mesma razão social
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

  console.log(`\n${grupos.length} grupo(s) com múltiplos agentes analisados...\n`);

  let gruposComProblema = 0;
  let totalMovidas = 0;

  for (const { nome, agentes } of grupos) {
    // 2. Mapeamento cod_perf_agente → agente correto
    const { rows: perfisRows } = await pool.query(
      `SELECT agente, cod_perf_agente FROM ccee_agente_perfis WHERE agente = ANY($1)`,
      [agentes]
    );
    if (!perfisRows.length) continue;

    // Map<string(cod_perf) → agente_correto>
    const perfToAgente = new Map(perfisRows.map(r => [String(r.cod_perf_agente), r.agente]));

    // 3. Monta lista de transferências: { errado, correto, codPerf }
    // Para cada cod_perf, verifica se algum agente do grupo tem dados no agente errado
    const transfers = [];
    for (const [codPerfStr, correto] of perfToAgente) {
      const codPerf = parseInt(codPerfStr, 10);
      for (const errado of agentes) {
        if (errado === correto) continue;
        transfers.push({ errado, correto, codPerf });
      }
    }

    if (!transfers.length) continue;

    // 4. Verifica se há dados errados em alguma tabela
    const contagens = {}; // { tabela → { errado → correto → n } }
    let grupoTemProblema = false;

    for (const tab of TABELAS) {
      for (const { errado, correto, codPerf } of transfers) {
        const n = await contarErradas(tab.nome, tab.pkCols, errado, correto, codPerf);
        if (n > 0) {
          grupoTemProblema = true;
          if (!contagens[tab.nome]) contagens[tab.nome] = [];
          contagens[tab.nome].push({ errado, correto, codPerf, n });
        }
      }
    }

    if (!grupoTemProblema) continue;

    // Relata o grupo
    gruposComProblema++;
    const header = `\n━━ ${nome}\n   Agentes: ${agentes.join(", ")}`;
    log(header);

    for (const tab of TABELAS) {
      if (!contagens[tab.nome]?.length) continue;
      for (const { errado, correto, codPerf, n } of contagens[tab.nome]) {
        const line = `   ⚠  ${tab.label}: ${n} linha(s) erradas — ${errado} → ${correto} (perfil ${codPerf})`;
        log(line);
      }
    }

    if (DRY_RUN) {
      log("   ↳ dry-run: nenhuma alteração feita");
      continue;
    }

    // 5. Corrige todas as tabelas
    for (const tab of TABELAS) {
      if (!contagens[tab.nome]?.length) continue;
      let movidas = 0;
      for (const { errado, correto, codPerf } of contagens[tab.nome]) {
        movidas += await corrigirTabela(tab.nome, tab.pkCols, errado, correto, codPerf);
      }
      totalMovidas += movidas;
      console.log(`   ✅ ${tab.label}: ${movidas} linha(s) corrigidas`);
    }
  }

  const resumo = DRY_RUN
    ? `\ndry-run concluído — ${gruposComProblema} grupo(s) com dados errados encontrados`
    : `\nTotal de linhas corrigidas: ${totalMovidas}`;

  console.log(`\n${"─".repeat(60)}${resumo}`);
  if (DRY_RUN && logStream) {
    logFile("─".repeat(60));
    logFile(resumo.trim());
    console.log(`\nResultado salvo em: ${outFile}`);
  }

  await pool.end();
  if (logStream) logStream.end();
}

main().catch(e => { console.error(e); process.exit(1); });
