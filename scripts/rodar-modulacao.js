// scripts/rodar-modulacao.js
// Roda modulação de carga e geração para uma lista de agentes em sequência.
// Uso: node scripts/rodar-modulacao.js
// Cada agente aguarda o anterior terminar antes de começar.

const API = process.env.API_URL || "http://localhost:3001";
const POLL_MS = 8000; // intervalo de polling

const AGENTES = [
  "MELITTA",
  "AVIVAR",
  "SALITRE FERTILIZANTES",
  "VIBRA",
  "UBERLANDIAREF",
  "LPA",
  "SUPER BH 001"
];

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.json();
}

// Dispara o job via endpoint admin dedicado
async function dispararModulacao(agente) {
  const enc = encodeURIComponent(agente);
  const res = await fetch(`${API}/admin/modulacao/${enc}`, { method: "POST" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  console.log(`  Trigger: ${JSON.stringify(json.status)}`);
}

// Aguarda até que o agente não esteja mais em andamento nem em carga nem em geração.
// Primeiro espera o job aparecer como "calculando"; se não aparecer em MAX_ESPERA_INICIO_S
// segundos, assume que já estava done ou não há trabalho pendente.
const MAX_ESPERA_INICIO_S = 120; // até 2 min para o job aparecer como calculando

async function aguardarConclusao(agente) {
  let tentativas = 0;
  let jobVisto   = false; // se em algum momento apareceu calculando=true

  while (true) {
    tentativas++;
    await new Promise(r => setTimeout(r, POLL_MS));

    let status;
    try {
      status = await fetchJson(`${API}/modulacao/status`);
    } catch (e) {
      console.log(`  [poll] Erro ao consultar status: ${e.message}`);
      continue;
    }

    const info       = status.agentes?.find(a => a.agente === agente);
    const emAndamento = status.em_andamento?.includes(agente);
    const calculando  = info?.carga?.calculando || info?.geracao?.calculando || emAndamento;

    if (calculando) jobVisto = true;

    if (info) {
      const { carga, geracao } = info;
      console.log(`  [poll #${tentativas}] ${agente} | carga: ${carga.calculados}/${info.total_meses} (calc=${carga.calculando}) | geração: ${geracao.calculados}/${info.total_meses} (calc=${geracao.calculando})`);
    } else {
      console.log(`  [poll #${tentativas}] ${agente} não encontrado no status...`);
    }

    // Termina se o job já foi visto calculando e agora parou
    if (jobVisto && !calculando) return info || null;

    // Termina se nunca apareceu calculando após MAX_ESPERA_INICIO_S segundos
    if (!jobVisto && tentativas * POLL_MS / 1000 >= MAX_ESPERA_INICIO_S) {
      console.log(`  [poll] Job não apareceu como calculando após ${MAX_ESPERA_INICIO_S}s — provavelmente já estava concluído.`);
      return info || null;
    }
  }
}

async function main() {
  console.log(`\n🚀 Iniciando modulação sequencial para ${AGENTES.length} agentes\n`);
  console.log(`API: ${API}\n`);

  for (const agente of AGENTES) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`▶  ${agente}`);
    console.log(`${"─".repeat(60)}`);

    console.log(`  Disparando job...`);
    await dispararModulacao(agente);

    // Pequena pausa para o job iniciar e aparecer no status
    await new Promise(r => setTimeout(r, 3000));

    console.log(`  Aguardando conclusão (polling a cada ${POLL_MS / 1000}s)...`);
    const resultado = await aguardarConclusao(agente);

    if (resultado) {
      const { carga, geracao, total_meses } = resultado;
      console.log(`\n  ✅ Concluído!`);
      console.log(`     Carga:  ${carga.calculados}/${total_meses} meses | último: ${carga.ultimo_mes || "—"} | custo médio: ${carga.custo_medio != null ? carga.custo_medio + " R$/MWh" : "—"}`);
      console.log(`     Geração: ${geracao.calculados}/${total_meses} meses | último: ${geracao.ultimo_mes || "—"} | custo médio: ${geracao.custo_medio != null ? geracao.custo_medio + " R$/MWh" : "—"}`);
    } else {
      console.log(`\n  ⚠  Agente não apareceu no status — pode não ter dados ou o job já terminou.`);
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`✅ Todos os agentes processados.`);
  console.log(`${"═".repeat(60)}\n`);
}

main().catch(e => {
  console.error("Erro fatal:", e.message);
  process.exit(1);
});
