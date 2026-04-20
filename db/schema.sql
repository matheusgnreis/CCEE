-- Recria as tabelas do zero (limpa tudo)
DROP TABLE IF EXISTS ccee_cargas;
DROP TABLE IF EXISTS ccee_dados;
DROP TABLE IF EXISTS ccee_agentes;

-- Metadados estáticos do agente (CNPJ, razão social, etc.)
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

-- Dados mensais de mercado
-- consumo/compra/resultado/resultado_mcp são NULL quando o mês veio só do histórico (Q1)
-- e será preenchido quando o mês for consultado individualmente (Q0)
CREATE TABLE ccee_dados (
  id                 SERIAL       PRIMARY KEY,
  agente             TEXT         NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  consumo            NUMERIC,
  compra             NUMERIC,
  mcp                NUMERIC      NOT NULL DEFAULT 0,
  resultado          NUMERIC,
  resultado_mcp      NUMERIC,
  balanco_energetico NUMERIC      NOT NULL DEFAULT 0,
  mes                CHAR(7)      NOT NULL CHECK (mes ~ '^\d{4}-\d{2}$'),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_agente_mes UNIQUE (agente, mes)
);

-- Parcelas de carga por agente (dados abertos CCEE)
CREATE TABLE ccee_cargas (
  id                           SERIAL       PRIMARY KEY,
  agente                       TEXT         NOT NULL REFERENCES ccee_agentes(agente) ON DELETE CASCADE,
  sigla_perfil_agente          TEXT         NOT NULL,
  mes_referencia               CHAR(7)      NOT NULL CHECK (mes_referencia ~ '^\d{4}-\d{2}$'),
  cod_perf_agente              TEXT,
  nome_empresarial             TEXT,
  cod_parcela_carga            TEXT,
  sigla_parcela_carga          TEXT,
  cnpj_carga                   TEXT,
  cidade                       TEXT,
  estado_uf                    CHAR(2),
  ramo_atividade               TEXT,
  submercado                   TEXT,
  data_migracao                DATE,
  cod_perf_agente_conectado    TEXT,
  sigla_perfil_agente_conectado TEXT,
  capacidade_carga             NUMERIC,
  consumo_acl                  NUMERIC,
  consumo_cativo_parc_livre    NUMERIC,
  consumo_total                NUMERIC,
  created_at                   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_carga_mes UNIQUE (sigla_parcela_carga, mes_referencia)
);

CREATE INDEX idx_ccee_cargas_agente          ON ccee_cargas (agente);
CREATE INDEX idx_ccee_cargas_mes             ON ccee_cargas (mes_referencia);
CREATE INDEX idx_ccee_cargas_estado          ON ccee_cargas (estado_uf);
CREATE INDEX idx_ccee_cargas_cidade          ON ccee_cargas (cidade);
CREATE INDEX idx_ccee_cargas_ramo            ON ccee_cargas (ramo_atividade);
CREATE INDEX idx_ccee_cargas_submercado      ON ccee_cargas (submercado);
