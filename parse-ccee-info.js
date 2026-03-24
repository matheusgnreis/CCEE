(async () => {

  const KEY = "xx";
  const MODEL_ID = "xx"
  const URL = "https://wabi-brazil-south-b-primary-api.analysis.windows.net/public/reports/querydata?synchronous=true";

  const AGENTE = "SALITRE FERTILIZANTES";

  // 🔁 meses solicitados
  const MESES = ["2026-01", "2025-12"];

  const headers = () => ({
    "Accept": "application/json",
    "Content-Type": "application/json",
    "X-PowerBI-ResourceKey": KEY,
    "ActivityId": crypto.randomUUID(),
    "RequestId": crypto.randomUUID()
  });

  function getPeriodo(mes) {
    const [ano, m] = mes.split("-");
    const inicio = `${ano}-${m}-01`;
    const fim = new Date(ano, m, 0).toISOString().slice(0, 10);
    return { inicio, fim, label: `${m}/${ano}` };
  }

  // 🔥 EXECUTOR
  async function exec(select, from, inicio, fim) {

    const body = {
      version: "1.0.0",
      modelId: MODEL_ID,
      queries: [
        {
          Query: {
            Commands: [
              {
                SemanticQueryDataShapeCommand: {
                  Query: {
                    Version: 2,
                    From: from,
                    Select: select,
                    Where: [
                      {
                        Condition: {
                          In: {
                            Expressions: [{
                              Column: {
                                Expression: { SourceRef: { Source: "t" } },
                                Property: "Tipo"
                              }
                            }],
                            Values: [[{ Literal: { Value: "'Agente'" } }]]
                          }
                        }
                      },
                      {
                        Condition: {
                          In: {
                            Expressions: [{
                              Column: {
                                Expression: { SourceRef: { Source: "t" } },
                                Property: "Valor"
                              }
                            }],
                            Values: [[{ Literal: { Value: `'${AGENTE}'` } }]]
                          }
                        }
                      },
                      {
                        Condition: {
                          Between: {
                            Expression: {
                              Column: {
                                Expression: { SourceRef: { Source: "c" } },
                                Property: "DATA"
                              }
                            },
                            LowerBound: { Literal: { Value: `datetime'${inicio}'` } },
                            UpperBound: { Literal: { Value: `datetime'${fim}'` } }
                          }
                        }
                      }
                    ]
                  }
                }
              }
            ]
          }
        }
      ]
    };

    const res = await fetch(URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body)
    });

    return res.json();
  }

  // 🔥 PARSER IDENT
  function parseIdent(resp) {
    const ds = resp?.results?.[0]?.result?.data?.dsr?.DS?.[0];
    const root = ds?.PH?.[0]?.DM0?.[0];
    const dict = ds?.ValueDicts || {};

    return {
      tipoConsumidor: root?.G0,
      agente: dict?.D0?.[0],
      cnpj: dict?.D1?.[0],
      aderido: dict?.D2?.[0]
    };
  }

  // 🔥 PARSER INDICADORES (COMPLETO)
  function parseIndicadores(resp) {
    const dm1 = resp?.results?.[0]?.result?.data?.dsr?.DS?.[0]?.PH?.[1]?.DM1;

    const out = {};

    dm1?.forEach(item => {
      if (!item.C) return;
      out[item.C[0]] = Number(item.C[1]);
    });

    return {
      balancoEnergetico: out["Balanço Energético"],
      compra: out["Compra"],
      consumo: out["Consumo"],
      mcp: out["MCP"],
      resultado: out["Resultado com Ajustes"],
      resultadoMCP: out["Resultado do MCP"]
    };
  }

  const resultadoFinal = [];

  for (const mes of MESES) {

    const { inicio, fim, label } = getPeriodo(mes);

    try {

      console.log(`🔎 Buscando ${AGENTE} - ${label}`);

      // IDENT
      const identRaw = await exec(
        [
          { Column: { Expression: { SourceRef: { Source: "s" } }, Property: "NM_CSSE" } },
          { Column: { Expression: { SourceRef: { Source: "s" } }, Property: "NM_RZOA_SOCI" } },
          { Column: { Expression: { SourceRef: { Source: "s" } }, Property: "CNPJ_Formatado" } },
          { Column: { Expression: { SourceRef: { Source: "s" } }, Property: "DS_STAT_AGEN" } }
        ],
        [
          { Name: "s", Entity: "SEGURANCA_MERCADO" },
          { Name: "t", Entity: "TabelaBusca" },
          { Name: "c", Entity: "CALENDARIO" }
        ],
        inicio,
        fim
      );

      // INDICADORES (tudo em uma)
      const indicadoresRaw = await exec(
        [
          { Column: { Expression: { SourceRef: { Source: "s" } }, Property: "DS_ACR" } },
          {
            Aggregation: {
              Expression: {
                Column: { Expression: { SourceRef: { Source: "s" } }, Property: "VL_ACR" }
              },
              Function: 0
            }
          }
        ],
        [
          { Name: "s", Entity: "SEGURANCA_MERCADO" },
          { Name: "t", Entity: "TabelaBusca" },
          { Name: "c", Entity: "CALENDARIO" }
        ],
        inicio,
        fim
      );

      const final = {
        ...parseIdent(identRaw),
        ...parseIndicadores(indicadoresRaw),
        mes: label
      };

      resultadoFinal.push(final);

      console.log("✅ OK:", final);

    } catch (e) {
      console.warn(`❌ erro ${label}`, e);
    }
  }

  console.log("\n🎯 RESULTADO FINAL:", resultadoFinal);

  // salva global
  window.BASE_CCEE = resultadoFinal;

})();
