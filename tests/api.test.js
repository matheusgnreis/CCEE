// tests/api.test.js
// Testa as rotas do Express sem subir o servidor real.
// pg e node-fetch são mockados — nenhuma conexão de rede real é feita.

process.env.NODE_ENV          = "test";
process.env.DATABASE_URL      = "postgres://test";
process.env.POWERBI_MODEL_ID  = "12345";
process.env.POWERBI_RESOURCE_KEY = "test-key";

// ─── Mock: pg ────────────────────────────────────────────────────────────────
let mockQueryImpl = jest.fn();

jest.mock("pg", () => {
  const mockQuery = (...args) => mockQueryImpl(...args);
  const Pool = jest.fn(() => ({ query: mockQuery, on: jest.fn() }));
  return { Pool };
});

// ─── Mock: node-fetch ────────────────────────────────────────────────────────
let mockFetchImpl = jest.fn();
jest.mock("node-fetch", () => (...args) => mockFetchImpl(...args));

const request = require("supertest");
const app     = require("../api/index");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Linha completa retornada pelo banco (cache hit) */
function dbRow(overrides = {}) {
  return {
    agente:             "AGENTE TESTE",
    consumo:            "100.50",
    compra:             "90.00",
    mcp:                "-500.00",
    resultado:          "200.00",
    resultado_mcp:      "150.00",
    balanco_energetico: "10.50",
    mes:                "2024-03",
    razao_social:       "Razão Social Teste Ltda",
    sigla:              "AGT",
    cnpj:               "12.345.678/0001-99",
    classe:             "Consumidor",
    situacao:           "Ativo",
    capital_social:     "1000000",
    ...overrides,
  };
}

/** Monta o payload que o Power BI retorna para buscarPowerBI() */
function powerBIPayload(agente = "AGENTE TESTE") {
  return {
    jobIds:  ["j0", "j1", "j2", "j3"],
    results: [
      // Q0 — dados financeiros do mês
      {
        jobId:  "j0",
        result: {
          data: {
            dsr: {
              DS: [{
                PH: [
                  null,
                  {
                    DM1: [
                      { C: ["Consumo",               100.5]  },
                      { C: ["Compra",                 90.0]  },
                      { C: ["MCP",                  -500.0]  },
                      { C: ["Resultado com Ajustes",  200.0] },
                      { C: ["Resultado do MCP",       150.0] },
                      { C: ["Balanço Energético",      10.5] },
                    ]
                  }
                ]
              }]
            }
          }
        }
      },
      // Q1 — histórico (Balanço + MCP)
      {
        jobId:  "j1",
        result: {
          data: {
            dsr: {
              DS: [{
                PH: [{
                  DM0: [
                    { C: [2024, "Mar", 0,  10.5, -500.0] },
                  ]
                }],
                ValueDicts: { D1: ["2024/03"] }
              }]
            }
          }
        }
      },
      // Q2 — metadados
      {
        jobId:  "j2",
        result: {
          data: {
            dsr: {
              DS: [{
                PH: [{ DM0: [{ C: [0, 0, 0, 0, 0, 1000000] }] }],
                ValueDicts: {
                  D0: ["Consumidor"],
                  D1: ["Razão Social Teste Ltda"],
                  D2: ["AGT"],
                  D3: ["12.345.678/0001-99"],
                  D4: ["Ativo"],
                }
              }]
            }
          }
        }
      },
      // Q3 — histórico (Compra + Consumo)
      {
        jobId:  "j3",
        result: {
          data: {
            dsr: {
              DS: [{
                PH: [{
                  DM0: [
                    { C: [2024, "Mar", 0, 90.0, 100.5] },
                  ]
                }],
                ValueDicts: { D1: ["2024/03"] }
              }]
            }
          }
        }
      },
    ]
  };
}

function mockFetchOk(body) {
  return Promise.resolve({
    ok:   true,
    json: () => Promise.resolve(body),
  });
}

// ─── GET /health ──────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("retorna 200 com status ok quando banco responde", async () => {
    mockQueryImpl.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.db).toBe("connected");
    expect(res.body.ts).toBeDefined();
  });

  it("retorna 503 quando banco falha", async () => {
    mockQueryImpl.mockRejectedValueOnce(new Error("connection refused"));

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
    expect(res.body.db).toBe("disconnected");
  });
});

// ─── GET /inteligencia/:agente ────────────────────────────────────────────────

describe("GET /inteligencia/:agente", () => {

  it("retorna 400 para nome de agente muito curto", async () => {
    const res = await request(app).get("/inteligencia/A");
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("retorna 400 para formato de mês inválido", async () => {
    const res = await request(app).get("/inteligencia/AGENTE?mes=2024-3");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mês/i);
  });

  it("retorna dados do banco quando há cache (resultado não nulo)", async () => {
    const row = dbRow();
    // Primeira query: SELECT no banco
    mockQueryImpl.mockResolvedValueOnce({ rows: [row] });

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE?mes=2024-03");

    expect(res.status).toBe(200);
    expect(res.body.agente).toBe("AGENTE TESTE");
    expect(res.body.consumo).toBe("100.50");
    expect(res.body.situacao).toBe("Ativo");
    // Não deve ter chamado o Power BI
    expect(mockFetchImpl).not.toHaveBeenCalled();
  });

  it("busca Power BI quando agente não está no banco", async () => {
    // Banco não tem o agente
    mockQueryImpl.mockResolvedValueOnce({ rows: [] });
    // salvarAgente INSERT
    mockQueryImpl.mockResolvedValueOnce({ rows: [] });
    // salvarHistorico INSERT
    mockQueryImpl.mockResolvedValueOnce({ rows: [] });
    // salvarDados INSERT
    mockQueryImpl.mockResolvedValueOnce({ rows: [] });

    mockFetchImpl.mockResolvedValueOnce(mockFetchOk(powerBIPayload()));

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE?mes=2024-03");

    expect(res.status).toBe(200);
    expect(mockFetchImpl).toHaveBeenCalledTimes(1);
    expect(res.body.consumo).toBe(100.5);
    expect(res.body.classe).toBe("Consumidor");
  });

  it("retorna 500 quando Power BI falha", async () => {
    mockQueryImpl.mockResolvedValueOnce({ rows: [] });
    mockFetchImpl.mockResolvedValueOnce({
      ok:     false,
      status: 503,
      json:   () => Promise.resolve({}),
    });

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE?mes=2024-03");

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });

  it("busca apenas Q0+Q2 quando linha existe mas resultado é NULL", async () => {
    const rowSemResultado = dbRow({ resultado: null });
    mockQueryImpl.mockResolvedValueOnce({ rows: [rowSemResultado] });
    // salvarAgente + salvarDados
    mockQueryImpl.mockResolvedValueOnce({ rows: [] });
    mockQueryImpl.mockResolvedValueOnce({ rows: [] });

    // Power BI Q0+Q2 (buscarPowerBISimples tem 2 queries)
    const payloadSimples = {
      jobIds:  ["j0", "j1"],
      results: [
        powerBIPayload().results[0], // Q0
        powerBIPayload().results[2], // Q2
      ]
    };
    payloadSimples.results[0].jobId = "j0";
    payloadSimples.results[1].jobId = "j1";

    mockFetchImpl.mockResolvedValueOnce(mockFetchOk(payloadSimples));

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE?mes=2024-03");

    expect(res.status).toBe(200);
    expect(mockFetchImpl).toHaveBeenCalledTimes(1);
  });

});

// ─── GET /inteligencia/:agente/historico ──────────────────────────────────────

describe("GET /inteligencia/:agente/historico", () => {

  it("retorna array vazio quando agente não tem histórico", async () => {
    mockQueryImpl.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE/historico");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("retorna histórico completo ordenado por mês", async () => {
    const rows = [
      dbRow({ mes: "2024-01" }),
      dbRow({ mes: "2024-02" }),
      dbRow({ mes: "2024-03" }),
    ];
    mockQueryImpl.mockResolvedValueOnce({ rows });

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE/historico");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0].mes).toBe("2024-01");
    expect(res.body[2].mes).toBe("2024-03");
  });

  it("retorna 400 para agente inválido", async () => {
    const res = await request(app).get("/inteligencia/X/historico");
    expect(res.status).toBe(400);
  });

  it("retorna 500 quando banco falha", async () => {
    mockQueryImpl.mockRejectedValueOnce(new Error("DB error"));

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE/historico");

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });

});

// ─── GET /inteligencia/:agente?refresh=1 ─────────────────────────────────────

describe("GET /inteligencia/:agente com ?refresh=1", () => {

  it("ignora cache e busca diretamente no Power BI", async () => {
    mockQueryImpl.mockResolvedValue({ rows: [] });
    mockFetchImpl.mockResolvedValueOnce(mockFetchOk(powerBIPayload()));

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE?mes=2024-03&refresh=1");

    expect(res.status).toBe(200);
    expect(mockFetchImpl).toHaveBeenCalledTimes(1);
    expect(res.body.consumo).toBe(100.5);
  });

  it("retorna 500 quando Power BI falha mesmo com refresh", async () => {
    mockFetchImpl.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) });

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE?mes=2024-03&refresh=1");

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });

});

// ─── GET /inteligencia/:agente — freshness check ──────────────────────────────

describe("GET /inteligencia/:agente freshness check", () => {

  function ckanMesOk(mes) {
    return {
      ok:   true,
      json: () => Promise.resolve({
        success: true,
        result:  { total: 1, records: [{ MES_REFERENCIA: mes.replace("-", "") }] }
      })
    };
  }

  it("não rebusca quando CCEE tem o mesmo mês que o banco", async () => {
    const row = dbRow({ mes: "2024-03" });
    mockQueryImpl.mockResolvedValueOnce({ rows: [row] });                     // SELECT dados
    mockQueryImpl.mockResolvedValueOnce({ rows: [{ mes: "2024-03" }] });      // SELECT MAX(mes)
    mockFetchImpl.mockResolvedValueOnce(ckanMesOk("2024-03"));               // buscarMesRecente

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE");

    expect(res.status).toBe(200);
    expect(res.body.agente).toBe("AGENTE TESTE");
    // Power BI não foi chamado (CKAN sim, mas só para checar mês)
    expect(mockFetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rebusca no Power BI quando CCEE tem mês mais recente que o banco", async () => {
    const row = dbRow({ mes: "2024-03" });
    mockQueryImpl.mockResolvedValueOnce({ rows: [row] });                     // SELECT dados
    mockQueryImpl.mockResolvedValueOnce({ rows: [{ mes: "2024-03" }] });      // SELECT MAX(mes)
    mockFetchImpl.mockResolvedValueOnce(ckanMesOk("2024-04"));               // buscarMesRecente → mês novo
    mockFetchImpl.mockResolvedValueOnce(mockFetchOk(powerBIPayload()));       // Power BI
    mockQueryImpl.mockResolvedValue({ rows: [] });                            // salvarAgente/Histórico/Dados

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE");

    expect(res.status).toBe(200);
    // fetch chamado 2x: CKAN (buscarMesRecente) + Power BI
    expect(mockFetchImpl).toHaveBeenCalledTimes(2);
    expect(res.body.consumo).toBe(100.5);
  });

});

// ─── GET /inteligencia/:agente/cargas ─────────────────────────────────────────

describe("GET /inteligencia/:agente/cargas", () => {

  function cargaRow(overrides = {}) {
    return {
      id:                  1,
      agente:              "AGENTE TESTE",
      sigla_perfil_agente: "AGENTE TESTE",
      mes_referencia:      "2025-01",
      sigla_parcela_carga: "CARGA-01",
      cidade:              "SAO PAULO",
      estado_uf:           "SP",
      ramo_atividade:      "COMERCIO",
      submercado:          "SE",
      consumo_acl:         "500",
      consumo_total:       "600",
      ...overrides,
    };
  }

  it("retorna 400 para agente inválido", async () => {
    const res = await request(app).get("/inteligencia/X/cargas");
    expect(res.status).toBe(400);
  });

  it("retorna { mes, registros } quando cargas existem no banco e estão atualizadas", async () => {
    const row = cargaRow();
    mockQueryImpl.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });  // SELECT 1 (existe)
    mockQueryImpl.mockResolvedValueOnce({ rows: [{ mes: "2025-12" }] }); // SELECT MAX
    mockQueryImpl.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });  // SELECT 1 mes específico
    mockQueryImpl.mockResolvedValueOnce({ rows: [row] });                // SELECT * final

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE/cargas?mes=2025-01");

    expect(res.status).toBe(200);
    expect(res.body.mes).toBe("2025-01");
    expect(Array.isArray(res.body.registros)).toBe(true);
    expect(res.body.registros[0].sigla_parcela_carga).toBe("CARGA-01");
    expect(mockFetchImpl).not.toHaveBeenCalled();
  });

  it("retorna mês mais recente disponível quando mês solicitado não existe no banco", async () => {
    const row = cargaRow({ mes_referencia: "2025-06" });
    mockQueryImpl.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });  // SELECT 1 (existe)
    mockQueryImpl.mockResolvedValueOnce({ rows: [{ mes: "2025-06" }] }); // SELECT MAX
    mockQueryImpl.mockResolvedValueOnce({ rows: [] });                   // SELECT 1 mes específico (não existe)
    mockQueryImpl.mockResolvedValueOnce({ rows: [{ mes: "2025-06" }] }); // SELECT MAX fallback
    mockQueryImpl.mockResolvedValueOnce({ rows: [row] });                // SELECT * final

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE/cargas?mes=2026-02");

    expect(res.status).toBe(200);
    expect(res.body.mes).toBe("2025-06");
    expect(res.body.registros[0].mes_referencia).toBe("2025-06");
  });

  it("busca na API CCEE quando não há cargas no banco", async () => {
    // Nenhuma carga no banco
    mockQueryImpl.mockResolvedValueOnce({ rows: [] });
    // CKAN: 3 anos (2024, 2025, 2026) todos vazios
    for (let i = 0; i < 3; i++) {
      mockFetchImpl.mockResolvedValueOnce({
        ok:   true,
        json: () => Promise.resolve({ success: true, result: { total: 0, records: [] } })
      });
    }
    // SELECT * final
    mockQueryImpl.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE/cargas");

    expect(res.status).toBe(200);
    expect(mockFetchImpl).toHaveBeenCalledTimes(3); // 1 por ano (CKAN)
    expect(res.body.registros).toHaveLength(0);
  });

  it("aplica filtros opcionais (estado, submercado)", async () => {
    mockQueryImpl.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });  // SELECT 1
    mockQueryImpl.mockResolvedValueOnce({ rows: [{ mes: "2025-01" }] }); // MAX
    mockQueryImpl.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });  // mes específico
    mockQueryImpl.mockResolvedValueOnce({ rows: [] });                   // SELECT * (filtrado)

    const res = await request(app)
      .get("/inteligencia/AGENTE%20TESTE/cargas?mes=2025-01&estado=SP&submercado=SE");

    expect(res.status).toBe(200);
    // Verifica que a query final foi chamada com os filtros (indiretamente pela ausência de erros)
    expect(res.body.registros).toHaveLength(0);
  });

  it("retorna 500 quando banco falha", async () => {
    mockQueryImpl.mockRejectedValueOnce(new Error("DB error"));

    const res = await request(app).get("/inteligencia/AGENTE%20TESTE/cargas");

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });

});

// ─── POST /inteligencia/:agente/refresh ───────────────────────────────────────

describe("POST /inteligencia/:agente/refresh", () => {

  it("força busca no Power BI e retorna dados atualizados", async () => {
    // salvarAgente + salvarHistorico + salvarDados
    mockQueryImpl.mockResolvedValue({ rows: [] });
    mockFetchImpl.mockResolvedValueOnce(mockFetchOk(powerBIPayload()));

    const res = await request(app).post("/inteligencia/AGENTE%20TESTE/refresh?mes=2024-03");

    expect(res.status).toBe(200);
    expect(mockFetchImpl).toHaveBeenCalledTimes(1);
    expect(res.body.consumo).toBe(100.5);
  });

  it("retorna 400 para agente inválido", async () => {
    const res = await request(app).post("/inteligencia/X/refresh");
    expect(res.status).toBe(400);
  });

  it("retorna 500 quando Power BI retorna erro", async () => {
    mockFetchImpl.mockRejectedValueOnce(new Error("Network error"));

    const res = await request(app).post("/inteligencia/AGENTE%20TESTE/refresh");

    expect(res.status).toBe(500);
  });

});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});
