-- Schema completo — fonte única de verdade.
-- Para resetar o banco: node scripts/criar-banco.js --drop --confirmar
-- Para atualizar sem perder dados: node scripts/criar-banco.js

-- ─── Drop (ordem respeita FKs) ────────────────────────────────────────────────
DROP TABLE IF EXISTS ccee_modulacao_geracao  CASCADE;
DROP TABLE IF EXISTS ccee_geracao_horaria    CASCADE;
DROP TABLE IF EXISTS ccee_curva_tipica_perfil CASCADE;
DROP TABLE IF EXISTS ccee_curva_tipica       CASCADE;
DROP TABLE IF EXISTS ccee_modulacao_uc       CASCADE;
DROP TABLE IF EXISTS ccee_modulacao          CASCADE;
DROP TABLE IF EXISTS ccee_contrato_mensal_perfil CASCADE;
DROP TABLE IF EXISTS ccee_consumo_mensal_perfil  CASCADE;
DROP TABLE IF EXISTS ccee_consumo_horario_uc     CASCADE;
DROP TABLE IF EXISTS ccee_consumo_horario_perfil CASCADE;
DROP TABLE IF EXISTS ccee_consumo_horario    CASCADE;
DROP TABLE IF EXISTS ccee_contabilizacao     CASCADE;
DROP TABLE IF EXISTS ccee_agente_perfis      CASCADE;
DROP TABLE IF EXISTS ccee_usinas             CASCADE;
DROP TABLE IF EXISTS ccee_cargas             CASCADE;
DROP TABLE IF EXISTS ccee_dados              CASCADE;
DROP TABLE IF EXISTS ccee_agentes            CASCADE;
DROP TABLE IF EXISTS ccee_cidades_geo        CASCADE;

-- ─── Agentes ──────────────────────────────────────────────────────────────────
-- cod_agente_ccee: código numérico da CCEE (COD_AGENTE da lista_perfil_v1).
-- Preenchido pela fase 0 do pipeline (sincronizarPerfisLista).
CREATE TABLE ccee_agentes (
  agente          TEXT        PRIMARY KEY,
  cod_agente_ccee INTEGER,
  razao_social    TEXT,
  sigla           TEXT,
  cnpj            TEXT,
  classe          TEXT,
  situacao        TEXT,
  capital_social  NUMERIC,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Mapeamento agente → perfis CCEE ────────────────────────────────────────
-- Um agente pode ter múltiplos perfis (ex: consumo + geração, ou múltiplas UCs).
-- Usado para filtrar cargas/contabilização pelo perfil correto do agente.
CREATE TABLE ccee_agente_perfis (
  agente              TEXT    NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  cod_agente_ccee     INTEGER NOT NULL,
  cod_perf_agente     INTEGER NOT NULL,
  sigla_perfil_agente TEXT    NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agente, cod_perf_agente)
);
CREATE INDEX idx_agente_perfis_agente     ON ccee_agente_perfis (agente);
CREATE INDEX idx_agente_perfis_cod_agente ON ccee_agente_perfis (cod_agente_ccee);
CREATE INDEX idx_agente_perfis_cod_perfil ON ccee_agente_perfis (cod_perf_agente);

-- ─── Dados mensais (resumo financeiro/energético) ────────────────────────────
CREATE TABLE ccee_dados (
  agente             TEXT    NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes                CHAR(7) NOT NULL CHECK (mes ~ '^\d{4}-\d{2}$'),
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
);

-- ─── Parcelas de carga ────────────────────────────────────────────────────────
-- cod_perf_agente é TEXT aqui (vem como texto nos CSVs de cargas).
CREATE TABLE ccee_cargas (
  agente                        TEXT    NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  sigla_perfil_agente           TEXT,
  mes_referencia                CHAR(7) NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  cod_perf_agente               TEXT,
  nome_empresarial              TEXT,
  cod_parcela_carga             TEXT,
  sigla_parcela_carga           TEXT,
  cnpj_carga                    TEXT,
  cidade                        TEXT,
  estado_uf                     CHAR(2),
  ramo_atividade                TEXT,
  submercado                    TEXT,
  data_migracao                 DATE,
  cod_perf_agente_conectado     TEXT,
  sigla_perfil_agente_conectado TEXT,
  capacidade_carga              NUMERIC,
  consumo_acl                   NUMERIC,
  consumo_cativo_parc_livre     NUMERIC,
  consumo_total                 NUMERIC,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agente, sigla_parcela_carga, mes_referencia)
);
CREATE INDEX idx_cargas_agente ON ccee_cargas (agente);
CREATE INDEX idx_cargas_estado ON ccee_cargas (estado_uf);

-- ─── Unidades geradoras ───────────────────────────────────────────────────────
CREATE TABLE ccee_usinas (
  agente                    TEXT    NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  sigla_perfil              TEXT,
  mes_referencia            CHAR(7) NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
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
);
CREATE INDEX idx_usinas_agente ON ccee_usinas (agente);

-- ─── Contabilização por perfil de agente ─────────────────────────────────────
CREATE TABLE ccee_contabilizacao (
  agente                     TEXT    NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia             CHAR(7) NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  sigla_perfil_agente        TEXT    NOT NULL,
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
);
CREATE INDEX idx_contab_agente ON ccee_contabilizacao (agente);

-- ─── Consumo horário agregado (temporário — apagado após cálculo de modulação) ─
CREATE TABLE ccee_consumo_horario (
  agente         TEXT          NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia CHAR(7)       NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  periodo        INTEGER       NOT NULL,
  submercado     TEXT          NOT NULL,
  consumo_mwh    NUMERIC(14,6) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agente, mes_referencia, periodo, submercado)
);

-- ─── Consumo horário por perfil (temporário — apagado após cálculo da curva) ──
CREATE TABLE ccee_consumo_horario_perfil (
  agente          TEXT          NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia  CHAR(7)       NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  sigla_perfil    TEXT          NOT NULL,
  cod_agente_ccee INTEGER,
  cod_perf_agente INTEGER,
  periodo         INTEGER       NOT NULL,
  submercado      TEXT          NOT NULL,
  consumo_mwh     NUMERIC(14,6) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agente, mes_referencia, sigla_perfil, periodo, submercado)
);
CREATE INDEX idx_cons_hor_perf_agente ON ccee_consumo_horario_perfil (agente, mes_referencia);

-- ─── Consumo horário por unidade consumidora (permanente) ────────────────────
CREATE TABLE ccee_consumo_horario_uc (
  agente          TEXT          NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  nome_carga      TEXT          NOT NULL,
  mes_referencia  CHAR(7)       NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  sigla_perfil    TEXT          NOT NULL DEFAULT '',
  cod_agente_ccee INTEGER,
  cod_perf_agente INTEGER,
  periodo         INTEGER       NOT NULL,
  submercado      TEXT          NOT NULL,
  consumo_mwh     NUMERIC(14,6) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agente, nome_carga, mes_referencia, periodo, submercado)
);
CREATE INDEX idx_cons_hor_uc_agente_mes ON ccee_consumo_horario_uc (agente, mes_referencia);
CREATE INDEX idx_cons_hor_uc_nome_carga ON ccee_consumo_horario_uc (agente, nome_carga);

-- ─── Consumo mensal por perfil (dados abertos CCEE) ─────────────────────────
CREATE TABLE ccee_consumo_mensal_perfil (
  agente              TEXT          NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia      CHAR(7)       NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  sigla_perfil        TEXT          NOT NULL,
  cod_agente_ccee     INTEGER,
  cod_perf_agente     INTEGER,
  consumo_mwh         NUMERIC(14,6),
  consumo_geracao_mwh NUMERIC(14,6),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agente, mes_referencia, sigla_perfil)
);
CREATE INDEX idx_cons_mensal_perf_agente ON ccee_consumo_mensal_perfil (agente);

-- ─── Contratos (compra/venda) mensal por perfil ───────────────────────────────
CREATE TABLE ccee_contrato_mensal_perfil (
  agente          TEXT          NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia  CHAR(7)       NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  sigla_perfil    TEXT          NOT NULL,
  cod_agente_ccee INTEGER,
  cod_perf_agente INTEGER,
  compra_mwh      NUMERIC(14,6),
  venda_mwh       NUMERIC(14,6),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agente, mes_referencia, sigla_perfil)
);
CREATE INDEX idx_contrato_mensal_perf_agente ON ccee_contrato_mensal_perfil (agente);

-- ─── Modulação horária (custo de modulação agregado por agente/mês) ──────────
CREATE TABLE ccee_modulacao (
  agente                 TEXT          NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia         CHAR(7)       NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  submercado             TEXT          NOT NULL,
  consumo_total_mwh      NUMERIC(14,4),
  n_horas                INTEGER,
  soma_curva_rs          NUMERIC(18,4),
  soma_flat_rs           NUMERIC(18,4),
  custo_modulacao_rs_mwh NUMERIC(14,4),
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agente, mes_referencia, submercado)
);

-- ─── Modulação horária por unidade consumidora ────────────────────────────────
CREATE TABLE ccee_modulacao_uc (
  agente                 TEXT          NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  nome_carga             TEXT          NOT NULL,
  mes_referencia         CHAR(7)       NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
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
);
CREATE INDEX idx_mod_uc_agente ON ccee_modulacao_uc (agente, mes_referencia);
CREATE INDEX idx_mod_uc_nome   ON ccee_modulacao_uc (agente, nome_carga);

-- ─── Curva de carga típica (média histórica por hora do dia) ─────────────────
CREATE TABLE ccee_curva_tipica (
  agente      TEXT    NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  submercado  TEXT    NOT NULL,
  hora        INTEGER NOT NULL,
  consumo_med NUMERIC(14,6),
  n_amostras  INTEGER,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agente, submercado, hora)
);

CREATE TABLE ccee_curva_tipica_perfil (
  agente          TEXT    NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  sigla_perfil    TEXT    NOT NULL,
  cod_agente_ccee INTEGER,
  cod_perf_agente INTEGER,
  hora            INTEGER NOT NULL,
  consumo_med     NUMERIC(14,6),
  n_amostras      INTEGER,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agente, sigla_perfil, hora)
);

-- ─── Geração horária ──────────────────────────────────────────────────────────
CREATE TABLE ccee_geracao_horaria (
  agente         TEXT          NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia CHAR(7)       NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  sigla_usina    TEXT          NOT NULL,
  periodo        INTEGER       NOT NULL,
  submercado     TEXT          NOT NULL,
  geracao_mwmed  NUMERIC(14,6) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agente, mes_referencia, periodo, submercado, sigla_usina)
);
CREATE INDEX idx_ger_hor_agente ON ccee_geracao_horaria (agente, mes_referencia);

-- ─── Modulação de geração ─────────────────────────────────────────────────────
CREATE TABLE ccee_modulacao_geracao (
  agente                 TEXT          NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia         CHAR(7)       NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  sigla_usina            TEXT          NOT NULL,
  submercado             TEXT          NOT NULL,
  geracao_total_mwh      NUMERIC(14,4),
  n_horas                INTEGER,
  soma_curva_rs          NUMERIC(18,4),
  soma_flat_rs           NUMERIC(18,4),
  custo_modulacao_rs_mwh NUMERIC(14,4),
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agente, mes_referencia, sigla_usina, submercado)
);

-- ─── Geocodificação de cidades ────────────────────────────────────────────────
CREATE TABLE ccee_cidades_geo (
  cidade      TEXT    NOT NULL,
  estado_uf   CHAR(2) NOT NULL,
  lat         DOUBLE PRECISION,
  lon         DOUBLE PRECISION,
  geocoded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cidade, estado_uf)
);
