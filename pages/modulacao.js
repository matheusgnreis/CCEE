import { useEffect, useRef, useState } from "react";
import Link from "next/link";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

function fmt(v, dec = 2) {
  if (v == null) return "—";
  return Number(v).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function ProgressBar({ calculados, total }) {
  const pct = total > 0 ? Math.round((calculados / total) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: "#e2e8f0", borderRadius: 99, overflow: "hidden", minWidth: 80 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: pct === 100 ? "#16a34a" : "#2563eb", borderRadius: 99, transition: "width 0.4s" }} />
      </div>
      <span style={{ fontSize: 12, color: "#64748b", whiteSpace: "nowrap" }}>{calculados}/{total}</span>
    </div>
  );
}

export default function MonitorModulacao() {
  const [dados,    setDados]    = useState(null);
  const [erro,     setErro]     = useState(null);
  const [lastUpd,  setLastUpd]  = useState(null);
  const intervalRef = useRef(null);

  const fetchStatus = () => {
    fetch(`${API_URL}/modulacao/status`)
      .then(r => r.json())
      .then(json => {
        if (json.error) throw new Error(json.error);
        setDados(json);
        setLastUpd(new Date());
        setErro(null);
      })
      .catch(e => setErro(e.message));
  };

  useEffect(() => {
    fetchStatus();
    intervalRef.current = setInterval(fetchStatus, 5000);
    return () => clearInterval(intervalRef.current);
  }, []);

  const algumCalculando = dados?.em_andamento?.length > 0;

  return (
    <div style={s.page}>
      <style jsx>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (max-width: 768px) {
          .nav-inner { padding: 0 16px !important; }
          .inner     { padding: 24px 16px !important; }
        }
      `}</style>

      {/* Navbar */}
      <nav style={s.nav}>
        <div className="nav-inner" style={s.navInner}>
          <Link href="/" style={s.navBack}>← Início</Link>
          <span style={s.logo}>⚡ CCEE Monitor</span>
          <div style={{ width: 80 }} />
        </div>
      </nav>

      <div className="inner" style={s.inner}>
        <div style={s.header}>
          <div>
            <h1 style={s.titulo}>Modulação Horária</h1>
            <p style={s.subtitulo}>Progresso de cálculo por agente</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {algumCalculando && (
              <span style={s.badge}>
                <span style={s.spinner} />
                {dados.em_andamento.length} calculando
              </span>
            )}
            {lastUpd && (
              <span style={s.lastUpd}>
                Atualizado às {lastUpd.toLocaleTimeString("pt-BR")}
              </span>
            )}
          </div>
        </div>

        {erro && <div style={s.erroBox}>⚠ {erro}</div>}

        {!dados && !erro && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "60px 0" }}>
            <span style={s.spinner} />
            <span style={{ color: "#64748b" }}>Carregando...</span>
          </div>
        )}

        {dados && (
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>
                  {["Agente", "Razão Social", "Progresso", "Último mês", "Custo Mod. médio", "Status"].map(h => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dados.agentes.map((a, i) => {
                  const completo  = a.calculados === a.total_meses && a.total_meses > 0;
                  const corCusto  = a.custo_medio == null ? "#374151"
                    : a.custo_medio > 0 ? "#dc2626" : "#16a34a";
                  return (
                    <tr key={a.agente} style={i % 2 === 0 ? s.trEven : {}}>
                      <td style={s.td}>
                        <Link href={`/inteligencia/${encodeURIComponent(a.agente)}`} style={s.link}>
                          {a.agente}
                        </Link>
                      </td>
                      <td style={{ ...s.td, color: "#64748b", fontSize: 12 }}>{a.razao_social || "—"}</td>
                      <td style={{ ...s.td, minWidth: 160 }}>
                        <ProgressBar calculados={a.calculados} total={a.total_meses} />
                      </td>
                      <td style={s.td}>{a.ultimo_mes || "—"}</td>
                      <td style={{ ...s.td, textAlign: "right", fontWeight: 700, color: corCusto }}>
                        {a.custo_medio != null
                          ? `${a.custo_medio > 0 ? "+" : ""}${fmt(a.custo_medio)} R$/MWh`
                          : "—"}
                      </td>
                      <td style={{ ...s.td, textAlign: "center" }}>
                        {a.calculando ? (
                          <span style={s.statusCalc}><span style={s.spinnerSm} /> Calculando</span>
                        ) : completo ? (
                          <span style={s.statusOk}>✓ Completo</span>
                        ) : a.calculados === 0 ? (
                          <span style={s.statusPend}>Pendente</span>
                        ) : (
                          <span style={s.statusParcial}>Parcial</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {dados.agentes.length === 0 && (
              <p style={{ textAlign: "center", color: "#94a3b8", padding: "40px 0" }}>
                Nenhum agente com histórico encontrado.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const s = {
  page:    { background: "#f8fafc", minHeight: "100vh", fontFamily: "system-ui, -apple-system, sans-serif" },
  nav:     { background: "#fff", borderBottom: "1px solid #e2e8f0" },
  navInner:{ maxWidth: 1100, margin: "0 auto", padding: "0 32px", height: 60, display: "flex", alignItems: "center", justifyContent: "space-between" },
  navBack: { fontSize: 14, color: "#6b7280", textDecoration: "none", width: 80 },
  logo:    { fontSize: 15, fontWeight: 700, color: "#0f172a" },
  inner:   { maxWidth: 1100, margin: "0 auto", padding: "40px 32px" },
  header:  { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28, flexWrap: "wrap", gap: 16 },
  titulo:  { fontSize: 24, fontWeight: 800, color: "#0f172a", margin: "0 0 4px", letterSpacing: -0.5 },
  subtitulo: { fontSize: 14, color: "#64748b", margin: 0 },
  badge:   { display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "#2563eb", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 20, padding: "6px 14px" },
  lastUpd: { fontSize: 12, color: "#94a3b8" },
  erroBox: { color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontSize: 14 },
  tableWrap: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden" },
  table:   { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th:      { padding: "12px 16px", textAlign: "left", background: "#f8fafc", color: "#64748b", fontWeight: 600, borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap" },
  td:      { padding: "12px 16px", color: "#374151", borderBottom: "1px solid #f1f5f9" },
  trEven:  { background: "#fafbfc" },
  link:    { color: "#2563eb", textDecoration: "none", fontWeight: 600, fontSize: 13 },
  statusCalc:   { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#2563eb" },
  statusOk:     { fontSize: 12, fontWeight: 600, color: "#16a34a" },
  statusPend:   { fontSize: 12, color: "#94a3b8" },
  statusParcial:{ fontSize: 12, fontWeight: 600, color: "#d97706" },
  spinner:   { display: "inline-block", width: 16, height: 16, borderRadius: "50%", border: "2px solid #bfdbfe", borderTopColor: "#2563eb", animation: "spin 0.8s linear infinite", flexShrink: 0 },
  spinnerSm: { display: "inline-block", width: 12, height: 12, borderRadius: "50%", border: "2px solid #bfdbfe", borderTopColor: "#2563eb", animation: "spin 0.8s linear infinite", flexShrink: 0 },
};
