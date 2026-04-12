import { useRouter } from "next/router";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer
} from "recharts";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

const METRICAS = [
  { key: "consumo",            label: "Consumo",            color: "#2563eb" },
  { key: "compra",             label: "Compra",             color: "#16a34a" },
  { key: "resultado",          label: "Resultado",          color: "#dc2626" },
  { key: "mcp",                label: "MCP",                color: "#d97706" },
  { key: "resultado_mcp",      label: "Resultado MCP",      color: "#7c3aed" },
  { key: "balanco_energetico", label: "Balanço Energético", color: "#0891b2" },
];

const GRAFICOS = [
  {
    titulo: "Consumo e Compra",
    unidade: "MWm",
    linhas: [
      { key: "consumo", label: "Consumo", color: "#2563eb" },
      { key: "compra",  label: "Compra",  color: "#16a34a" },
    ],
  },
  {
    titulo: "Balanço Energético",
    unidade: "MWm",
    linhas: [
      { key: "balanco_energetico", label: "Balanço Energético", color: "#0891b2" },
    ],
  },
  {
    titulo: "MCP · Resultado · Resultado MCP",
    unidade: "R$",
    linhas: [
      { key: "mcp",           label: "MCP",           color: "#d97706" },
      { key: "resultado",     label: "Resultado",     color: "#dc2626" },
      { key: "resultado_mcp", label: "Resultado MCP", color: "#7c3aed" },
    ],
  },
];

function fmt(v) {
  if (v === null || v === undefined) return "—";
  return Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}

export default function AgenteDashboard() {
  const router   = useRouter();
  const agente   = router.query.agente
    ? decodeURIComponent(router.query.agente)
    : null;

  const [historico,      setHistorico]      = useState([]);
  const [dadosMes,       setDadosMes]       = useState(null);
  const [mesSelecionado, setMesSelecionado] = useState(null);
  const [loadingHist,    setLoadingHist]    = useState(true);
  const [loadingMes,     setLoadingMes]     = useState(false);
  const [error,          setError]          = useState(null);

  // Evita buscar o mesmo mês duas vezes (ex: quando dadosMes já foi setado
  // pelo primeiro acesso ao Power BI dentro do efeito do histórico)
  const fetchedMesRef = useRef(null);

  // ── 1. Busca histórico; se vazio, dispara Power BI (primeiro acesso) ──
  useEffect(() => {
    if (!agente) return;

    setLoadingHist(true);
    setError(null);
    setHistorico([]);
    setDadosMes(null);
    setMesSelecionado(null);
    fetchedMesRef.current = null;

    const encoded = encodeURIComponent(agente);

    fetch(`${API_URL}/inteligencia/${encoded}/historico`)
      .then(r => r.json())
      .then(async json => {
        if (json.error) throw new Error(json.error);

        if (json.length > 0) {
          // Agente já existe no banco — fluxo normal
          setHistorico(json);
          setMesSelecionado(json[json.length - 1].mes);
        } else {
          // Primeiro acesso — busca no Power BI (sem filtro de mês = mais recente)
          const r2    = await fetch(`${API_URL}/inteligencia/${encoded}`);
          const dados = await r2.json();
          if (dados.error) throw new Error(dados.error);

          fetchedMesRef.current = dados.mes; // marca para não re-buscar
          setDadosMes(dados);
          setMesSelecionado(dados.mes);

          // Re-busca histórico (agora já salvo no banco)
          const r3   = await fetch(`${API_URL}/inteligencia/${encoded}/historico`);
          const hist = await r3.json();
          if (Array.isArray(hist)) setHistorico(hist);
        }
      })
      .catch(err => setError(err.message))
      .finally(() => setLoadingHist(false));
  }, [agente]);

  // ── 2. Busca dados do mês quando o usuário troca o seletor ───────────
  useEffect(() => {
    if (!agente || !mesSelecionado || loadingHist) return;
    // Pula se os dados desse mês já foram carregados pelo efeito anterior
    if (fetchedMesRef.current === mesSelecionado) return;

    fetchedMesRef.current = mesSelecionado;
    setLoadingMes(true);
    setDadosMes(null);

    fetch(`${API_URL}/inteligencia/${encodeURIComponent(agente)}?mes=${mesSelecionado}`)
      .then(r => r.json())
      .then(json => {
        if (json.error) throw new Error(json.error);
        setDadosMes(json);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoadingMes(false));
  }, [agente, mesSelecionado, loadingHist]);

  // Metadados vêm do mês atual ou do primeiro registro do histórico
  const meta = dadosMes ?? (historico.length > 0 ? historico[0] : null);

  if (!agente) return <div style={s.center}>Carregando...</div>;

  return (
    <div style={s.page}>

      {/* ── Navbar ──────────────────────────────────────────────── */}
      <nav style={s.nav}>
        <div style={s.navInner}>
          <Link href="/" style={s.navBack}>← Início</Link>
          <span style={s.logo}>⚡ CCEE Monitor</span>
          <div style={{ width: 80 }} /> {/* spacer */}
        </div>
      </nav>

      <div style={s.inner}>

        {/* ── Header do agente ────────────────────────────────── */}
        <div style={s.header}>
          <div style={{ flex: 1 }}>
            <h1 style={s.agenteName}>{agente}</h1>
            {meta && (
              <div style={s.metaBadges}>
                {meta.razao_social && <span style={s.tag}>{meta.razao_social}</span>}
                {meta.cnpj         && <span style={s.tag}>CNPJ {meta.cnpj}</span>}
                {meta.classe       && <span style={s.tag}>{meta.classe}</span>}
                {meta.situacao     && (
                  <span style={{ ...s.tag, color: meta.situacao === "Ativo" ? "#16a34a" : "#dc2626" }}>
                    {meta.situacao}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Seletor de mês */}
          {historico.length > 0 && (
            <div style={s.selectorWrap}>
              <label style={s.selectorLabel}>Mês de referência</label>
              <select
                value={mesSelecionado || ""}
                onChange={e => setMesSelecionado(e.target.value)}
                style={s.selector}
              >
                {[...historico].reverse().map(h => (
                  <option key={h.mes} value={h.mes}>{h.mes}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* ── Erro ────────────────────────────────────────────── */}
        {error && <div style={s.errorBox}>⚠ {error}</div>}

        {/* ── Loading inicial ──────────────────────────────────── */}
        {loadingHist ? (
          <div style={s.loadingBox}>
            <p style={s.loadingText}>Buscando dados de <strong>{agente}</strong>...</p>
            <p style={s.loadingHint}>
              Se for a primeira consulta, pode levar alguns segundos — estamos buscando no Power BI da CCEE.
            </p>
          </div>
        ) : (
          <>
            {/* ── Cards do mês ──────────────────────────────────── */}
            <div style={s.mesHeader}>
              <h2 style={s.mesTitle}>
                {mesSelecionado
                  ? `Dados de ${mesSelecionado}`
                  : "Selecione um mês"}
              </h2>
              {loadingMes && <span style={s.mesLoading}>carregando...</span>}
            </div>

            <div style={s.grid}>
              {METRICAS.map(m => {
                const val      = dadosMes?.[m.key];
                const negativo = !loadingMes
                  && ["mcp", "resultado", "resultado_mcp"].includes(m.key)
                  && Number(val) < 0;
                const cor = loadingMes ? "#d1d5db" : negativo ? "#dc2626" : m.color;

                return (
                  <div key={m.key} style={{ ...s.card, ...(negativo ? s.cardAlerta : {}) }}>
                    <p style={s.cardLabel}>{m.label}</p>
                    <p style={{ ...s.cardValue, color: cor }}>
                      {loadingMes ? "—" : fmt(val)}
                      {negativo && <span style={s.alertaIcon} title="Aporte necessário na CCEE">⚠</span>}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* ── Gráficos históricos ───────────────────────────── */}
            {historico.length > 0 && GRAFICOS.map(g => (
              <div key={g.titulo} style={s.chartBox}>
                <h2 style={s.chartTitle}>{g.titulo}</h2>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={historico} margin={{ top: 10, right: 24, left: 16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="mes" tick={{ fontSize: 11, fill: "#9ca3af" }} />
                    <YAxis
                      tick={{ fontSize: 11, fill: "#9ca3af" }}
                      label={{
                        value: g.unidade,
                        angle: -90,
                        position: "insideLeft",
                        offset: 10,
                        style: { fontSize: 11, fill: "#9ca3af" }
                      }}
                      width={60}
                    />
                    <Tooltip
                      contentStyle={{ borderRadius: 8, fontSize: 13, border: "1px solid #e2e8f0" }}
                      formatter={(v, name) => [`${fmt(v)} ${g.unidade}`, name]}
                    />
                    <Legend wrapperStyle={{ fontSize: 13, paddingTop: 12 }} />
                    {g.linhas.map(l => (
                      <Line
                        key={l.key}
                        type="monotone"
                        dataKey={l.key}
                        name={l.label}
                        stroke={l.color}
                        strokeWidth={2}
                        dot={{ r: 3 }}
                        activeDot={{ r: 5 }}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ))}
          </>
        )}

      </div>
    </div>
  );
}

/* ── Estilos ─────────────────────────────────────────────────────── */
const s = {
  page:    { background: "#f8fafc", minHeight: "100vh", fontFamily: "system-ui, -apple-system, sans-serif" },

  nav:     { background: "#fff", borderBottom: "1px solid #e2e8f0" },
  navInner: { maxWidth: 1100, margin: "0 auto", padding: "0 32px", height: 60, display: "flex", alignItems: "center", justifyContent: "space-between" },
  navBack: { fontSize: 14, color: "#6b7280", textDecoration: "none", width: 80 },
  logo:    { fontSize: 15, fontWeight: 700, color: "#0f172a" },

  inner:   { maxWidth: 1100, margin: "0 auto", padding: "40px 32px" },
  center:  { padding: 60, textAlign: "center", fontFamily: "system-ui, sans-serif" },

  header:     { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 32, flexWrap: "wrap", gap: 20 },
  agenteName: { fontSize: 26, fontWeight: 800, color: "#0f172a", margin: "0 0 10px", letterSpacing: -0.5 },
  metaBadges: { display: "flex", gap: 8, flexWrap: "wrap" },
  tag: { fontSize: 12, color: "#64748b", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 20, padding: "3px 10px" },

  selectorWrap:  { display: "flex", flexDirection: "column", gap: 6 },
  selectorLabel: { fontSize: 12, color: "#6b7280", fontWeight: 600 },
  selector:      { fontSize: 14, padding: "9px 14px", border: "1.5px solid #e2e8f0", borderRadius: 8, background: "#fff", color: "#0f172a", cursor: "pointer", minWidth: 140 },

  errorBox: { color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "12px 16px", marginBottom: 24, fontSize: 14 },

  loadingBox:  { textAlign: "center", padding: "80px 32px" },
  loadingText: { fontSize: 18, color: "#374151", fontWeight: 600, margin: "0 0 12px" },
  loadingHint: { fontSize: 14, color: "#94a3b8", margin: 0 },

  mesHeader:  { display: "flex", alignItems: "center", gap: 12, marginBottom: 16 },
  mesTitle:   { fontSize: 16, fontWeight: 700, color: "#374151", margin: 0 },
  mesLoading: { fontSize: 12, color: "#94a3b8" },

  grid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 32 },
  card:       { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "18px 20px" },
  cardAlerta: { border: "1px solid #fecaca", background: "#fff7f7" },
  cardLabel:  { fontSize: 12, color: "#6b7280", margin: "0 0 6px", fontWeight: 600 },
  cardValue:  { fontSize: 24, fontWeight: 800, margin: 0, letterSpacing: -0.5, transition: "color 0.2s", display: "flex", alignItems: "center", gap: 8 },
  alertaIcon: { fontSize: 18, lineHeight: 1 },

  chartBox:   { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "24px 24px 12px", marginBottom: 20 },
  chartTitle: { fontSize: 15, fontWeight: 700, color: "#374151", margin: "0 0 16px" },
};
