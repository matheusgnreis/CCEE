import Link from "next/link";
import { useState, useEffect } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from "recharts";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

const SUB_CORES = { SE: "#2563eb", S: "#16a34a", NE: "#d97706", N: "#9333ea" };
const ESS_COR   = "#0891b2";
const EER_COR   = "#f59e0b";

function fmtMes(m) {
  if (!m) return "";
  const [ano, mes] = m.split("-");
  const nomes = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
  return `${nomes[Number(mes) - 1]}/${ano.slice(2)}`;
}

function fmtR(v, casa = 0) {
  if (v == null) return "—";
  return `R$ ${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: casa, maximumFractionDigits: casa })}`;
}

function fmtMM(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (Math.abs(n) >= 1e9) return `R$ ${(n / 1e9).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} bi`;
  if (Math.abs(n) >= 1e6) return `R$ ${(n / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  return fmtR(n, 0);
}

const TooltipPld = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 14px", fontSize: 13 }}>
      <div style={{ fontWeight: 700, marginBottom: 6, color: "#374151" }}>{fmtMes(label)}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: <strong>R$ {Number(p.value).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}/MWh</strong>
        </div>
      ))}
    </div>
  );
};

const TooltipEnc = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (p.value || 0), 0);
  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 14px", fontSize: 13 }}>
      <div style={{ fontWeight: 700, marginBottom: 6, color: "#374151" }}>{fmtMes(label)}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.fill, marginBottom: 2 }}>
          {p.name}: <strong>{fmtMM(p.value)}</strong>
        </div>
      ))}
      <div style={{ borderTop: "1px solid #e2e8f0", marginTop: 6, paddingTop: 6, fontWeight: 700, color: "#374151" }}>
        Total: <strong>{fmtMM(total)}</strong>
      </div>
    </div>
  );
};

export default function MercadoDashboard() {
  const [pld,     setPld]     = useState([]);
  const [enc,     setEnc]     = useState([]);
  const [loadPld, setLoadPld] = useState(true);
  const [loadEnc, setLoadEnc] = useState(true);
  const [errPld,  setErrPld]  = useState(null);
  const [errEnc,  setErrEnc]  = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/mercado/pld`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setPld(d); })
      .catch(e => setErrPld(e.message))
      .finally(() => setLoadPld(false));

    fetch(`${API_URL}/mercado/encargos`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setEnc(d); })
      .catch(e => setErrEnc(e.message))
      .finally(() => setLoadEnc(false));
  }, []);

  const pldAtual   = pld[pld.length - 1] || null;
  const encAtual   = enc[enc.length - 1] || null;
  const submercados = pld.length ? [...new Set(pld.flatMap(r => Object.keys(r).filter(k => k !== "mes")))] : [];

  const encChartData = enc.map(r => ({
    mes:    r.mes,
    ESS:    r.ess_rs,
    EER:    r.eer_rs,
    total:  (r.ess_rs || 0) + (r.eer_rs || 0),
  }));

  return (
    <div style={s.page}>
      <nav style={s.nav}>
        <div style={s.navInner}>
          <span style={s.logo}>⚡ Monitoramento Mercado Livre</span>
          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            <Link href="/"          style={s.navLink}>Início</Link>
            <Link href="/localidade" style={s.navLink}>Localidades</Link>
            <Link href="/modulacao" style={s.navLink}>Modulação</Link>
            <Link href="/mercado"   style={{ ...s.navLink, color: "#0f172a", fontWeight: 700 }}>Mercado</Link>
          </div>
        </div>
      </nav>

      <div style={s.inner}>
        <h1 style={s.titulo}>Dashboard de Mercado</h1>
        <p style={s.subtitulo}>PLD histórico e encargos CCEE (ESS e EER) — dados abertos CCEE</p>

        {/* ── Cards de resumo ─────────────────────────────────── */}
        <div style={s.cards}>
          <div style={s.card}>
            <div style={s.cardLabel}>PLD SE/CO — mês atual</div>
            <div style={s.cardValue}>
              {loadPld ? "..." : pldAtual?.SE != null ? `R$ ${Number(pldAtual.SE).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}/MWh` : "—"}
            </div>
            {pldAtual && <div style={s.cardMes}>{fmtMes(pldAtual.mes)}</div>}
          </div>
          <div style={s.card}>
            <div style={s.cardLabel}>ESS Total — mês atual</div>
            <div style={s.cardValue}>{loadEnc ? "..." : fmtMM(encAtual?.ess_rs)}</div>
            {encAtual && <div style={s.cardMes}>{fmtMes(encAtual.mes)}</div>}
          </div>
          <div style={s.card}>
            <div style={s.cardLabel}>EER Total — mês atual</div>
            <div style={s.cardValue}>{loadEnc ? "..." : fmtMM(encAtual?.eer_rs)}</div>
            {encAtual && <div style={s.cardMes}>{fmtMes(encAtual.mes)}</div>}
          </div>
          <div style={s.card}>
            <div style={s.cardLabel}>Encargos (ESS+EER) — mês atual</div>
            <div style={s.cardValue}>{loadEnc ? "..." : fmtMM((encAtual?.ess_rs || 0) + (encAtual?.eer_rs || 0))}</div>
            {encAtual && <div style={s.cardMes}>{fmtMes(encAtual.mes)}</div>}
          </div>
        </div>

        {/* ── PLD histórico ───────────────────────────────────── */}
        <div style={s.box}>
          <h2 style={s.boxTitle}>PLD Médio Mensal por Submercado (R$/MWh)</h2>
          <p style={s.boxDesc}>Média das horas de cada mês por submercado — Fonte: CCEE Dados Abertos</p>

          {errPld && <div style={s.err}>{errPld}</div>}

          {loadPld ? (
            <div style={s.loading}>Carregando dados de PLD...</div>
          ) : pld.length === 0 ? (
            <div style={s.vazio}>Dados de PLD ainda não disponíveis para este período.</div>
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={pld} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="mes" tickFormatter={fmtMes} tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `R$${v}`} width={64} />
                <Tooltip content={<TooltipPld />} />
                <Legend formatter={v => <span style={{ fontSize: 12 }}>{v}</span>} />
                {submercados.map(sub => (
                  <Line
                    key={sub}
                    type="monotone"
                    dataKey={sub}
                    name={`Sub ${sub}`}
                    stroke={SUB_CORES[sub] || "#94a3b8"}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}

          {/* Tabela resumo do último mês */}
          {!loadPld && pld.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#64748b", marginBottom: 8 }}>
                Comparativo do último mês disponível ({fmtMes(pldAtual?.mes)})
              </div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {submercados.map(sub => pldAtual?.[sub] != null && (
                  <div key={sub} style={{ ...s.subCard, borderColor: SUB_CORES[sub] || "#e2e8f0" }}>
                    <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>Sub {sub}</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: SUB_CORES[sub] || "#374151" }}>
                      R$ {Number(pldAtual[sub]).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                    </div>
                    <div style={{ fontSize: 10, color: "#94a3b8" }}>por MWh</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── ESS / EER histórico ─────────────────────────────── */}
        <div style={s.box}>
          <h2 style={s.boxTitle}>Encargos CCEE — ESS e EER Mensais (R$)</h2>
          <p style={s.boxDesc}>
            ESS = Encargo de Serviços do Sistema (constrangimentos, segurança energética).<br />
            EER = Encargo de Energia de Reserva (contratação de reserva de potência).<br />
            Fonte: CCEE Dados Abertos — <em>encargo_pgto_mensal</em> e <em>energia_reserva_liquidacao</em>
          </p>

          {errEnc && <div style={s.err}>{errEnc}</div>}

          {loadEnc ? (
            <div style={s.loading}>Carregando dados de encargos...</div>
          ) : enc.length === 0 ? (
            <div style={s.vazio}>Dados de encargos ainda não disponíveis.</div>
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={encChartData} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="mes" tickFormatter={fmtMes} tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `R$${(v / 1e6).toFixed(0)}M`} width={72} />
                <Tooltip content={<TooltipEnc />} />
                <Legend formatter={v => <span style={{ fontSize: 12 }}>{v}</span>} />
                <Bar dataKey="ESS" name="ESS" stackId="a" fill={ESS_COR} radius={[0, 0, 0, 0]} />
                <Bar dataKey="EER" name="EER" stackId="a" fill={EER_COR} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}

          {/* Tabela numérica */}
          {!loadEnc && enc.length > 0 && (
            <div style={{ marginTop: 20, overflowX: "auto" }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {["Mês", "ESS (R$)", "EER (R$)", "Total (R$)", "% ESS"].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...enc].reverse().slice(0, 18).map((r, i) => {
                    const total = (r.ess_rs || 0) + (r.eer_rs || 0);
                    const essPct = total > 0 ? (r.ess_rs / total * 100).toFixed(1) : "—";
                    return (
                      <tr key={r.mes} style={i % 2 === 0 ? { background: "#fafbfc" } : {}}>
                        <td style={{ ...s.td, fontWeight: 600 }}>{fmtMes(r.mes)}</td>
                        <td style={{ ...s.td, textAlign: "right", color: ESS_COR }}>{fmtMM(r.ess_rs)}</td>
                        <td style={{ ...s.td, textAlign: "right", color: EER_COR }}>{fmtMM(r.eer_rs)}</td>
                        <td style={{ ...s.td, textAlign: "right", fontWeight: 700 }}>{fmtMM(total)}</td>
                        <td style={{ ...s.td, textAlign: "right" }}>{typeof essPct === "string" ? essPct : `${essPct}%`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Nota metodológica ───────────────────────────────── */}
        <div style={s.nota}>
          <strong>Metodologia:</strong> O ESS cobre os custos de constrangimentos elétricos, serviços ancilares e segurança energética.
          O EER cobre a contratação de reserva de potência. Ambos são alocados mensalmente pela CCEE a todos os agentes
          do Ambiente de Contratação Livre (ACL) proporcionalmente ao consumo. Para estimar o valor por agente,
          acesse a página de inteligência de cada agente.
        </div>
      </div>
    </div>
  );
}

const s = {
  page:    { background: "#f8fafc", minHeight: "100vh", fontFamily: "system-ui, -apple-system, sans-serif" },
  nav:     { background: "#fff", borderBottom: "1px solid #e2e8f0" },
  navInner:{ maxWidth: 1100, margin: "0 auto", padding: "0 32px", height: 60, display: "flex", alignItems: "center", justifyContent: "space-between" },
  logo:    { fontSize: 15, fontWeight: 700, color: "#0f172a" },
  navLink: { fontSize: 13, color: "#2563eb", textDecoration: "none", fontWeight: 600 },
  inner:   { maxWidth: 1100, margin: "0 auto", padding: "40px 32px" },
  titulo:  { fontSize: 26, fontWeight: 800, color: "#0f172a", margin: "0 0 8px", letterSpacing: -0.5 },
  subtitulo:{ fontSize: 14, color: "#64748b", margin: "0 0 32px" },
  cards:   { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16, marginBottom: 32 },
  card:    { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "18px 20px" },
  cardLabel:{ fontSize: 11, color: "#64748b", fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 },
  cardValue:{ fontSize: 20, fontWeight: 800, color: "#0f172a", margin: "0 0 4px" },
  cardMes: { fontSize: 11, color: "#94a3b8" },
  box:     { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "24px", marginBottom: 24 },
  boxTitle:{ fontSize: 16, fontWeight: 700, color: "#0f172a", margin: "0 0 6px" },
  boxDesc: { fontSize: 12, color: "#64748b", margin: "0 0 20px", lineHeight: 1.6 },
  loading: { padding: "40px 0", textAlign: "center", color: "#64748b", fontSize: 14 },
  vazio:   { padding: "40px 0", textAlign: "center", color: "#94a3b8", fontSize: 14 },
  err:     { background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 16 },
  subCard: { background: "#f8fafc", border: "2px solid", borderRadius: 8, padding: "10px 14px", minWidth: 90, textAlign: "center" },
  table:   { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th:      { padding: "9px 12px", textAlign: "left", background: "#f8fafc", color: "#64748b", fontWeight: 600, borderBottom: "2px solid #e2e8f0", whiteSpace: "nowrap" },
  td:      { padding: "8px 12px", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  nota:    { background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10, padding: "16px 20px", fontSize: 13, color: "#0369a1", lineHeight: 1.6, marginTop: 8 },
};
