// scripts/criar-banco.js
// Cria (ou recria) todas as tabelas do CCEE Monitor com o schema correto.
//
// Uso:
//   node scripts/criar-banco.js              -- cria se não existir (IF NOT EXISTS)
//   node scripts/criar-banco.js --drop       -- dropa tudo e recria do zero (⚠ DESTRÓI DADOS)
//
// Para produção (banco do zero):
//   node scripts/criar-banco.js --drop
//   node scripts/rodar-tudo.js

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { Pool } = require("pg");

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  ssl:                     { rejectUnauthorized: false },
  idleTimeoutMillis:       60000,
  connectionTimeoutMillis: 30000,
});

const args = process.argv.slice(2);
const DROP = args.includes("--drop");

// Ordem de drop reversa (respeita dependências)
const TABELAS_ORDEM_DROP = [
  "ccee_modulacao_geracao",
  "ccee_geracao_horaria",
  "ccee_curva_tipica_perfil",
  "ccee_curva_tipica",
  "ccee_modulacao",
  "ccee_contrato_mensal_perfil",
  "ccee_consumo_mensal_perfil",
  "ccee_consumo_horario_uc",
  "ccee_consumo_horario_perfil",
  "ccee_consumo_horario",
  "ccee_contabilizacao",
  "ccee_agente_perfis",
  "ccee_usinas",
  "ccee_cargas",
  "ccee_dados",
  "ccee_agentes",
  "ccee_cidades_geo",
];

async function dropTabelas(client) {
  console.log("\n⚠  Dropando todas as tabelas...");
  for (const t of TABELAS_ORDEM_DROP) {
    await client.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    console.log(`  DROP ${t}`);
  }
}

async function criarTabelas(client) {
  const q = (sql) => client.query(sql);
  const ifnot = DROP ? "" : "IF NOT EXISTS";

  // ── ccee_agentes ─────────────────────────────────────────────────────────────
  await q(`
    CREATE TABLE ${ifnot} ccee_agentes (
      agente         TEXT        NOT NULL,
      razao_social   TEXT,
      sigla          TEXT,
      cnpj           TEXT,
      classe         TEXT,
      situacao       TEXT,
      capital_social NUMERIC,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente)
    )
  `);

  // ── ccee_dados ───────────────────────────────────────────────────────────────
  await q(`
    CREATE TABLE ${ifnot} ccee_dados (
      agente             TEXT        NOT NULL,
      mes                CHAR(7)     NOT NULL,
      balanco_energetico NUMERIC,
      mcp                NUMERIC,
      compra             NUMERIC,
      consumo            NUMERIC,
      geracao            NUMERIC,
      venda              NUMERIC,
      consumo_geracao    NUMERIC,
      resultado          NUMERIC,
      resultado_mcp      NUMERIC,
      mcp_rs_mwh         NUMERIC,
      mre_mais           NUMERIC,
      mre_menos          NUMERIC,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, mes)
    )
  `);

  // ── ccee_cargas ──────────────────────────────────────────────────────────────
  await q(`
    CREATE TABLE ${ifnot} ccee_cargas (
      agente                      TEXT        NOT NULL,
      sigla_perfil_agente         TEXT,
      mes_referencia              CHAR(7)     NOT NULL,
      cod_perf_agente             TEXT,
      nome_empresarial            TEXT,
      cod_parcela_carga           TEXT,
      sigla_parcela_carga         TEXT,
      cnpj_carga                  TEXT,
      cidade                      TEXT,
      estado_uf                   CHAR(2),
      ramo_atividade              TEXT,
      submercado                  TEXT,
      data_migracao               DATE,
      cod_perf_agente_conectado   TEXT,
      sigla_perfil_agente_conectado TEXT,
      capacidade_carga            NUMERIC,
      consumo_acl                 NUMERIC,
      consumo_cativo_parc_livre   NUMERIC,
      consumo_total               NUMERIC,
      created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, sigla_parcela_carga, mes_referencia)
    )
  `);
  await q(`CREATE INDEX ${ifnot} idx_cargas_agente ON ccee_cargas (agente)`);
  await q(`CREATE INDEX ${ifnot} idx_cargas_estado ON ccee_cargas (estado_uf)`);

  // ── ccee_usinas ──────────────────────────────────────────────────────────────
  await q(`
    CREATE TABLE ${ifnot} ccee_usinas (
      agente                    TEXT        NOT NULL,
      sigla_perfil              TEXT,
      mes_referencia            CHAR(7)     NOT NULL,
      sigla_ativo               TEXT,
      cod_parcela_usina         TEXT,
      sigla_parcela_usina       TEXT,
      tipo_despacho             TEXT,
      fonte_energia_primaria    TEXT,
      submercado                TEXT,
      estado_uf                 CHAR(2),
      caracteristica_parcela    TEXT,
      participante_mre          TEXT,
      participante_regime_cotas TEXT,
      data_inicio_op_com        DATE,
      percentual_desconto_usina NUMERIC,
      cap_t                     NUMERIC,
      geracao_centro_gravidade  NUMERIC,
      gf_centro_gravidade       NUMERIC,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (sigla_parcela_usina, mes_referencia)
    )
  `);
  await q(`CREATE INDEX ${ifnot} idx_usinas_agente ON ccee_usinas (agente)`);

  // ── ccee_agente_perfis ───────────────────────────────────────────────────────
  // Mapeamento: agente CCEE Monitor → cod_agente_ccee → [cod_perf_agente, sigla]
  // Usado para filtrar dados de empresa (NOME_EMPRESARIAL) pelo agente correto
  await q(`
    CREATE TABLE ${ifnot} ccee_agente_perfis (
      agente              TEXT        NOT NULL,
      cod_agente_ccee     INTEGER     NOT NULL,
      cod_perf_agente     INTEGER     NOT NULL,
      sigla_perfil_agente TEXT        NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, cod_perf_agente)
    )
  `);
  await q(`CREATE INDEX ${ifnot} idx_agente_perfis_agente      ON ccee_agente_perfis (agente)`);
  await q(`CREATE INDEX ${ifnot} idx_agente_perfis_cod_agente  ON ccee_agente_perfis (cod_agente_ccee)`);
  await q(`CREATE INDEX ${ifnot} idx_agente_perfis_cod_perfil  ON ccee_agente_perfis (cod_perf_agente)`);

  // ── ccee_contabilizacao ──────────────────────────────────────────────────────
  await q(`
    CREATE TABLE ${ifnot} ccee_contabilizacao (
      agente                     TEXT        NOT NULL,
      mes_referencia             CHAR(7)     NOT NULL,
      sigla_perfil_agente        TEXT,
      nome_empresarial           TEXT,
      cod_perf_agente            INTEGER,
      valor_tm_mcp               NUMERIC,
      compensacao_mre            NUMERIC,
      valor_encargo              NUMERIC,
      valor_ajuste_exposicao     NUMERIC,
      valor_ajuste_alivio_ret    NUMERIC,
      efeito_contrat_disp        NUMERIC,
      efeito_contrat_cota_gf     NUMERIC,
      efeito_contrat_nuclear     NUMERIC,
      ajuste_recontab            NUMERIC,
      ajuste_mcsd_ex             NUMERIC,
      resultado_financeiro_er    NUMERIC,
      efeito_ccearq              NUMERIC,
      efeito_contrat_itaipu      NUMERIC,
      efeito_repasse_risco_hidro NUMERIC,
      efeito_desloc_pld_cmo      NUMERIC,
      resultado_final            NUMERIC,
      created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, mes_referencia, sigla_perfil_agente)
    )
  `);
  await q(`CREATE INDEX ${ifnot} idx_contab_agente ON ccee_contabilizacao (agente)`);

  // ── ccee_consumo_horario (temporário — apagado após cálculo de modulação) ────
  await q(`
    CREATE TABLE ${ifnot} ccee_consumo_horario (
      agente         TEXT          NOT NULL,
      mes_referencia CHAR(7)       NOT NULL,
      periodo        INTEGER       NOT NULL,
      submercado     TEXT          NOT NULL,
      consumo_mwh    NUMERIC(14,6) NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, mes_referencia, periodo, submercado)
    )
  `);

  // ── ccee_consumo_horario_perfil (temporário — apagado após cálculo da curva) ─
  await q(`
    CREATE TABLE ${ifnot} ccee_consumo_horario_perfil (
      agente          TEXT          NOT NULL,
      mes_referencia  CHAR(7)       NOT NULL,
      sigla_perfil    TEXT          NOT NULL,
      cod_agente_ccee INTEGER,
      cod_perf_agente INTEGER,
      periodo         INTEGER       NOT NULL,
      submercado      TEXT          NOT NULL,
      consumo_mwh     NUMERIC(14,6) NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, mes_referencia, sigla_perfil, periodo, submercado)
    )
  `);
  await q(`CREATE INDEX ${ifnot} idx_cons_hor_perf_agente ON ccee_consumo_horario_perfil (agente, mes_referencia)`);

  // ── ccee_consumo_horario_uc (permanente — consumo por unidade consumidora) ───
  await q(`
    CREATE TABLE ${ifnot} ccee_consumo_horario_uc (
      agente          TEXT          NOT NULL,
      nome_carga      TEXT          NOT NULL,
      mes_referencia  CHAR(7)       NOT NULL,
      sigla_perfil    TEXT          NOT NULL DEFAULT '',
      cod_agente_ccee INTEGER,
      cod_perf_agente INTEGER,
      periodo         INTEGER       NOT NULL,
      submercado      TEXT          NOT NULL,
      consumo_mwh     NUMERIC(14,6) NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, nome_carga, mes_referencia, periodo, submercado)
    )
  `);
  await q(`CREATE INDEX ${ifnot} idx_cons_hor_uc_agente_mes ON ccee_consumo_horario_uc (agente, mes_referencia)`);
  await q(`CREATE INDEX ${ifnot} idx_cons_hor_uc_nome_carga ON ccee_consumo_horario_uc (agente, nome_carga)`);

  // ── ccee_consumo_mensal_perfil ───────────────────────────────────────────────
  await q(`
    CREATE TABLE ${ifnot} ccee_consumo_mensal_perfil (
      agente              TEXT          NOT NULL,
      mes_referencia      CHAR(7)       NOT NULL,
      sigla_perfil        TEXT          NOT NULL,
      cod_agente_ccee     INTEGER,
      cod_perf_agente     INTEGER,
      consumo_mwh         NUMERIC(14,6),
      consumo_geracao_mwh NUMERIC(14,6),
      created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, mes_referencia, sigla_perfil)
    )
  `);
  await q(`CREATE INDEX ${ifnot} idx_cons_mensal_perf_agente ON ccee_consumo_mensal_perfil (agente)`);

  // ── ccee_contrato_mensal_perfil ──────────────────────────────────────────────
  await q(`
    CREATE TABLE ${ifnot} ccee_contrato_mensal_perfil (
      agente          TEXT          NOT NULL,
      mes_referencia  CHAR(7)       NOT NULL,
      sigla_perfil    TEXT          NOT NULL,
      cod_agente_ccee INTEGER,
      cod_perf_agente INTEGER,
      compra_mwh      NUMERIC(14,6),
      venda_mwh       NUMERIC(14,6),
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, mes_referencia, sigla_perfil)
    )
  `);
  await q(`CREATE INDEX ${ifnot} idx_contrato_mensal_perf_agente ON ccee_contrato_mensal_perfil (agente)`);

  // ── ccee_modulacao_uc ────────────────────────────────────────────────────────
  await q(`
    CREATE TABLE ${ifnot} ccee_modulacao_uc (
      agente                 TEXT          NOT NULL,
      nome_carga             TEXT          NOT NULL,
      mes_referencia         CHAR(7)       NOT NULL,
      sigla_perfil           TEXT          NOT NULL DEFAULT '',
      cod_agente_ccee        INTEGER,
      cod_perf_agente        INTEGER,
      submercado             TEXT          NOT NULL,
      consumo_total_mwh      NUMERIC(14,4),
      n_horas                INTEGER,
      soma_curva_rs          NUMERIC(18,4),
      soma_flat_rs           NUMERIC(18,4),
      custo_modulacao_rs_mwh NUMERIC(14,4),
      created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, nome_carga, mes_referencia, submercado)
    )
  `);
  await q(`CREATE INDEX ${ifnot} idx_mod_uc_agente ON ccee_modulacao_uc (agente, mes_referencia)`);
  await q(`CREATE INDEX ${ifnot} idx_mod_uc_nome   ON ccee_modulacao_uc (agente, nome_carga)`);

  // ── ccee_modulacao ───────────────────────────────────────────────────────────
  await q(`
    CREATE TABLE ${ifnot} ccee_modulacao (
      agente                TEXT          NOT NULL,
      mes_referencia        CHAR(7)       NOT NULL,
      submercado            TEXT          NOT NULL,
      consumo_total_mwh     NUMERIC(14,4),
      n_horas               INTEGER,
      soma_curva_rs         NUMERIC(18,4),
      soma_flat_rs          NUMERIC(18,4),
      custo_modulacao_rs_mwh NUMERIC(14,4),
      created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, mes_referencia, submercado)
    )
  `);

  // ── ccee_curva_tipica ────────────────────────────────────────────────────────
  await q(`
    CREATE TABLE ${ifnot} ccee_curva_tipica (
      agente      TEXT          NOT NULL,
      submercado  TEXT          NOT NULL,
      hora        INTEGER       NOT NULL,
      consumo_med NUMERIC(14,6),
      n_amostras  INTEGER,
      updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, submercado, hora)
    )
  `);

  // ── ccee_curva_tipica_perfil ─────────────────────────────────────────────────
  await q(`
    CREATE TABLE ${ifnot} ccee_curva_tipica_perfil (
      agente          TEXT          NOT NULL,
      sigla_perfil    TEXT          NOT NULL,
      cod_agente_ccee INTEGER,
      cod_perf_agente INTEGER,
      hora            INTEGER       NOT NULL,
      consumo_med     NUMERIC(14,6),
      n_amostras      INTEGER,
      updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, sigla_perfil, hora)
    )
  `);

  // ── ccee_geracao_horaria ─────────────────────────────────────────────────────
  await q(`
    CREATE TABLE ${ifnot} ccee_geracao_horaria (
      agente         TEXT          NOT NULL,
      mes_referencia CHAR(7)       NOT NULL,
      sigla_usina    TEXT          NOT NULL,
      periodo        INTEGER       NOT NULL,
      submercado     TEXT          NOT NULL,
      geracao_mwmed  NUMERIC(14,6) NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, mes_referencia, periodo, submercado, sigla_usina)
    )
  `);
  await q(`CREATE INDEX ${ifnot} idx_ger_hor_agente ON ccee_geracao_horaria (agente, mes_referencia)`);

  // ── ccee_modulacao_geracao ───────────────────────────────────────────────────
  await q(`
    CREATE TABLE ${ifnot} ccee_modulacao_geracao (
      agente                 TEXT          NOT NULL,
      mes_referencia         CHAR(7)       NOT NULL,
      sigla_usina            TEXT          NOT NULL,
      submercado             TEXT          NOT NULL,
      geracao_total_mwh      NUMERIC(14,4),
      n_horas                INTEGER,
      soma_curva_rs          NUMERIC(18,4),
      soma_flat_rs           NUMERIC(18,4),
      custo_modulacao_rs_mwh NUMERIC(14,4),
      created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agente, mes_referencia, sigla_usina, submercado)
    )
  `);

  // ── ccee_cidades_geo ─────────────────────────────────────────────────────────
  await q(`
    CREATE TABLE ${ifnot} ccee_cidades_geo (
      cidade      TEXT    NOT NULL,
      estado_uf   CHAR(2) NOT NULL,
      lat         DOUBLE PRECISION,
      lon         DOUBLE PRECISION,
      geocoded_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (cidade, estado_uf)
    )
  `);
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (DROP) {
      const confirm = args.includes("--confirmar");
      if (!confirm) {
        console.error("\n❌ --drop requer --confirmar para evitar acidentes.");
        console.error("   node scripts/criar-banco.js --drop --confirmar");
        process.exit(1);
      }
      await dropTabelas(client);
    }

    console.log(`\n${DROP ? "Criando" : "Verificando"} tabelas...`);
    await criarTabelas(client);
    await client.query("COMMIT");
    console.log("\n✅ Banco pronto.");
    if (!DROP) {
      console.log("   Tabelas existentes não foram alteradas.");
      console.log("   Para reconstruir do zero: node scripts/criar-banco.js --drop --confirmar");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("\n❌ Erro:", e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
