// api/powerbi-utils.js
// Utilitários compartilhados para parsing de respostas DSR do Power BI.
// Usados em api/index.js e api/powerbi-batch.js.

const POWERBI_URL = "https://wabi-brazil-south-b-primary-api.analysis.windows.net/public/reports/querydata?synchronous=true";

// ─── Bitmask DSR ──────────────────────────────────────────────────────────────
// Decodifica array de itens DSR usando bitmask Ø/R em matriz de N colunas.
//   Ø (null-mask) : bit=1 → campo é null, omitido de C
//   R (carry-mask): bit=1 → carrega valor do item anterior
// Retorna Array<Array<any>> com N valores por linha.
function decodificarBitmaskDSR(dm, N) {
  const linhas = [];
  let prev = new Array(N).fill(null);
  for (const item of dm) {
    const C    = item.C || [];
    const full = new Array(N).fill(null);
    let ci     = 0;
    if (typeof item["Ø"] === "number") {
      const mask = item["Ø"];
      for (let i = 0; i < N; i++) full[i] = (mask & (1 << i)) ? null : (C[ci++] ?? null);
    } else {
      const mask = typeof item.R === "number" ? item.R : 0;
      for (let i = 0; i < N; i++) full[i] = (mask & (1 << i)) ? prev[i] : (C[ci++] ?? null);
    }
    prev = full;
    linhas.push(full);
  }
  return linhas;
}

// ─── Extratores de série histórica ────────────────────────────────────────────

// Extrai série histórica genérica mensalizada a partir de um resultado DSR.
// Colunas esperadas: [ANO, MES_NOME(D0), MES_ANO(D1), campoA, campoB, (campoC?)]
// Retorna Array<{ mes: 'YYYY-MM', [campoA]: number, [campoB]: number, [campoC]?: number|null }>
function extrairSerieDSR(result, campoA, campoB, campoC = null) {
  const dsr = result?.result?.data?.dsr?.DS?.[0];
  if (!dsr) return [];
  const dm    = dsr?.PH?.[0]?.DM0;
  if (!dm || !Array.isArray(dm)) return [];
  const meses = dsr?.ValueDicts?.D1 || [];
  const N     = campoC ? 6 : 5;
  const rows  = [];

  for (const full of decodificarBitmaskDSR(dm, N)) {
    const mesVal = typeof full[2] === "number" ? meses[full[2]] : full[2];
    if (!mesVal || typeof mesVal !== "string") continue;
    const mes = mesVal.replace("/", "-");
    if (!/^\d{4}-\d{2}$/.test(mes)) continue;
    const row = { mes, [campoA]: Number(full[3]) || 0, [campoB]: Number(full[4]) || 0 };
    if (campoC) row[campoC] = full[5] != null ? (Number(full[5]) || null) : null;
    rows.push(row);
  }
  return rows;
}

// Extrai série histórica de Montante Gerado (7 colunas DSR).
// Colunas: [ANO, MES_NOME, MES_ANO(D1), Montante Gerado, Compra, % compra, % geração alocada]
// Retorna Array<{ mes: 'YYYY-MM', geracao: number|null }>
function extrairSerieGeracao(result) {
  const dsr = result?.result?.data?.dsr?.DS?.[0];
  if (!dsr) return [];
  const dm    = dsr?.PH?.[0]?.DM0;
  if (!dm || !Array.isArray(dm)) return [];
  const meses = dsr?.ValueDicts?.D1 || [];
  const rows  = [];

  for (const full of decodificarBitmaskDSR(dm, 7)) {
    const mesVal = typeof full[2] === "number" ? meses[full[2]] : full[2];
    if (!mesVal || typeof mesVal !== "string") continue;
    const mes = mesVal.replace("/", "-");
    if (!/^\d{4}-\d{2}$/.test(mes)) continue;
    rows.push({ mes, geracao: full[3] != null ? (Number(full[3]) || null) : null });
  }
  return rows;
}

// ─── Merge ────────────────────────────────────────────────────────────────────

// Funde duas séries mensais por chave `mes`, combinando campos de ambas.
function mergeHistorico(serieA, serieB) {
  const map = {};
  serieA.forEach(r => { map[r.mes] = { ...r }; });
  serieB.forEach(r => { map[r.mes] ? Object.assign(map[r.mes], r) : (map[r.mes] = { ...r }); });
  return Object.values(map).sort((a, b) => a.mes.localeCompare(b.mes));
}

module.exports = { POWERBI_URL, decodificarBitmaskDSR, extrairSerieDSR, extrairSerieGeracao, mergeHistorico };
