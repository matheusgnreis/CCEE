const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
app.use(cors());

// 🔥 conexão com banco (por enquanto pode deixar assim)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://postgres:123456@localhost:5432/ccee"
});

// 🔎 teste básico
app.get("/", (req, res) => {
  res.send("API rodando 🚀");
});

// 🔎 endpoint inteligência
app.get("/inteligencia/:agente", async (req, res) => {

  const agente = req.params.agente;

  try {

    // 🔥 mock temporário (vamos trocar depois por banco real)
    const consumo = 25.4;
    const mcp = 179777;

    const pld = Array.from({ length: 24 }, () => Math.random() * 500);

    const curva = estimarCurva(consumo, mcp, pld);

    res.json({
      agente,
      consumo,
      mcp,
      curva,
      insight: gerarInsight(curva, pld)
    });

  } catch (e) {
    res.status(500).json({ erro: "erro interno" });
  }
});

// 🔥 lógica inteligência
function estimarCurva(consumoTotal, mcp, pld) {

  const base = consumoTotal / pld.length;
  const media = pld.reduce((a,b)=>a+b,0)/pld.length;

  return pld.map(p => base * (p / media));
}

function gerarInsight(curva, pld) {

  const pico = Math.max(...pld);
  const cargaAlta = curva[pld.indexOf(pico)];

  const media = curva.reduce((a,b)=>a+b,0)/curva.length;

  if (cargaAlta > media) {
    return "Consumo concentrado em horário caro → alto custo de modulação";
  }

  return "Perfil equilibrado";
}

// 🚀 porta
app.listen(3001, () => {
  console.log("API rodando em http://localhost:3001");
});