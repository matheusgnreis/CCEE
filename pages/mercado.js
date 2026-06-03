import Link from "next/link";
import { useState, useEffect } from "react";
import {
  LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from "recharts";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

const SUB_CORES  = { SE: "#2563eb", S: "#16a34a", NE: "#d97706", N: "#9333ea" };
const RAMO_CORES = ["#2563eb","#16a34a","#d97706","#9333ea","#dc2626","#0891b2","#ea580c","#65a30d","#db2777","#78716c"];

function fmtMes(m) {
  if (!m) return "";
  const [ano, mes] = m.split("-");
  const n = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
  return `${n[Number(mes) - 1]}/${ano.slice(2)}`;
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

const TipRamo = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:8, padding:"10px 14px", fontSize:13 }}>
      <div style={{ fontWeight:700, marginBottom:6, color:"#374151" }}>{fmtMes(label)}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color:p.color, marginBottom:2 }}>
          {p.name}: <strong>{Number(p.value).toLocaleString("pt-BR",{minimumFractionDigits:2})} R$/MWh</strong>
        </div>
      ))}
    </div>
  );
};

export default function MercadoDashboard() {
  const [pld,          setPld]          = useState([]);
  const [modRamo,      setModRamo]      = useState([]);
  const [loadPld,      setLoadPld]      = useState(true);
  const [loadMod,      setLoadMod]      = useState(true);
  const [errPld,       setErrPld]       = useState(null);
  const [errMod,       setErrMod]       = useState(null);
  const [selectedSub,  setSelectedSub]  = useState(null);
  const [selectedRamo, setSelectedRamo] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/mercado/pld`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setPld(d); })
      .catch(e => setErrPld(e.message))
      .finally(() => setLoadPld(false));

    fetch(`${API_URL}/mercado/modulacao-ramo`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setModRamo(d); })
      .catch(e => setErrMod(e.message))
      .finally(() => setLoadMod(false));
  }, []);

  const pldAtual    = pld.at(-1) || null;
  const submercados = pld.length
    ? [...new Set(pld.flatMap(r => Object.keys(r).filter(k => k !== "mes")))]
    : [];

  const ramos = [...new Set(modRamo.map(r => r.ramo))].sort();
  const modChart = (() => {
    const porMes = {};
    for (const r of modRamo) {
      if (!porMes[r.mes]) porMes[r.mes] = { mes: r.mes };
      porMes[r.mes][r.ramo] = Number(r.custo_medio_rs_mwh);
    }
    return Object.values(porMes).sort((a,b) => a.mes.localeCompare(b.mes));
  })();

  const modUltimoMes = modChart.at(-1)?.mes || null;
  const modUltimo    = modChart.at(-1) || null;

  function handleClickSub(data) {
    const key = data.dataKey;
    setSelectedSub(prev => prev === key ? null : key);
  }

  function handleClickRamo(data) {
    const key = data.dataKey;
    setSelectedRamo(prev => prev === key ? null : key);
  }

  function subOpacity(sub) {
    if (!selectedSub) return 1;
    return sub === selectedSub ? 1 : 0.12;
  }

  function ramoOpacity(ramo) {
    if (!selectedRamo) return 1;
    return ramo === selectedRamo ? 1 : 0.12;
  }

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
        <p style={s.sub}>PLD histórico por submercado e custo de modulação por ramo de atividade</p>

        {/* ── Cards PLD ─────────────────────────────────────────── */}
        <div style={s.cards}>
          {submercados.map(sub => pldAtual?.[sub] != null && (
            <div key={sub} style={{ ...s.card, borderTop:`3px solid ${SUB_CORES[sub]||"#94a3b8"}` }}>
              <div style={s.cLabel}>PLD {sub} — {fmtMes(pldAtual.mes)}</div>
              <div style={{ ...s.cVal, color: SUB_CORES[sub]||"#0f172a" }}>
                {loadPld ? "…" : `R$ ${Number(pldAtual[sub]).toLocaleString("pt-BR",{minimumFractionDigits:2})}/MWh`}
              </div>
            </div>
          ))}
        </div>

        {/* ── PLD histórico ───────────────────────────────────── */}
        <div style={s.box}>
          <h2 style={s.boxTitle}>PLD Médio Mensal por Submercado (R$/MWh)</h2>
          <p style={s.boxDesc}>
            Média das horas de cada mês — Fonte: CCEE Dados Abertos · pld_horario
            {selectedSub && <> · <button onClick={() => setSelectedSub(null)} style={s.btnLimpar}>Mostrar todos</button></>}
          </p>

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
                  <Legend
                    onClick={handleClickSub}
                    formatter={(v, entry) => (
                      <span style={{
                        fontSize: 12,
                        cursor: "pointer",
                        opacity: selectedSub ? (entry.dataKey === selectedSub ? 1 : 0.4) : 1,
                        fontWeight: selectedSub && entry.dataKey === selectedSub ? 700 : 400,
                      }}>{v}</span>
                    )}
                  />
                  {submercados.map(sub => (
                    <Line
                      key={sub}
                      type="monotone"
                      dataKey={sub}
                      name={`Sub ${sub}`}
                      stroke={SUB_CORES[sub]||"#94a3b8"}
                      strokeWidth={selectedSub === sub ? 3 : 2}
                      strokeOpacity={subOpacity(sub)}
                      dot={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>

              <div style={{ marginTop:20, overflowX:"auto" }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Mês</th>
                      {submercados.map(sub => (
                        <th
                          key={sub}
                          onClick={() => setSelectedSub(p => p === sub ? null : sub)}
                          style={{
                            ...s.th,
                            color: selectedSub ? (sub === selectedSub ? SUB_CORES[sub]||"#64748b" : "#cbd5e1") : SUB_CORES[sub]||"#64748b",
                            cursor: "pointer",
                            fontWeight: selectedSub === sub ? 800 : 600,
                          }}
                        >Sub {sub} (R$/MWh)</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...pld].reverse().map((r,i) => (
                      <tr key={r.mes} style={i%2===0 ? { background:"#fafbfc" } : {}}>
                        <td style={{ ...s.td, fontWeight:600 }}>{fmtMes(r.mes)}</td>
                        {submercados.map(sub => (
                          <td key={sub} style={{
                            ...s.td,
                            textAlign:"right",
                            color: selectedSub ? (sub === selectedSub ? SUB_CORES[sub]||"#374151" : "#cbd5e1") : SUB_CORES[sub]||"#374151",
                            fontWeight: selectedSub === sub ? 700 : 400,
                          }}>
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

        {/* ── Modulação por Ramo de Atividade ─────────────────── */}
        <div style={s.box}>
          <h2 style={s.boxTitle}>Custo de Modulação por Ramo de Atividade (R$/MWh)</h2>
          <p style={s.boxDesc}>
            Custo médio de modulação dos agentes agrupados por ramo — positivo indica consumo concentrado em horas de PLD alto, negativo indica perfil favorável.<br />
            Fonte: cálculo sobre PLD horário CCEE × perfil de carga dos agentes cadastrados.
            {selectedRamo && <> · <button onClick={() => setSelectedRamo(null)} style={s.btnLimpar}>Mostrar todos</button></>}
          </p>

          {errMod && <div style={s.err}>{errMod}</div>}

          {loadMod ? (
            <div style={s.loading}>Carregando modulação por ramo…</div>
          ) : modChart.length === 0 ? (
            <div style={s.vazio}>Sem dados de modulação por ramo. Acesse páginas de agentes para gerar os cálculos.</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={modChart} margin={{ top:8, right:20, left:0, bottom:0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="mes" tickFormatter={fmtMes} tick={{ fontSize:11 }} />
                  <YAxis
                    tick={{ fontSize:11 }}
                    tickFormatter={v => `${Number(v).toFixed(2)}`}
                    width={64}
                    label={{ value:"R$/MWh", angle:-90, position:"insideLeft", offset:10, style:{ fontSize:11, fill:"#9ca3af" } }}
                  />
                  <Tooltip content={<TipRamo />} />
                  <Legend
                    onClick={handleClickRamo}
                    formatter={(v, entry) => (
                      <span style={{
                        fontSize: 11,
                        cursor: "pointer",
                        opacity: selectedRamo ? (entry.dataKey === selectedRamo ? 1 : 0.35) : 1,
                        fontWeight: selectedRamo && entry.dataKey === selectedRamo ? 700 : 400,
                      }}>{v}</span>
                    )}
                  />
                  <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="4 2" strokeWidth={1} />
                  {ramos.map((ramo, i) => (
                    <Line
                      key={ramo}
                      type="monotone"
                      dataKey={ramo}
                      name={ramo}
                      stroke={RAMO_CORES[i % RAMO_CORES.length]}
                      strokeWidth={selectedRamo === ramo ? 3 : 2}
                      strokeOpacity={ramoOpacity(ramo)}
                      dot={{ r: selectedRamo === ramo ? 4 : 3, fillOpacity: ramoOpacity(ramo) }}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>

              {modUltimo && (
                <div style={{ marginTop:20, overflowX:"auto" }}>
                  <p style={{ fontSize:12, color:"#64748b", margin:"0 0 10px" }}>
                    Último mês: <strong>{fmtMes(modUltimoMes)}</strong>
                  </p>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        <th style={s.th}>Ramo de Atividade</th>
                        <th style={{ ...s.th, textAlign:"right" }}>Custo Modulação (R$/MWh)</th>
                        <th style={{ ...s.th, textAlign:"right" }}>Consumo (MWh)</th>
                        <th style={{ ...s.th, textAlign:"right" }}>Agentes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modRamo
                        .filter(r => r.mes === modUltimoMes)
                        .sort((a,b) => Number(b.custo_medio_rs_mwh) - Number(a.custo_medio_rs_mwh))
                        .map((r, i) => {
                          const custo     = Number(r.custo_medio_rs_mwh);
                          const selecionado = selectedRamo === r.ramo;
                          const desbotado   = selectedRamo && !selecionado;
                          return (
                            <tr
                              key={r.ramo}
                              onClick={() => setSelectedRamo(p => p === r.ramo ? null : r.ramo)}
                              style={{
                                ...(i%2===0 ? { background:"#fafbfc" } : {}),
                                opacity: desbotado ? 0.35 : 1,
                                cursor: "pointer",
                                ...(selecionado ? { background:"#eff6ff" } : {}),
                              }}
                            >
                              <td style={{ ...s.td, fontWeight: selecionado ? 700 : 400 }}>{r.ramo}</td>
                              <td style={{ ...s.td, textAlign:"right", fontWeight:600, color: custo > 0 ? "#dc2626" : "#16a34a" }}>
                                {custo.toLocaleString("pt-BR",{minimumFractionDigits:2, maximumFractionDigits:2})}
                              </td>
                              <td style={{ ...s.td, textAlign:"right" }}>
                                {Number(r.consumo_mwh).toLocaleString("pt-BR",{maximumFractionDigits:0})}
                              </td>
                              <td style={{ ...s.td, textAlign:"right" }}>{r.n_agentes}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}
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
  btnLimpar: { fontSize:11, color:"#2563eb", background:"none", border:"none", cursor:"pointer", padding:"0 4px", textDecoration:"underline" },
};
