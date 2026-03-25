require("dotenv").config();
const fetch = require("node-fetch");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 🔥 função para buscar da sua API (ou futura API interna)
async function buscarAgente(nome) {

  const encoded = encodeURIComponent(nome);

  const url = `http://localhost:3001/inteligencia/${encoded}`;

  console.log("🔎 buscando:", url);

  const res = await fetch(url);
  const data = await res.json();

  console.log("📥 retorno:", data);

  return data;
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

  console.log("🚀 rodando collector REAL...");

  const agentes = [
    "SALITRE FERTILIZANTES LTDA."
  ];

  for (const agente of agentes) {

    try {

      const dados = await buscarAgente(agente);

      if (!dados || dados.erro) {
        console.log("⚠️ erro no agente:", agente);
        continue;
      }

      await salvar(dados);

      console.log("💾 salvo:", agente);

    } catch (e) {
      console.error("❌ erro:", agente, e.message);
    }

  }

  console.log("✅ collector finalizado");
}

run();