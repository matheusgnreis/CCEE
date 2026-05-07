-- Schema completo — fonte única de verdade.
-- Para resetar o banco: node db/reset.js

-- ─── Drop (ordem respeita FKs) ────────────────────────────────────────────────
DROP TABLE IF EXISTS ccee_modulacao_perfil;
DROP TABLE IF EXISTS ccee_modulacao_geracao;
DROP TABLE IF EXISTS ccee_modulacao;
DROP TABLE IF EXISTS ccee_consumo_horario_perfil;
DROP TABLE IF EXISTS ccee_consumo_horario;
DROP TABLE IF EXISTS ccee_geracao_horaria;
DROP TABLE IF EXISTS ccee_contabilizacao;
DROP TABLE IF EXISTS ccee_jobs;
DROP TABLE IF EXISTS ccee_usinas;
DROP TABLE IF EXISTS ccee_cargas;
DROP TABLE IF EXISTS ccee_dados;
DROP TABLE IF EXISTS ccee_agentes;

-- ─── Agentes ──────────────────────────────────────────────────────────────────
CREATE TABLE ccee_agentes (
  agente         TEXT        PRIMARY KEY,
  razao_social   TEXT,
  sigla          TEXT,
  cnpj           TEXT,
  classe         TEXT,
  situacao       TEXT,
  capital_social NUMERIC     NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Dados mensais ────────────────────────────────────────────────────────────
-- geracao/venda/consumo_geracao são NULL para agentes sem autoprodução.
-- consumo/compra/resultado/resultado_mcp são NULL quando o mês veio só do histórico (Q1).
CREATE TABLE ccee_dados (
  id                 SERIAL      PRIMARY KEY,
  agente             TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes                CHAR(7)     NOT NULL CHECK (mes ~ '^\d{4}-\d{2}$'),
  consumo            NUMERIC,
  compra             NUMERIC,
  mcp                NUMERIC     NOT NULL DEFAULT 0,
  resultado          NUMERIC,
  resultado_mcp      NUMERIC,
  balanco_energetico NUMERIC     NOT NULL DEFAULT 0,
  geracao            NUMERIC,
  venda              NUMERIC,
  consumo_geracao    NUMERIC,
  mcp_rs_mwh         NUMERIC,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_agente_mes UNIQUE (agente, mes)
);

-- ─── Parcelas de carga ────────────────────────────────────────────────────────
CREATE TABLE ccee_cargas (
  id                            SERIAL      PRIMARY KEY,
  agente                        TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  sigla_perfil_agente           TEXT        NOT NULL,
  mes_referencia                CHAR(7)     NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
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
  CONSTRAINT uniq_carga_agente_mes UNIQUE (agente, sigla_parcela_carga, mes_referencia)
);

CREATE INDEX idx_ccee_cargas_agente     ON ccee_cargas (agente);
CREATE INDEX idx_ccee_cargas_mes        ON ccee_cargas (mes_referencia);
CREATE INDEX idx_ccee_cargas_estado     ON ccee_cargas (estado_uf);
CREATE INDEX idx_ccee_cargas_cidade     ON ccee_cargas (cidade);
CREATE INDEX idx_ccee_cargas_ramo       ON ccee_cargas (ramo_atividade);
CREATE INDEX idx_ccee_cargas_submercado ON ccee_cargas (submercado);

-- ─── Unidades geradoras ───────────────────────────────────────────────────────
CREATE TABLE ccee_usinas (
  id                        SERIAL      PRIMARY KEY,
  agente                    TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  sigla_perfil              TEXT        NOT NULL,
  mes_referencia            CHAR(7)     NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
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
  CONSTRAINT uniq_usina_mes UNIQUE (sigla_parcela_usina, mes_referencia)
);

CREATE INDEX idx_ccee_usinas_agente     ON ccee_usinas (agente);
CREATE INDEX idx_ccee_usinas_mes        ON ccee_usinas (mes_referencia);
CREATE INDEX idx_ccee_usinas_fonte      ON ccee_usinas (fonte_energia_primaria);
CREATE INDEX idx_ccee_usinas_submercado ON ccee_usinas (submercado);
CREATE INDEX idx_ccee_usinas_estado     ON ccee_usinas (estado_uf);

-- ─── Consumo horário ──────────────────────────────────────────────────────────
-- periodo = hora-do-mês (1–744 para mês de 31 dias).
-- submercado normalizado: SE, S, NE, N.
CREATE TABLE ccee_consumo_horario (
  id             SERIAL      PRIMARY KEY,
  agente         TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia CHAR(7)     NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  periodo        INTEGER     NOT NULL,
  submercado     TEXT        NOT NULL,
  consumo_mwh    NUMERIC     NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_consumo_horario UNIQUE (agente, mes_referencia, periodo, submercado)
);

CREATE INDEX idx_ch_agente     ON ccee_consumo_horario (agente);
CREATE INDEX idx_ch_mes        ON ccee_consumo_horario (mes_referencia);
CREATE INDEX idx_ch_submercado ON ccee_consumo_horario (submercado);
CREATE INDEX idx_ch_periodo    ON ccee_consumo_horario (periodo);

-- ─── Modulação horária ────────────────────────────────────────────────────────
CREATE TABLE ccee_modulacao (
  id                     SERIAL      PRIMARY KEY,
  agente                 TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia         CHAR(7)     NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  submercado             TEXT        NOT NULL,
  consumo_total_mwh      NUMERIC     NOT NULL,
  n_horas                INTEGER     NOT NULL,
  soma_curva_rs          NUMERIC     NOT NULL,
  soma_flat_rs           NUMERIC     NOT NULL,
  custo_modulacao_rs_mwh NUMERIC     NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_modulacao UNIQUE (agente, mes_referencia, submercado)
);

CREATE INDEX idx_mod_agente ON ccee_modulacao (agente);
CREATE INDEX idx_mod_mes    ON ccee_modulacao (mes_referencia);

-- ─── Geração horária ─────────────────────────────────────────────────────────
-- periodo = hora-do-mês base 1 (1–744). geracao_mwmed = GERACAO_CENTRO_GRAVIDADE.
-- sigla_usina = SIGLA_PARCELA_USINA do CSV de geração.
CREATE TABLE ccee_geracao_horaria (
  id             SERIAL      PRIMARY KEY,
  agente         TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia CHAR(7)     NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  sigla_usina    TEXT        NOT NULL,
  periodo        INTEGER     NOT NULL,
  submercado     TEXT        NOT NULL,
  geracao_mwmed  NUMERIC     NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_geracao_horaria UNIQUE (agente, mes_referencia, periodo, submercado, sigla_usina)
);

CREATE INDEX idx_gh_agente     ON ccee_geracao_horaria (agente);
CREATE INDEX idx_gh_mes        ON ccee_geracao_horaria (mes_referencia);
CREATE INDEX idx_gh_submercado ON ccee_geracao_horaria (submercado);

-- ─── Modulação horária de geração ─────────────────────────────────────────────
CREATE TABLE ccee_modulacao_geracao (
  id                     SERIAL      PRIMARY KEY,
  agente                 TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia         CHAR(7)     NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  sigla_usina            TEXT        NOT NULL,
  submercado             TEXT        NOT NULL,
  geracao_total_mwh      NUMERIC     NOT NULL,
  n_horas                INTEGER     NOT NULL,
  soma_curva_rs          NUMERIC     NOT NULL,
  soma_flat_rs           NUMERIC     NOT NULL,
  custo_modulacao_rs_mwh NUMERIC     NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_modulacao_geracao UNIQUE (agente, mes_referencia, sigla_usina, submercado)
);

CREATE INDEX idx_modg_agente ON ccee_modulacao_geracao (agente);
CREATE INDEX idx_modg_mes    ON ccee_modulacao_geracao (mes_referencia);

-- ─── Contabilização por perfil de agente ─────────────────────────────────────
CREATE TABLE ccee_contabilizacao (
  id                       SERIAL      PRIMARY KEY,
  agente                   TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia           CHAR(7)     NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  sigla_perfil_agente      TEXT        NOT NULL,
  nome_empresarial         TEXT,
  cod_perf_agente          INTEGER,
  valor_tm_mcp             NUMERIC,
  compensacao_mre          NUMERIC,
  valor_encargo            NUMERIC,
  valor_ajuste_exposicao   NUMERIC,
  valor_ajuste_alivio_ret  NUMERIC,
  efeito_contrat_disp      NUMERIC,
  efeito_contrat_cota_gf   NUMERIC,
  efeito_contrat_nuclear   NUMERIC,
  ajuste_recontab          NUMERIC,
  ajuste_mcsd_ex           NUMERIC,
  resultado_financeiro_er  NUMERIC,
  efeito_ccearq            NUMERIC,
  efeito_contrat_itaipu    NUMERIC,
  efeito_repasse_risco_hidro NUMERIC,
  efeito_desloc_pld_cmo    NUMERIC,
  resultado_final          NUMERIC,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agente, mes_referencia, sigla_perfil_agente)
);

CREATE INDEX idx_cont_agente ON ccee_contabilizacao (agente);
CREATE INDEX idx_cont_mes    ON ccee_contabilizacao (mes_referencia);

-- ─── Consumo horário por perfil de agente ────────────────────────────────────
-- sigla_perfil = SIGLA_PERFIL_AGENTE do CSV de consumo (perfil individual).
CREATE TABLE ccee_consumo_horario_perfil (
  id             SERIAL      PRIMARY KEY,
  agente         TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia CHAR(7)     NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  sigla_perfil   TEXT        NOT NULL,
  periodo        INTEGER     NOT NULL,
  submercado     TEXT        NOT NULL,
  consumo_mwh    NUMERIC     NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_consumo_perfil UNIQUE (agente, mes_referencia, sigla_perfil, periodo, submercado)
);

CREATE INDEX idx_chp_agente ON ccee_consumo_horario_perfil (agente);
CREATE INDEX idx_chp_mes    ON ccee_consumo_horario_perfil (mes_referencia);

-- ─── Modulação horária por perfil de agente ───────────────────────────────────
CREATE TABLE ccee_modulacao_perfil (
  id                     SERIAL      PRIMARY KEY,
  agente                 TEXT        NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  mes_referencia         CHAR(7)     NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  sigla_perfil           TEXT        NOT NULL,
  submercado             TEXT        NOT NULL,
  consumo_total_mwh      NUMERIC     NOT NULL,
  n_horas                INTEGER     NOT NULL,
  soma_curva_rs          NUMERIC     NOT NULL,
  soma_flat_rs           NUMERIC     NOT NULL,
  custo_modulacao_rs_mwh NUMERIC     NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_modulacao_perfil UNIQUE (agente, mes_referencia, sigla_perfil, submercado)
);

CREATE INDEX idx_modp_agente ON ccee_modulacao_perfil (agente);
CREATE INDEX idx_modp_mes    ON ccee_modulacao_perfil (mes_referencia);

-- ─── Jobs assíncronos ─────────────────────────────────────────────────────────
CREATE TABLE ccee_jobs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo       TEXT        NOT NULL,
  agente     TEXT        NOT NULL,
  mes        CHAR(7)     NOT NULL CHECK (mes ~ '^\d{4}-\d{2}$'),
  params     JSONB       NOT NULL DEFAULT '{}',
  status     TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','error')),
  resultado  JSONB,
  erro       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jobs_agente_mes ON ccee_jobs (agente, mes);
CREATE INDEX idx_jobs_status     ON ccee_jobs (status);
