// tests/ccee-abertos.test.js
// Testa o módulo api/ccee-abertos.js (nenhuma rede real é usada).

process.env.NODE_ENV = "test";

let mockFetchImpl = jest.fn();
jest.mock("node-fetch", () => (...args) => mockFetchImpl(...args));

const { normalizarMes } = require("../api/ccee-abertos/utils");
const { buscarMcp, anosDisponiveis }                        = require("../api/ccee-abertos/mcp");
const { buscarCargas, anosDisponiveis: anosDisponiveisCargas } = require("../api/ccee-abertos/cargas");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ckanOk(records, total = null) {
  return {
    ok:   true,
    json: () => Promise.resolve({
      success: true,
      result:  {
        total:   total ?? records.length,
        records,
      },
    }),
  };
}

function ckanErro(mensagem = "resource not found") {
  return {
    ok:   true,
    json: () => Promise.resolve({
      success: false,
      error:   { message: mensagem },
    }),
  };
}

function registrosMCP(sigla, meses) {
  return meses.map((m, i) => ({
    _id:            i + 1,
    SIGLA_AGENTE:   sigla,
    MES_REFERENCIA: m.replace("-", ""), // API armazena sem traço
    VL_MCP:         (i + 1) * 100,
  }));
}

// ─── normalizarMes ────────────────────────────────────────────────────────────

describe("normalizarMes", () => {
  it("aceita formato YYYY-MM sem alterar", () => {
    expect(normalizarMes("2024-03")).toBe("2024-03");
  });

  it("converte YYYYMM para YYYY-MM", () => {
    expect(normalizarMes("202403")).toBe("2024-03");
  });

  it("converte YYYY/MM para YYYY-MM", () => {
    expect(normalizarMes("2024/03")).toBe("2024-03");
  });

  it("retorna null para valor nulo", () => {
    expect(normalizarMes(null)).toBeNull();
    expect(normalizarMes(undefined)).toBeNull();
  });

  it("retorna string inalterada para formato desconhecido", () => {
    expect(normalizarMes("março/2024")).toBe("março/2024");
  });
});

// ─── anosDisponiveis ─────────────────────────────────────────────────────────

describe("anosDisponiveis", () => {
  it("retorna array com os anos mapeados", () => {
    const anos = anosDisponiveis();
    expect(Array.isArray(anos)).toBe(true);
    expect(anos).toContain(2023);
    expect(anos).toContain(2024);
  });
});

// ─── buscarMcp ───────────────────────────────────────────────────────────────

describe("buscarMcp", () => {

  it("busca todos os anos quando nenhum filtro é passado", async () => {
    const anosTotal = anosDisponiveis().length;
    // Cada ano retorna 1 registro
    for (let i = 0; i < anosTotal; i++) {
      mockFetchImpl.mockResolvedValueOnce(
        ckanOk(registrosMCP("TST", [`${2023 + i}-01`]))
      );
    }

    const resultado = await buscarMcp("TST");

    expect(mockFetchImpl).toHaveBeenCalledTimes(anosTotal);
    expect(resultado).toHaveLength(anosTotal);
  });

  it("converte sigla para maiúsculo", async () => {
    mockFetchImpl.mockResolvedValue(ckanOk([]));

    await buscarMcp("tst", { anos: [2024] });

    const url = mockFetchImpl.mock.calls[0][0];
    expect(url).toContain("SIGLA_AGENTE");
    expect(url).toContain("TST");
  });

  it("filtra por mês específico e busca apenas o ano correspondente", async () => {
    mockFetchImpl.mockResolvedValueOnce(
      ckanOk(registrosMCP("SUPERMERCADOS ABC", ["2024-03"]))
    );

    const resultado = await buscarMcp("SUPERMERCADOS ABC", { mes: "2024-03" });

    expect(mockFetchImpl).toHaveBeenCalledTimes(1);
    expect(resultado).toHaveLength(1);
    expect(resultado[0].mes_referencia).toBe("2024-03");
  });

  it("aceita mês no formato YYYYMM", async () => {
    mockFetchImpl.mockResolvedValueOnce(
      ckanOk(registrosMCP("SUPERMERCADOS ABC", ["2024-03"]))
    );

    const resultado = await buscarMcp("SUPERMERCADOS ABC", { mes: "202403" });

    expect(mockFetchImpl).toHaveBeenCalledTimes(1);
    expect(resultado[0].mes_referencia).toBe("2024-03");
  });

  it("filtra por anos específicos", async () => {
    mockFetchImpl
      .mockResolvedValueOnce(ckanOk(registrosMCP("SUPERMERCADOS ABC", ["2024-01"])))
      .mockResolvedValueOnce(ckanOk(registrosMCP("SUPERMERCADOS ABC", ["2025-01"])));

    const resultado = await buscarMcp("SUPERMERCADOS ABC", { anos: [2024, 2025] });

    expect(mockFetchImpl).toHaveBeenCalledTimes(2);
    expect(resultado).toHaveLength(2);
  });

  it("normaliza chaves dos campos para lowercase", async () => {
    mockFetchImpl.mockResolvedValueOnce(
      ckanOk([{ _id: 1, SIGLA_AGENTE: "SUPERMERCADOS ABC", MES_REFERENCIA: "202401", VL_MCP: 500 }])
    );

    const resultado = await buscarMcp("SUPERMERCADOS ABC", { anos: [2024] });

    expect(resultado[0]).toHaveProperty("sigla_agente", "SUPERMERCADOS ABC");
    expect(resultado[0]).toHaveProperty("mes_referencia", "2024-01");
    expect(resultado[0]).toHaveProperty("vl_mcp", 500);
    expect(resultado[0]).not.toHaveProperty("_id");
  });

  it("retorna dados ordenados por mês ASC", async () => {
    mockFetchImpl.mockResolvedValueOnce(
      ckanOk(registrosMCP("SUPERMERCADOS ABC", ["2024-03", "2024-01", "2024-02"]))
    );

    const resultado = await buscarMcp("SUPERMERCADOS ABC", { anos: [2024] });

    expect(resultado[0].mes_referencia).toBe("2024-01");
    expect(resultado[1].mes_referencia).toBe("2024-02");
    expect(resultado[2].mes_referencia).toBe("2024-03");
  });

  it("pagina automaticamente quando total > 1000", async () => {
    // Primeira página: 1000 registros, total = 1100
    const pag1 = Array.from({ length: 1000 }, (_, i) => ({
      _id: i, SIGLA_AGENTE: "BIG", MES_REFERENCIA: "202401", VL_MCP: i,
    }));
    const pag2 = Array.from({ length: 100 }, (_, i) => ({
      _id: 1000 + i, SIGLA_AGENTE: "BIG", MES_REFERENCIA: "202402", VL_MCP: i,
    }));

    mockFetchImpl
      .mockResolvedValueOnce(ckanOk(pag1, 1100)) // offset 0
      .mockResolvedValueOnce(ckanOk(pag2, 1100)); // offset 1000

    const resultado = await buscarMcp("BIG", { anos: [2024] });

    expect(mockFetchImpl).toHaveBeenCalledTimes(2);
    expect(resultado).toHaveLength(1100);

    // Segunda chamada deve ter offset=1000 na URL
    const url2 = mockFetchImpl.mock.calls[1][0];
    expect(url2).toContain("offset=1000");
  });

  it("continua nos outros anos quando um ano falha", async () => {
    // 2023 falha, 2024 ok
    mockFetchImpl
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("") })
      .mockResolvedValueOnce(ckanOk(registrosMCP("SUPERMERCADOS ABC", ["2024-01"])))
      .mockResolvedValue(ckanOk([]));

    const resultado = await buscarMcp("SUPERMERCADOS ABC");

    // Não lança exceção, retorna o que foi possível buscar
    expect(Array.isArray(resultado)).toBe(true);
    expect(resultado.some(r => r.mes_referencia === "2024-01")).toBe(true);
  });

  it("retorna array vazio quando nenhum registro é encontrado", async () => {
    mockFetchImpl.mockResolvedValue(ckanOk([]));

    const resultado = await buscarMcp("NAOEXISTE");

    expect(resultado).toHaveLength(0);
  });

  it("lança erro para ano não mapeado no filtro de mês", async () => {
    await expect(buscarMcp("SUPERMERCADOS ABC", { mes: "2020-01" }))
      .rejects
      .toThrow(/2020/);
  });

  it("lança erro quando todos os anos solicitados são inválidos", async () => {
    await expect(buscarMcp("SUPERMERCADOS ABC", { anos: [2019, 2020] }))
      .rejects
      .toThrow();
  });

  it("ignora o ano afetado em timeout e continua nos demais", async () => {
    // O módulo trata timeout por ano com warn + continua — não lança exceção.
    // Para o ano 2024, simula AbortError; 2025 e 2026 retornam vazio.
    mockFetchImpl
      .mockImplementationOnce((_url, { signal }) =>
        new Promise((_res, rej) => {
          signal.addEventListener("abort", () =>
            rej(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })
      )
      .mockResolvedValue(ckanOk([]));

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const resultado = await buscarMcp("SUPERMERCADOS ABC", { anos: [2024, 2025] });

    // Não lança — retorna o que foi possível coletar
    expect(Array.isArray(resultado)).toBe(true);
    // Loga o erro do timeout para o ano afetado
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Timeout/i));

    warnSpy.mockRestore();
  }, 25000);

});

// ─── buscarCargas ─────────────────────────────────────────────────────────────

function registrosCargas(sigla, meses) {
  return meses.map((m, i) => ({
    _id:                  i + 1,
    SIGLA_PERFIL_AGENTE:  sigla,
    MES_REFERENCIA:       m.replace("-", ""),
    SIGLA_PARCELA_CARGA:  `${sigla}-P${i + 1}`,
    CIDADE:               "SAO PAULO",
    ESTADO_UF:            "SP",
    RAMO_ATIVIDADE:       "INDUSTRIA",
    SUBMERCADO:           "SE",
    CAPACIDADE_CARGA:     1000 + i * 100,
    CONSUMO_ACL:          500 + i * 50,
    CONSUMO_TOTAL:        600 + i * 60,
  }));
}

describe("buscarCargas", () => {

  it("busca todos os anos disponíveis quando nenhum filtro é passado", async () => {
    const anosTotal = anosDisponiveisCargas().length;
    for (let i = 0; i < anosTotal; i++) {
      mockFetchImpl.mockResolvedValueOnce(
        ckanOk(registrosCargas("SALITRE", [`${2024 + i}-01`]))
      );
    }

    const resultado = await buscarCargas("SALITRE");

    expect(mockFetchImpl).toHaveBeenCalledTimes(anosTotal);
    expect(resultado).toHaveLength(anosTotal);
  });

  it("converte sigla para maiúsculo", async () => {
    mockFetchImpl.mockResolvedValue(ckanOk([]));

    await buscarCargas("salitre", { anos: [2024] });

    const url = mockFetchImpl.mock.calls[0][0];
    expect(url).toContain("SIGLA_PERFIL_AGENTE");
    expect(url).toContain("SALITRE");
  });

  it("filtra por anos específicos", async () => {
    mockFetchImpl
      .mockResolvedValueOnce(ckanOk(registrosCargas("SALITRE", ["2024-01"])))
      .mockResolvedValueOnce(ckanOk(registrosCargas("SALITRE", ["2025-01"])));

    const resultado = await buscarCargas("SALITRE", { anos: [2024, 2025] });

    expect(mockFetchImpl).toHaveBeenCalledTimes(2);
    expect(resultado).toHaveLength(2);
  });

  it("normaliza chaves para lowercase e normaliza mes_referencia", async () => {
    mockFetchImpl.mockResolvedValueOnce(
      ckanOk(registrosCargas("SALITRE", ["2024-03"]))
    );

    const resultado = await buscarCargas("SALITRE", { anos: [2024] });

    expect(resultado[0]).toHaveProperty("sigla_perfil_agente", "SALITRE");
    expect(resultado[0]).toHaveProperty("mes_referencia", "2024-03");
    expect(resultado[0]).toHaveProperty("sigla_parcela_carga");
    expect(resultado[0]).not.toHaveProperty("_id");
  });

  it("ordena por mes_referencia ASC e depois por sigla_parcela_carga ASC", async () => {
    const registros = [
      { _id: 1, SIGLA_PERFIL_AGENTE: "X", MES_REFERENCIA: "202403", SIGLA_PARCELA_CARGA: "X-P2" },
      { _id: 2, SIGLA_PERFIL_AGENTE: "X", MES_REFERENCIA: "202401", SIGLA_PARCELA_CARGA: "X-P1" },
      { _id: 3, SIGLA_PERFIL_AGENTE: "X", MES_REFERENCIA: "202403", SIGLA_PARCELA_CARGA: "X-P1" },
    ];
    mockFetchImpl.mockResolvedValueOnce(ckanOk(registros));

    const resultado = await buscarCargas("X", { anos: [2024] });

    expect(resultado[0].mes_referencia).toBe("2024-01");
    expect(resultado[1].sigla_parcela_carga).toBe("X-P1");
    expect(resultado[2].sigla_parcela_carga).toBe("X-P2");
  });

  it("pagina automaticamente quando total > 1000", async () => {
    const pag1 = Array.from({ length: 1000 }, (_, i) => ({
      _id: i, SIGLA_PERFIL_AGENTE: "BIG", MES_REFERENCIA: "202401", SIGLA_PARCELA_CARGA: `P${i}`,
    }));
    const pag2 = Array.from({ length: 50 }, (_, i) => ({
      _id: 1000 + i, SIGLA_PERFIL_AGENTE: "BIG", MES_REFERENCIA: "202402", SIGLA_PARCELA_CARGA: `P${1000 + i}`,
    }));

    mockFetchImpl
      .mockResolvedValueOnce(ckanOk(pag1, 1050))
      .mockResolvedValueOnce(ckanOk(pag2, 1050));

    const resultado = await buscarCargas("BIG", { anos: [2024] });

    expect(mockFetchImpl).toHaveBeenCalledTimes(2);
    expect(resultado).toHaveLength(1050);
    expect(mockFetchImpl.mock.calls[1][0]).toContain("offset=1000");
  });

  it("continua nos outros anos quando um ano falha", async () => {
    mockFetchImpl
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("") })
      .mockResolvedValueOnce(ckanOk(registrosCargas("SALITRE", ["2025-01"])))
      .mockResolvedValue(ckanOk([]));

    const resultado = await buscarCargas("SALITRE");

    expect(Array.isArray(resultado)).toBe(true);
    expect(resultado.some(r => r.mes_referencia === "2025-01")).toBe(true);
  });

  it("retorna array vazio quando nenhuma carga é encontrada", async () => {
    mockFetchImpl.mockResolvedValue(ckanOk([]));

    const resultado = await buscarCargas("NAOEXISTE");

    expect(resultado).toHaveLength(0);
  });

  it("lança erro quando o ano solicitado não está mapeado", async () => {
    await expect(buscarCargas("SALITRE", { anos: [2020] }))
      .rejects
      .toThrow(/disponív/i);
  });

});

// ─── buscarMesRecente ─────────────────────────────────────────────────────────

const { buscarMesRecente } = require("../api/ccee-abertos/mcp");

describe("buscarMesRecente", () => {

  function ckanMesOk(mes) {
    return {
      ok:   true,
      json: () => Promise.resolve({
        success: true,
        result:  { total: 1, records: [{ MES_REFERENCIA: mes.replace("-", "") }] }
      })
    };
  }

  function ckanVazio() {
    return {
      ok:   true,
      json: () => Promise.resolve({ success: true, result: { total: 0, records: [] } })
    };
  }

  it("retorna o mês mais recente normalizado para YYYY-MM", async () => {
    mockFetchImpl.mockResolvedValueOnce(ckanMesOk("2026-03"));

    const mes = await buscarMesRecente("IFG");

    expect(mes).toBe("2026-03");
    expect(mockFetchImpl).toHaveBeenCalledTimes(1);
  });

  it("tenta anos em ordem decrescente e para no primeiro com resultado", async () => {
    // Primeiro ano (mais recente) vazio, segundo tem dado
    mockFetchImpl
      .mockResolvedValueOnce(ckanVazio())
      .mockResolvedValueOnce(ckanMesOk("2025-11"));

    const mes = await buscarMesRecente("IFG");

    expect(mes).toBe("2025-11");
    expect(mockFetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retorna null quando nenhum ano tem dados para a sigla", async () => {
    const totalAnos = anosDisponiveis().length;
    for (let i = 0; i < totalAnos; i++) {
      mockFetchImpl.mockResolvedValueOnce(ckanVazio());
    }

    const mes = await buscarMesRecente("NAOEXISTE");

    expect(mes).toBeNull();
    expect(mockFetchImpl).toHaveBeenCalledTimes(totalAnos);
  });

  it("converte sigla para maiúsculo antes de buscar", async () => {
    mockFetchImpl.mockResolvedValueOnce(ckanMesOk("2025-06"));

    await buscarMesRecente("ifg");

    const url = mockFetchImpl.mock.calls[0][0];
    expect(url).toContain("IFG");
  });

  it("retorna null e continua quando HTTP retorna erro", async () => {
    mockFetchImpl
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce(ckanMesOk("2025-03"));

    const mes = await buscarMesRecente("IFG");

    expect(mes).toBe("2025-03");
  });

  it("resultado tem formato YYYY-MM independente do formato da API", async () => {
    // API retorna YYYYMM sem traço
    mockFetchImpl.mockResolvedValueOnce(ckanMesOk("2025-06"));

    const mes = await buscarMesRecente("IFG");

    expect(mes).toMatch(/^\d{4}-\d{2}$/);
  });

});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});
