require("dotenv").config();
const fetch = require("node-fetch");
const { Pool } = require("pg");

// 🔥 banco
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://postgres:123456@localhost:5432/ccee"
});

// 🔥 config BI
const URL = "https://wabi-brazil-south-b-primary-api.analysis.windows.net/public/reports/querydata?synchronous=true";

const RESOURCE_KEY = "f6267020-1b73-4885-8920-19a9d09f1395";
const MODEL_ID = 7427061;

// 🔥 headers
function headers() {
  return {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "X-PowerBI-ResourceKey": RESOURCE_KEY
  };
}

// 🔁 pegar dados (simplificado - SALITRE)
async function getDadosAgente(agente) {

  // 👉 aqui você depois pode colocar seu body completo
  return {
    agente,
    cnpj: "43.066.666/0001-55",
    tipoConsumidor: "Consumidor Livre",
    aderido: "Aderido",
    consumo: 25.4,
    compra: 26.11,
    mcp: 179777,
    resultado: 119091,
    resultadoMCP: 114166,
    balancoEnergetico: 0.71,
    mes: "01/2026"
  };
}

// 💾 salvar no banco
async function salvar(dado) {

  const query = `
    INSERT INTO ccee_dados 
    (agente, cnpj, tipo_consumidor, aderido, balanco_energetico, consumo, compra, mcp, resultado, resultado_mcp, mes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (agente, mes) DO NOTHING
  `;

  const values = [
    dado.agente,
    dado.cnpj,
    dado.tipoConsumidor,
    dado.aderido,
    dado.balancoEnergetico,
    dado.consumo,
    dado.compra,
    dado.mcp,
    dado.resultado,
    dado.resultadoMCP,
    dado.mes
  ];

  await pool.query(query, values);
}

// 🚀 execução
async function run() {

  console.log("🚀 rodando collector...");

  const agente = "SALITRE FERTILIZANTES";

  const dados = await getDadosAgente(agente);

  console.log("📊 dados:", dados);

  await salvar(dados);

  console.log("💾 salvo no banco");
}

run();