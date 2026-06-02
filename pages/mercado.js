import Link from "next/link";
import { useState, useEffect } from "react";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

const SUB_CORES = { SE: "#2563eb", S: "#16a34a", NE: "#d97706", N: "#9333ea" };
const ESS_COR   = "#0891b2";
const EER_COR   = "#f59e0b";

function fmtMes(m) {
  if (!m) return "";
  const [ano, mes] = m.split("-");
  const n = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
  return `${n[Number(mes) - 1]}/${ano.slice(2)}`;
}

function fmtMM(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (Math.abs(n) >= 1e9) return `R$ ${(n/1e9).toLocaleString("pt-BR",{maximumFractionDigits:1})} bi`;
  if (Math.abs(n) >= 1e6) return `R$ ${(n/1e6).toLocaleString("pt-BR",{maximumFractionDigits:1})} mi`;
  return `R$ ${n.toLocaleString("pt-BR",{maximumFractionDigits:0})}`;
}

const TipPld = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:8, padding:"10px 14px", fontSize:13 }}>
      <div style={{ fontWeight:700, marginBottom:6, color:"#374151" }}>{fmtMes(label)}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color:p.color, marginBottom:2 }}>
          {p.name}: <strong>R$ {Number(p.value).toLocaleString("pt-BR",{minimumFractionDigits:2})}/MWh</strong>
        </div>
      ))}
    </div>
  );
};

const TipEnc = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s,p) => s + (p.value||0), 0);
  return (
    <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:8, padding:"10px 14px", fontSize:13 }}>
      <div style={{ fontWeight:700, marginBottom:6, color:"#374151" }}>{fmtMes(label)}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color:p.fill, marginBottom:2 }}>
          {p.name}: <strong>{fmtMM(p.value)}</strong>
        </div>
      ))}
      <div style={{ borderTop:"1px solid #e2e8f0", marginTop:6, paddingTop:6, fontWeight:700, color:"#374151" }}>
        Total: {fmtMM(total)}
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

  const pldAtual    = pld.at(-1) || null;
  const encAtual    = enc.at(-1) || null;
  const submercados = pld.length
    ? [...new Set(pld.flatMap(r => Object.keys(r).filter(k => k !== "mes")))]
    : [];
  const encChart = enc.map(r => ({ mes: r.mes, ESS: r.ess_rs, EER: r.eer_rs }));

  return (
    <div style={s.page}>
      <nav style={s.nav}>
        <div style={s.navInner}>
          <span style={s.logo}>⚡ Monitoramento Mercado Livre</span>
          <div style={{ display:"flex", gap:20, alignItems:"center" }}>
            <Link href="/"           style={s.navLink}>Início</Link>
            <Link href="/localidade" style={s.navLink}>Localidades</Link>
            <Link href="/modulacao"  style={s.navLink}>Modulação</Link>
            <Link href="/mercado"    style={{ ...s.navLink, color:"#0f172a", fontWeight:700 }}>Mercado</Link>
          </div>
        </div>
      </nav>

      <div style={s.inner}>
        <h1 style={s.titulo}>Dashboard de Mercado</h1>
        <p style={s.sub}>PLD histórico por submercado e encargos CCEE — dados abertos CCEE</p>

        {/* ── Cards resumo ──────────────────────────────────────── */}
        <div style={s.cards}>
          {submercados.map(sub => pldAtual?.[sub] != null && (
            <div key={sub} style={{ ...s.card, borderTop:`3px solid ${SUB_CORES[sub]||"#94a3b8"}` }}>
              <div style={s.cLabel}>PLD {sub} — {fmtMes(pldAtual.mes)}</div>
              <div style={{ ...s.cVal, color: SUB_CORES[sub]||"#0f172a" }}>
                {loadPld ? "…" : `R$ ${Number(pldAtual[sub]).toLocaleString("pt-BR",{minimumFractionDigits:2})}/MWh`}
              </div>
            </div>
          ))}
          {encAtual && (
            <>
              <div style={{ ...s.card, borderTop:`3px solid ${ESS_COR}` }}>
                <div style={s.cLabel}>ESS sistema — {fmtMes(encAtual.mes)}</div>
                <div style={{ ...s.cVal, color:ESS_COR }}>{loadEnc ? "…" : fmtMM(encAtual.ess_rs)}</div>
              </div>
              <div style={{ ...s.card, borderTop:`3px solid ${EER_COR}` }}>
                <div style={s.cLabel}>EER sistema — {fmtMes(encAtual.mes)}</div>
                <div style={{ ...s.cVal, color:EER_COR }}>{loadEnc ? "…" : fmtMM(encAtual.eer_rs)}</div>
              </div>
            </>
          )}
        </div>

        {/* ── PLD histórico ───────────────────────────────────── */}
        <div style={s.box}>
          <h2 style={s.boxTitle}>PLD Médio Mensal por Submercado (R$/MWh)</h2>
          <p style={s.boxDesc}>Média das horas de cada mês — Fonte: CCEE Dados Abertos · pld_horario</p>

          {errPld && <div style={s.err}>{errPld}</div>}

          {loadPld ? (
            <div style={s.loading}>Carregando PLD… (primeira carga pode levar ~10s)</div>
          ) : pld.length === 0 ? (
            <div style={s.vazio}>Dados de PLD ainda não disponíveis.</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={pld} margin={{ top:8, right:20, left:0, bottom:0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="mes" tickFormatter={fmtMes} tick={{ fontSize:11 }} />
                  <YAxis tick={{ fontSize:11 }} tickFormatter={v=>`R$${v}`} width={64} />
                  <Tooltip content={<TipPld />} />
                  <Legend formatter={v=><span style={{ fontSize:12 }}>{v}</span>} />
                  {submercados.map(sub => (
                    <Line key={sub} type="monotone" dataKey={sub} name={`Sub ${sub}`}
                      stroke={SUB_CORES[sub]||"#94a3b8"} strokeWidth={2} dot={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>

              <div style={{ marginTop:20, overflowX:"auto" }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Mês</th>
                      {submercados.map(sub => (
                        <th key={sub} style={{ ...s.th, color:SUB_CORES[sub]||"#64748b" }}>Sub {sub} (R$/MWh)</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...pld].reverse().map((r,i) => (
                      <tr key={r.mes} style={i%2===0 ? { background:"#fafbfc" } : {}}>
                        <td style={{ ...s.td, fontWeight:600 }}>{fmtMes(r.mes)}</td>
                        {submercados.map(sub => (
                          <td key={sub} style={{ ...s.td, textAlign:"right", color:SUB_CORES[sub]||"#374151" }}>
                            {r[sub] != null ? Number(r[sub]).toLocaleString("pt-BR",{minimumFractionDigits:2}) : "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* ── Encargos ESS + EER ──────────────────────────────── */}
        <div style={s.box}>
          <h2 style={s.boxTitle}>Encargos CCEE — ESS e EER Mensais (R$)</h2>
          <p style={s.boxDesc}>
            ESS = Encargo de Serviços do Sistema &nbsp;|&nbsp; EER = Encargo de Energia de Reserva<br />
            Fonte: CCEE Dados Abertos · encargo_pgto_mensal e energia_reserva_liquidacao
          </p>

          {errEnc && <div style={s.err}>{errEnc}</div>}

          {loadEnc ? (
            <div style={s.loading}>Carregando encargos…</div>
          ) : enc.length === 0 ? (
            <div style={s.vazio}>Dados de encargos não disponíveis.</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={encChart} margin={{ top:8, right:20, left:0, bottom:0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="mes" tickFormatter={fmtMes} tick={{ fontSize:11 }} />
                  <YAxis tick={{ fontSize:11 }} tickFormatter={v=>`R$${(v/1e6).toFixed(0)}M`} width={72} />
                  <Tooltip content={<TipEnc />} />
                  <Legend formatter={v=><span style={{ fontSize:12 }}>{v}</span>} />
                  <Bar dataKey="ESS" name="ESS" stackId="a" fill={ESS_COR} />
                  <Bar dataKey="EER" name="EER" stackId="a" fill={EER_COR} radius={[3,3,0,0]} />
                </BarChart>
              </ResponsiveContainer>

              <div style={{ marginTop:20, overflowX:"auto" }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      {["Mês","ESS (R$)","EER (R$)","Total (R$)","% ESS"].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...enc].reverse().slice(0,24).map((r,i) => {
                      const total  = (r.ess_rs||0) + (r.eer_rs||0);
                      const essPct = total > 0 ? `${(r.ess_rs/total*100).toFixed(1)}%` : "—";
                      return (
                        <tr key={r.mes} style={i%2===0 ? { background:"#fafbfc" } : {}}>
                          <td style={{ ...s.td, fontWeight:600 }}>{fmtMes(r.mes)}</td>
                          <td style={{ ...s.td, textAlign:"right", color:ESS_COR }}>{fmtMM(r.ess_rs)}</td>
                          <td style={{ ...s.td, textAlign:"right", color:EER_COR }}>{fmtMM(r.eer_rs)}</td>
                          <td style={{ ...s.td, textAlign:"right", fontWeight:700 }}>{fmtMM(total)}</td>
                          <td style={{ ...s.td, textAlign:"right" }}>{essPct}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const s = {
  page:    { background:"#f8fafc", minHeight:"100vh", fontFamily:"system-ui,-apple-system,sans-serif" },
  nav:     { background:"#fff", borderBottom:"1px solid #e2e8f0" },
  navInner:{ maxWidth:1100, margin:"0 auto", padding:"0 32px", height:60, display:"flex", alignItems:"center", justifyContent:"space-between" },
  logo:    { fontSize:15, fontWeight:700, color:"#0f172a" },
  navLink: { fontSize:13, color:"#2563eb", textDecoration:"none", fontWeight:600 },
  inner:   { maxWidth:1100, margin:"0 auto", padding:"40px 32px" },
  titulo:  { fontSize:26, fontWeight:800, color:"#0f172a", margin:"0 0 8px", letterSpacing:-0.5 },
  sub:     { fontSize:14, color:"#64748b", margin:"0 0 32px" },
  cards:   { display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:16, marginBottom:32 },
  card:    { background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"18px 20px" },
  cLabel:  { fontSize:11, color:"#64748b", fontWeight:600, marginBottom:6, textTransform:"uppercase", letterSpacing:0.5 },
  cVal:    { fontSize:18, fontWeight:800, color:"#0f172a" },
  box:     { background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"24px", marginBottom:24 },
  boxTitle:{ fontSize:16, fontWeight:700, color:"#0f172a", margin:"0 0 6px" },
  boxDesc: { fontSize:12, color:"#64748b", margin:"0 0 20px", lineHeight:1.6 },
  loading: { padding:"40px 0", textAlign:"center", color:"#64748b", fontSize:14 },
  vazio:   { padding:"40px 0", textAlign:"center", color:"#94a3b8", fontSize:14 },
  err:     { background:"#fef2f2", border:"1px solid #fecaca", color:"#dc2626", borderRadius:8, padding:"10px 14px", fontSize:13, marginBottom:16 },
  table:   { width:"100%", borderCollapse:"collapse", fontSize:13 },
  th:      { padding:"9px 12px", textAlign:"left", background:"#f8fafc", color:"#64748b", fontWeight:600, borderBottom:"2px solid #e2e8f0", whiteSpace:"nowrap" },
  td:      { padding:"8px 12px", borderBottom:"1px solid #f1f5f9", whiteSpace:"nowrap" },
};
