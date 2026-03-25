require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(cors());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});


// 🔥 normalização do nome
function normalizarAgente(nome) {
  return nome
    .replace(" LTDA.", "")
    .replace(" LTDA", "")
    .trim()
    .toUpperCase();
}


// 🔥 FUNÇÃO PRINCIPAL → POWER BI
async function buscarPowerBI(agente) {

  console.log("🌐 buscando Power BI:", agente);

  const body = {
    version: "1.0.0",
    queries: [
      {
        Query: {
          Commands: [
            {
              SemanticQueryDataShapeCommand: {
                Query: {
                  Version: 2,
                  From: [
                    { Name: "s", Entity: "SEGURANCA_MERCADO", Type: 0 },
                    { Name: "t", Entity: "TabelaBusca", Type: 0 },
                    { Name: "c", Entity: "CALENDARIO", Type: 0 }
                  ],
                  Select: [
                    {
                      Column: {
                        Expression: { SourceRef: { Source: "s" } },
                        Property: "DS_ACR"
                      }
                    },
                    {
                      Aggregation: {
                        Expression: {
                          Column: {
                            Expression: { SourceRef: { Source: "s" } },
                            Property: "VL_ACR"
                          }
                        },
                        Function: 0
                      }
                    }
                  ],
                  Where: [
                    {
                      Condition: {
                        In: {
                          Expressions: [
                            {
                              Column: {
                                Expression: { SourceRef: { Source: "t" } },
                                Property: "Valor"
                              }
                            }
                          ],
                          Values: [
                            [
                              {
                                Literal: {
                                  Value: `'${agente}'`
                                }
                              }
                            ]
                          ]
                        }
                      }
                    },
                    {
                      Condition: {
                        In: {
                          Expressions: [
                            {
                              Column: {
                                Expression: { SourceRef: { Source: "t" } },
                                Property: "Tipo"
                              }
                            }
                          ],
                          Values: [
                            [
                              { Literal: { Value: "'Agente'" } }
                            ]
                          ]
                        }
                      }
                    },
                    {
                      Condition: {
                        In: {
                          Expressions: [
                            {
                              Column: {
                                Expression: { SourceRef: { Source: "c" } },
                                Property: "FiltroMesAno"
                              }
                            }
                          ],
                          Values: [
                            [
                              { Literal: { Value: "'(mais recente)'" } }
                            ]
                          ]
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
    ],
    modelId: Number(process.env.POWERBI_MODEL_ID)
  };

  const res = await fetch(
    "https://wabi-brazil-south-b-primary-api.analysis.windows.net/public/reports/querydata?synchronous=true",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PowerBI-ResourceKey": process.env.POWERBI_RESOURCE_KEY
      },
      body: JSON.stringify(body)
    }
  );

  const json = await res.json();

  console.log("📥 resposta Power BI recebida");

  // 🔥 EXTRAÇÃO DO DSR
  const dsr = json?.results?.[0]?.result?.data?.dsr?.DS?.[0];

  if (!dsr) throw new Error("sem DSR");

  const dm = dsr?.PH?.[1]?.DM1;

  if (!dm) throw new Error("sem DM1");

  const map = {};

  dm.forEach(x => {
    if (x.C) {
      map[x.C[0]] = x.C[1];
    }
  });

  console.log("📊 dados extraídos:", {
    agente,
    consumo: Number(map["Consumo"]),
    compra: Number(map["Compra"]),
    mcp: Number(map["MCP"]),
    resultado: Number(map["Resultado com Ajustes"]),
    resultadoMCP: Number(map["Resultado do MCP"]),
    balancoEnergetico: Number(map["Balanço Energético"]),
    mes: "mais_recente"
  });

  return {
    agente,
    consumo: Number(map["Consumo"]),
    compra: Number(map["Compra"]),
    mcp: Number(map["MCP"]),
    resultado: Number(map["Resultado com Ajustes"]),
    resultadoMCP: Number(map["Resultado do MCP"]),
    balancoEnergetico: Number(map["Balanço Energético"]),
    mes: "mais_recente"
  };
}


// 💾 salvar no banco
async function salvar(dado) {

  await pool.query(`
    INSERT INTO ccee_dados
    (agente, consumo, compra, mcp, resultado, resultado_mcp, balanco_energetico, mes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (agente, mes) DO NOTHING
  `, [
    dado.agente,
    dado.consumo,
    dado.compra,
    dado.mcp,
    dado.resultado,
    dado.resultadoMCP,
    dado.balancoEnergetico,
    dado.mes
  ]);
}


// 🚀 ENDPOINT PRINCIPAL
app.get("/inteligencia/:agente", async (req, res) => {

  const agenteRaw = decodeURIComponent(req.params.agente);
  const agente = normalizarAgente(agenteRaw);

  console.log("🔎 agente:", agente);

  try {

    // 🟢 1. busca no banco
    const r = await pool.query(`
      SELECT *
      FROM ccee_dados
      WHERE agente = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [agente]);

    if (r.rows.length > 0) {
      console.log("✅ veio do banco");
      return res.json(r.rows[0]);
    }

    // 🔴 2. fallback → Power BI
    console.log("⚠️ não encontrado, buscando externo");

    const dados = await buscarPowerBI(agente);

    await salvar(dados);

    return res.json(dados);

  } catch (e) {
    console.error("❌ erro:", e.message);
    res.status(500).json({ erro: "erro interno" });
  }
});


app.listen(3001, () => {
  console.log("API rodando em http://localhost:3001");
});