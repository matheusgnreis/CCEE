// api/powerbi-batch.js
// Busca histórico de consumo, compra, venda, balanço, MCP e geração do Power BI
// para uso em lote (rodar-tudo.js). Faz apenas Q0+Q1+Q2 (histórico ~2 anos).
// Não faz metadados (já estão em ccee_agentes) nem dados financeiros do mês atual.

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const fetch = require("node-fetch");
const { POWERBI_URL, extrairSerieDSR, extrairSerieGeracao, mergeHistorico } = require("./powerbi-utils");

const POWERBI_RESOURCE_KEY = process.env.POWERBI_RESOURCE_KEY;
const POWERBI_MODEL_ID     = Number(process.env.POWERBI_MODEL_ID);
const TIMEOUT_MS           = 20000;

// ─── Query principal ──────────────────────────────────────────────────────────

/**
 * Busca histórico mensal (~2 anos) de um agente no Power BI.
 * Usa a sigla do agente (ex: "ACOFORJA") — campo `Tipo = 'Agente'`.
 *
 * @param {string} agente  sigla do agente (campo `agente` em ccee_agentes)
 * @returns {Promise<Array<{ mes, balanco_energetico, mcp, compra, consumo, geracao }>>}
 */
async function buscarHistoricoPowerBI(agente) {
  const agenteEsc = agente.replace(/'/g, "''");

  const filtroAgente = [
    { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Tipo"  } }], Values: [[{ Literal: { Value: "'Agente'"     } }]] } } },
    { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Valor" } }], Values: [[{ Literal: { Value: `'${agenteEsc}'` } }]] } } },
  ];

  const janela2Anos = { Condition: { Between: {
    Expression: { Column: { Expression: { SourceRef: { Source: "c" } }, Property: "DATA" } },
    LowerBound: { DateSpan: { Expression: { DateAdd: { Expression: { DateAdd: { Expression: { Now: {} }, Amount: 1, TimeUnit: 0 } }, Amount: -2, TimeUnit: 3 } }, TimeUnit: 0 } },
    UpperBound: { DateSpan: { Expression: { Now: {} }, TimeUnit: 0 } },
  } } };

  const ordenaMes = { Direction: 1, Expression: { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Source: "c" } }, Property: "MES_ANO_FORMATADO" } }, Function: 3 } } };

  const body = {
    version: "1.0.0",
    modelId: POWERBI_MODEL_ID,
    queries: [
      // Q0 — Balanço Energético + MCP
      { Query: { Commands: [{ SemanticQueryDataShapeCommand: { Query: {
        Version: 2,
        From: [
          { Name: "c", Entity: "CALENDARIO",         Type: 0 },
          { Name: "m", Entity: "MEDIDAS_CALCULADAS", Type: 0 },
          { Name: "t", Entity: "TabelaBusca",        Type: 0 },
        ],
        Select: [
          { Column:      { Expression: { SourceRef: { Source: "c" } }, Property: "ANO"                 } },
          { Column:      { Expression: { SourceRef: { Source: "c" } }, Property: "MES_NOME"             } },
          { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Source: "c" } }, Property: "MES_ANO_FORMATADO" } }, Function: 3 } },
          { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "Balanco_Energetico"   } },
          { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "MCP"                  } },
        ],
        Where: [...filtroAgente, janela2Anos],
        OrderBy: [ordenaMes],
      }, Binding: { Primary: { Groupings: [{ Projections: [0,1,2,3,4] }] }, DataReduction: { DataVolume: 4, Primary: { Window: { Count: 1000 } } }, SuppressedJoinPredicates: [2], Version: 1 } } }] } },

      // Q1 — Compra (Recurso) + Consumo (Requisito)
      { Query: { Commands: [{ SemanticQueryDataShapeCommand: { Query: {
        Version: 2,
        From: [
          { Name: "c", Entity: "CALENDARIO",         Type: 0 },
          { Name: "m", Entity: "MEDIDAS_CALCULADAS", Type: 0 },
          { Name: "t", Entity: "TabelaBusca",        Type: 0 },
        ],
        Select: [
          { Column:      { Expression: { SourceRef: { Source: "c" } }, Property: "ANO"                 } },
          { Column:      { Expression: { SourceRef: { Source: "c" } }, Property: "MES_NOME"             } },
          { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Source: "c" } }, Property: "MES_ANO_FORMATADO" } }, Function: 3 } },
          { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "Recurso"              } },
          { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "Requisito"            } },
        ],
        Where: [...filtroAgente, janela2Anos],
        OrderBy: [ordenaMes],
      }, Binding: { Primary: { Groupings: [{ Projections: [0,1,2,3,4] }] }, DataReduction: { DataVolume: 4, Primary: { Window: { Count: 1000 } } }, SuppressedJoinPredicates: [2], Version: 1 } } }] } },

      // Q2 — Montante Gerado
      { Query: { Commands: [{ SemanticQueryDataShapeCommand: { Query: {
        Version: 2,
        From: [
          { Name: "c", Entity: "CALENDARIO",         Type: 0 },
          { Name: "m", Entity: "MEDIDAS_CALCULADAS", Type: 0 },
          { Name: "t", Entity: "TabelaBusca",        Type: 0 },
        ],
        Select: [
          { Column:      { Expression: { SourceRef: { Source: "c" } }, Property: "ANO"                  } },
          { Column:      { Expression: { SourceRef: { Source: "c" } }, Property: "MES_NOME"              } },
          { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Source: "c" } }, Property: "MES_ANO_FORMATADO" } }, Function: 3 } },
          { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "Montante Gerado"       } },
          { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "Compra"                } },
          { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "% compra"              } },
          { Measure:     { Expression: { SourceRef: { Source: "m" } }, Property: "% de geração alocada no recurso do agente" } },
        ],
        Where: [...filtroAgente, janela2Anos],
        OrderBy: [ordenaMes],
      }, Binding: { Primary: { Groupings: [{ Projections: [0,1,2,3,4,5,6] }] }, DataReduction: { DataVolume: 4, Primary: { Window: { Count: 1000 } } }, SuppressedJoinPredicates: [2,5,6], Version: 1 } } }] } },
    ],
    cancelQueries: [],
  };

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(POWERBI_URL, {
      method: "POST",
      headers: {
        "Content-Type":          "application/json",
        "X-PowerBI-ResourceKey": POWERBI_RESOURCE_KEY,
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Power BI HTTP ${res.status}`);

    const json  = await res.json();
    const jobs  = json?.jobIds || [];
    const byJob = {};
    (json?.results || []).forEach(r => { byJob[r.jobId] = r; });

    const q0 = byJob[jobs[0]] || null;
    const q1 = byJob[jobs[1]] || null;
    const q2 = byJob[jobs[2]] || null;

    const serieBalMcp   = extrairSerieDSR(q0, "balanco_energetico", "mcp");
    const serieCompCons = extrairSerieDSR(q1, "compra",             "consumo");
    const serieGeracao  = extrairSerieGeracao(q2);

    return mergeHistorico(mergeHistorico(serieBalMcp, serieCompCons), serieGeracao);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { buscarHistoricoPowerBI };
