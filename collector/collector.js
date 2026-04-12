require("dotenv").config();

const fetch = require("node-fetch");

const API_URL = process.env.API_URL || "http://localhost:3001";

// Lista de agentes a coletar — adicione mais conforme necessário
const AGENTES = [
  "SALITRE FERTILIZANTES LTDA."
];

async function coletarAgente(nome) {
  const encoded = encodeURIComponent(nome);
  const url = `${API_URL}/inteligencia/${encoded}`;

  console.log("Coletando:", nome);

  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  return data;
}

async function run() {
  console.log("Iniciando collector...");

  for (const agente of AGENTES) {
    try {
      const dados = await coletarAgente(agente);
      console.log("OK:", agente, "| consumo:", dados.consumo);
    } catch (e) {
      console.error("Erro:", agente, "-", e.message);
    }
  }

  console.log("Collector finalizado");
}

run();
