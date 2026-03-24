CREATE TABLE ccee_dados (
    id SERIAL PRIMARY KEY,
    agente TEXT,
    cnpj TEXT,
    tipo_consumidor TEXT,
    aderido TEXT,
    balanco_energetico NUMERIC,
    consumo NUMERIC,
    compra NUMERIC,
    mcp NUMERIC,
    resultado NUMERIC,
    resultado_mcp NUMERIC,
    mes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX uniq_agente_mes
ON ccee_dados (agente, mes);