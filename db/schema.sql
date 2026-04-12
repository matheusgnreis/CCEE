-- Recria as tabelas do zero (limpa tudo)
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
