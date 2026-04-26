// scripts/test-consumo.js
// Uso: node scripts/test-consumo.js "SALITRE FERTILIZANTES" 2025-03
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { buscarConsumoHorario } = require("../api/ccee-abertos/consumo-horario");

const agente = process.argv[2] || "SALITRE FERTILIZANTES";
const mes    = process.argv[3] || "2025-03";

console.log(`\nTestando: "${agente}" | ${mes}\n`);

buscarConsumoHorario(agente, mes)
  .then(r => {
    if (!r.length) {
      console.log("\n⚠  Nenhum período retornado.");
    } else {
      console.log(`\n✅ ${r.length} períodos. Primeiros 3:`);
      r.slice(0, 3).forEach(p => console.log("  ", JSON.stringify(p)));
    }
  })
  .catch(e => console.error("\n✖ Erro:", e.message));
