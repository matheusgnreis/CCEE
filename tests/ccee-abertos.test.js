// tests/ccee-abertos.test.js
// Testa o módulo api/ccee-abertos.js (nenhuma rede real é usada).

process.env.NODE_ENV = "test";

let mockFetchImpl = jest.fn();
jest.mock("node-fetch", () => (...args) => mockFetchImpl(...args));

const { buscaDados, anosDisponiveis, normalizarMes } = require("../api/ccee-abertos");

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

// ─── buscaDados ───────────────────────────────────────────────────────────────

describe("buscaDados", () => {

  it("busca todos os anos quando nenhum filtro é passado", async () => {
    const anosTotal = anosDisponiveis().length;
    // Cada ano retorna 1 registro
    for (let i = 0; i < anosTotal; i++) {
      mockFetchImpl.mockResolvedValueOnce(
        ckanOk(registrosMCP("TST", [`${2023 + i}-01`]))
      );
    }

    const resultado = await buscaDados("TST");

    expect(mockFetchImpl).toHaveBeenCalledTimes(anosTotal);
    expect(resultado).toHaveLength(anosTotal);
  });

  it("converte sigla para maiúsculo", async () => {
    mockFetchImpl.mockResolvedValue(ckanOk([]));

    await buscaDados("tst", { anos: [2024] });

    const url = mockFetchImpl.mock.calls[0][0];
    expect(url).toContain("SIGLA_AGENTE");
    expect(url).toContain("TST");
  });

  it("filtra por mês específico e busca apenas o ano correspondente", async () => {
    mockFetchImpl.mockResolvedValueOnce(
      ckanOk(registrosMCP("IFG", ["2024-03"]))
    );

    const resultado = await buscaDados("IFG", { mes: "2024-03" });

    expect(mockFetchImpl).toHaveBeenCalledTimes(1);
    expect(resultado).toHaveLength(1);
    expect(resultado[0].mes_referencia).toBe("2024-03");
  });

  it("aceita mês no formato YYYYMM", async () => {
    mockFetchImpl.mockResolvedValueOnce(
      ckanOk(registrosMCP("IFG", ["2024-03"]))
    );

    const resultado = await buscaDados("IFG", { mes: "202403" });

    expect(mockFetchImpl).toHaveBeenCalledTimes(1);
    expect(resultado[0].mes_referencia).toBe("2024-03");
  });

  it("filtra por anos específicos", async () => {
    mockFetchImpl
      .mockResolvedValueOnce(ckanOk(registrosMCP("IFG", ["2024-01"])))
      .mockResolvedValueOnce(ckanOk(registrosMCP("IFG", ["2025-01"])));

    const resultado = await buscaDados("IFG", { anos: [2024, 2025] });

    expect(mockFetchImpl).toHaveBeenCalledTimes(2);
    expect(resultado).toHaveLength(2);
  });

  it("normaliza chaves dos campos para lowercase", async () => {
    mockFetchImpl.mockResolvedValueOnce(
      ckanOk([{ _id: 1, SIGLA_AGENTE: "IFG", MES_REFERENCIA: "202401", VL_MCP: 500 }])
    );

    const resultado = await buscaDados("IFG", { anos: [2024] });

    expect(resultado[0]).toHaveProperty("sigla_agente", "IFG");
    expect(resultado[0]).toHaveProperty("mes_referencia", "2024-01");
    expect(resultado[0]).toHaveProperty("vl_mcp", 500);
    expect(resultado[0]).not.toHaveProperty("_id");
  });

  it("retorna dados ordenados por mês ASC", async () => {
    mockFetchImpl.mockResolvedValueOnce(
      ckanOk(registrosMCP("IFG", ["2024-03", "2024-01", "2024-02"]))
    );

    const resultado = await buscaDados("IFG", { anos: [2024] });

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

    const resultado = await buscaDados("BIG", { anos: [2024] });

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
      .mockResolvedValueOnce(ckanOk(registrosMCP("IFG", ["2024-01"])))
      .mockResolvedValue(ckanOk([]));

    const resultado = await buscaDados("IFG");

    // Não lança exceção, retorna o que foi possível buscar
    expect(Array.isArray(resultado)).toBe(true);
    expect(resultado.some(r => r.mes_referencia === "2024-01")).toBe(true);
  });

  it("retorna array vazio quando nenhum registro é encontrado", async () => {
    mockFetchImpl.mockResolvedValue(ckanOk([]));

    const resultado = await buscaDados("NAOEXISTE");

    expect(resultado).toHaveLength(0);
  });

  it("lança erro para ano não mapeado no filtro de mês", async () => {
    await expect(buscaDados("IFG", { mes: "2020-01" }))
      .rejects
      .toThrow(/2020/);
  });

  it("lança erro quando todos os anos solicitados são inválidos", async () => {
    await expect(buscaDados("IFG", { anos: [2019, 2020] }))
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

    const resultado = await buscaDados("IFG", { anos: [2024, 2025] });

    // Não lança — retorna o que foi possível coletar
    expect(Array.isArray(resultado)).toBe(true);
    // Loga o erro do timeout para o ano afetado
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Timeout/i));

    warnSpy.mockRestore();
  }, 25000);

});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});
