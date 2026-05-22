// scripts/agendar-batch.js
// Executa rodar-modulacao-batch.js em loop com intervalo configurável.
//
// Uso:
//   node scripts/agendar-batch.js                  # roda agora + a cada 24h
//   node scripts/agendar-batch.js --intervalo 6    # a cada 6 horas
//   node scripts/agendar-batch.js --intervalo 0    # roda uma vez e sai

const { spawn }   = require("child_process");
const path        = require("path");

const args        = process.argv.slice(2);
const flagIdx     = args.indexOf("--intervalo");
const intervaloH  = flagIdx >= 0 ? parseFloat(args[flagIdx + 1]) : 24;

const SCRIPT = path.join(__dirname, "rodar-modulacao-batch.js");

function timestamp() {
  return new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function rodar() {
  return new Promise((resolve) => {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`[${timestamp()}] Iniciando batch...`);
    console.log(`${"=".repeat(60)}`);

    const child = spawn(process.execPath, [SCRIPT], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("close", (code) => {
      if (code !== 0) console.warn(`[${timestamp()}] Batch terminou com código ${code}`);
      resolve();
    });
  });
}

async function main() {
  await rodar();

  if (intervaloH <= 0) return;

  while (true) {
    const proxima = new Date(Date.now() + intervaloH * 3600 * 1000);
    console.log(`\n[${timestamp()}] Próxima execução: ${proxima.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`);
    console.log("Pressione Ctrl+C para interromper.");
    await new Promise(r => setTimeout(r, intervaloH * 3600 * 1000));
    await rodar();
  }
}

main().catch(e => { console.error("Erro:", e.message); process.exit(1); });
