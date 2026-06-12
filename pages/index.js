import Link from "next/link";
import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/router";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";


const CONCEITOS = [
  {
    icon: "⚡",
    titulo: "Ambiente de Contratação Livre",
    texto:
      "Consumidores da média tensão podem negociar energia diretamente com geradores ou comercializadores, escolhendo preço, prazo e fonte de geração.",
  },
  {
    icon: "📊",
    titulo: "PLD — Preço de Liquidação",
    texto:
      "Preço calculado semanalmente pela CCEE que serve de referência para liquidar as diferenças entre a energia contratada e a efetivamente consumida no mercado de curto prazo.",
  },
  {
    icon: "🔋",
    titulo: "Balanço Energético",
    texto:
      "Saldo entre o volume contratado e o consumo real medido. Superávits e déficits são liquidados ao PLD no Mercado de Curto Prazo (MCP).",
  },
  {
    icon: "🏭",
    titulo: "Agentes de Mercado",
    texto:
      "Geradores, distribuidoras, comercializadores e consumidores livres registrados na CCEE que compram e vendem energia no ambiente regulado e no livre.",
  },
];

const VANTAGENS = [
  { num: "01", titulo: "Preço competitivo", texto: "Negociação direta com fornecedores permite capturar preços abaixo da tarifa cativa." },
  { num: "02", titulo: "Gestão de risco",   texto: "Contratos de curto, médio e longo prazo permitem proteger orçamentos contra volatilidade." },
  { num: "03", titulo: "Origem da energia", texto: "Possibilidade de garantir 100% de energia renovável com certificados de energia renováveis." },
];

function fmtR(v) {
  if (v == null) return "—";
  return `R$ ${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtMes(m) {
  if (!m) return "";
  const [ano, mes] = m.split("-");
  const nomes = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
  return `${nomes[Number(mes) - 1]}/${ano}`;
}

export default function Home() {
  const router = useRouter();
  const [busca,       setBusca]       = useState("");
  const [sugestoes,   setSugestoes]   = useState([]);
  const [dropOpen,    setDropOpen]    = useState(false);
  const [dropIdx,     setDropIdx]     = useState(-1);
  const [pld,         setPld]         = useState(null);
  const [pldErr,      setPldErr]      = useState(null);
  const debounceRef   = useRef(null);
  const containerRef  = useRef(null);

  useEffect(() => {
    fetch(`${API_URL}/pld/resumo?submercado=SE`)
      .then(r => r.json())
      .then(json => { if (json.error) throw new Error(json.error); setPld(json); })
      .catch(e => setPldErr(e.message));
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setDropOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const fetchSugestoes = useCallback((q) => {
    clearTimeout(debounceRef.current);
    if (q.trim().length < 2) { setSugestoes([]); setDropOpen(false); return; }
    debounceRef.current = setTimeout(() => {
      fetch(`${API_URL}/agentes/busca?q=${encodeURIComponent(q)}`)
        .then(r => r.json())
        .then(data => {
          if (Array.isArray(data)) { setSugestoes(data); setDropOpen(data.length > 0); }
        })
        .catch(() => {});
    }, 300);
  }, []);

  function handleInputChange(e) {
    const val = e.target.value.toUpperCase();
    setBusca(val);
    setDropIdx(-1);
    fetchSugestoes(val);
  }

  function selecionarSugestao(item) {
    setDropOpen(false);
    setSugestoes([]);
    setBusca(item.agente);
    router.push(`/inteligencia/${encodeURIComponent(item.agente)}`);
  }

  function handleKeyDown(e) {
    if (!dropOpen || sugestoes.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setDropIdx(i => Math.min(i + 1, sugestoes.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setDropIdx(i => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && dropIdx >= 0) {
      e.preventDefault();
      selecionarSugestao(sugestoes[dropIdx]);
    } else if (e.key === "Escape") {
      setDropOpen(false);
    }
  }

  function handleBusca(e) {
    e.preventDefault();
    setDropOpen(false);
    const nome = busca.trim().toUpperCase();
    if (nome.length >= 2) {
      router.push(`/inteligencia/${encodeURIComponent(nome)}`);
    }
  }

  return (
    <div style={s.page}>
      <style jsx>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (max-width: 768px) {
          .nav-inner    { padding: 0 16px !important; }
          .hero-section { padding: 64px 16px 48px !important; }
          .section-pad  { padding: 48px 16px !important; }
          .cta-section  { padding: 48px 16px !important; }
          .nav-logo     { font-size: 14px !important; }
          .nav-logo-txt { display: none; }
        }
        @media (max-width: 480px) {
          .search-input { font-size: 13px !important; padding: 14px 12px !important; }
        }
      `}</style>

      {/* ── Navbar ─────────────────────────────────────────────── */}
      <nav style={s.nav}>
        <div className="nav-inner" style={s.navInner}>
          <span className="nav-logo" style={s.logo}>
            ⚡<span className="nav-logo-txt"> Monitoramento Mercado Livre</span>
          </span>
          <Link href="/localidade" style={{ fontSize: 13, color: "#2563eb", textDecoration: "none", fontWeight: 600, whiteSpace: "nowrap" }}>Localidades →</Link>
          <Link href="/modulacao" style={{ fontSize: 13, color: "#2563eb", textDecoration: "none", fontWeight: 600, whiteSpace: "nowrap" }}>Modulação →</Link>
          <Link href="/mercado" style={{ fontSize: 13, color: "#2563eb", textDecoration: "none", fontWeight: 600, whiteSpace: "nowrap" }}>Mercado →</Link>
        </div>
      </nav>

      {/* ── Hero ───────────────────────────────────────────────── */}
      <section className="hero-section" style={s.hero}>
        <div style={s.heroInner}>
          <span style={s.badge}>Consolidado de dados abertos</span>
          <h1 style={s.h1}>
            Inteligência para o<br />
            Mercado Livre de Energia
          </h1>
          <p style={s.heroSub}>
            Acompanhe consumo, compra, resultado e balanço energético de agentes
            registrados na CCEE. Dados atualizados diretamente dos dados abertos da CCEE.
          </p>
          <div ref={containerRef} style={{ position: "relative", maxWidth: 560, margin: "0 auto 20px" }}>
            <form onSubmit={handleBusca} className="search-form" style={{ ...s.searchForm, margin: 0 }}>
              <input
                type="text"
                placeholder="Nome do agente ou razão social"
                value={busca}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onFocus={() => sugestoes.length > 0 && setDropOpen(true)}
                className="search-input"
                style={s.searchInput}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="search-btn" style={s.searchBtn}>Buscar →</button>
            </form>
            {dropOpen && sugestoes.length > 0 && (
              <ul style={s.dropdown}>
                {sugestoes.map((item, i) => (
                  <li
                    key={item.agente}
                    onMouseDown={() => selecionarSugestao(item)}
                    style={{
                      ...s.dropItem,
                      background: i === dropIdx ? "rgba(37,99,235,0.08)" : "transparent",
                    }}
                  >
                    <span style={s.dropAgente}>{item.agente}</span>
                    {item.razao_social && (
                      <span style={s.dropRazao}>{item.razao_social}</span>
                    )}
                    {item.externo && (
                      <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: 6 }}>CCEE</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <a
            href="https://www.ccee.org.br"
            target="_blank"
            rel="noopener noreferrer"
            style={s.heroLink}
          >
            Informação oficial no site da CCEE ↗
          </a>
        </div>
      </section>

      {/* ── Como funciona ──────────────────────────────────────── */}
      <section className="section-pad" style={s.section}>
        <div style={s.inner}>
          <p style={s.eyebrow}>Conceitos essenciais</p>
          <h2 style={s.h2}>Como funciona o mercado livre</h2>
          <div style={s.grid4}>
            {CONCEITOS.map(c => (
              <div key={c.titulo} style={s.card}>
                <span style={s.cardIcon}>{c.icon}</span>
                <h3 style={s.cardTitulo}>{c.titulo}</h3>
                <p style={s.cardTexto}>{c.texto}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Vantagens ──────────────────────────────────────────── */}
      <section className="section-pad" style={{ ...s.section, background: "#f0f9ff" }}>
        <div style={s.inner}>
          <p style={s.eyebrow}>Por que migrar?</p>
          <h2 style={s.h2}>Vantagens do ACL</h2>
          <div style={s.grid3}>
            {VANTAGENS.map(v => (
              <div key={v.num} style={s.vCard}>
                <span style={s.vNum}>{v.num}</span>
                <h3 style={s.vTitulo}>{v.titulo}</h3>
                <p style={s.cardTexto}>{v.texto}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PLD ────────────────────────────────────────────────── */}
      <section className="section-pad" style={s.section}>
        <div style={s.inner}>
          <p style={s.eyebrow}>Mercado de curto prazo · Todos os submercados</p>
          <h2 style={{ ...s.h2, marginBottom: 12 }}>PLD — Preço de Liquidação das Diferenças</h2>
          <p style={{ ...s.sectionSub, marginBottom: 36 }}>
            PLD horário do dia atual e médias do mês vigente e anterior. Comparação entre submercados.
          </p>

          {/* Loading */}
          {!pld && !pldErr && (
            <div style={s.pldLoading}>
              <div style={s.spinner} />
              <span style={{ fontSize: 14, color: "#64748b" }}>Carregando dados de PLD...</span>
            </div>
          )}

          {/* Erro */}
          {pldErr && (
            <p style={{ color: "#dc2626", fontSize: 14 }}>Erro ao carregar PLD: {pldErr}</p>
          )}

          {/* Conteúdo */}
          {pld && (
            <>
              {/* Cards */}
              <div style={s.pldGrid}>
                {/* Média hoje */}
                <div style={s.pldCard}>
                  <p style={s.pldCardLabel}>Média PLD hoje</p>
                  <p style={s.pldCardSub}>{pld.hoje.data}</p>
                  <p style={s.pldCardValue}>{fmtR(pld.hoje.media)}</p>
                  <p style={s.pldCardUnit}>R$/MWh</p>
                </div>

                {/* Média mês atual */}
                <div style={s.pldCard}>
                  <p style={s.pldCardLabel}>Média PLD {fmtMes(pld.mes_atual.mes)}</p>
                  <p style={s.pldCardSub}>do dia 01 até hoje</p>
                  <p style={s.pldCardValue}>{fmtR(pld.mes_atual.media)}</p>
                  <p style={s.pldCardUnit}>R$/MWh</p>
                </div>

                {/* Média mês anterior */}
                <div style={s.pldCard}>
                  <p style={s.pldCardLabel}>Média PLD {fmtMes(pld.mes_anterior.mes)}</p>
                  <p style={s.pldCardSub}>mês completo</p>
                  <p style={s.pldCardValue}>{fmtR(pld.mes_anterior.media)}</p>
                  <p style={s.pldCardUnit}>R$/MWh</p>
                </div>

                {/* Variação mês atual vs anterior */}
                <div style={s.pldCard}>
                  <p style={s.pldCardLabel}>{fmtMes(pld.mes_atual.mes)} vs {fmtMes(pld.mes_anterior.mes)}</p>
                  <p style={s.pldCardSub}>variação no PLD médio</p>
                  {pld.variacao != null ? (
                    <>
                      <p style={{ ...s.pldCardValue, color: pld.variacao >= 0 ? "#dc2626" : "#16a34a" }}>
                        {pld.variacao >= 0 ? "▲" : "▼"} {fmtR(Math.abs(pld.variacao))}
                      </p>
                      <p style={s.pldCardUnit}>R$/MWh</p>
                    </>
                  ) : (
                    <p style={s.pldCardValue}>—</p>
                  )}
                </div>
              </div>

              {/* Comparação outros submercados */}
              {pld.outros_submercados && (() => {
                const labels = { sul: "Sul", nordeste: "Nordeste", norte: "Norte" };
                const entries = Object.entries(pld.outros_submercados)
                  .filter(([, v]) => v.media_mes != null);
                if (!entries.length) return null;
                return (
                  <div style={{ marginBottom: 28 }}>
                    <p style={{ ...s.eyebrow, marginBottom: 14 }}>
                      Outros submercados — média {fmtMes(pld.mes_atual.mes)} vs SE/CO
                    </p>
                    <div style={s.pldGrid}>
                      {entries.map(([key, v]) => {
                        const diff    = v.diff_seco_mes;
                        const subindo = diff > 0;
                        const cor     = diff == null ? "#0f172a" : subindo ? "#dc2626" : "#16a34a";
                        return (
                          <div key={key} style={s.pldCard}>
                            <p style={s.pldCardLabel}>{labels[key]}</p>
                            <p style={s.pldCardSub}>média {fmtMes(pld.mes_atual.mes)}</p>
                            <p style={s.pldCardValue}>{fmtR(v.media_mes)}</p>
                            {diff != null && (
                              <p style={{ ...s.pldCardUnit, color: cor, fontWeight: 600 }}>
                                {subindo ? "▲" : "▼"} {fmtR(Math.abs(diff))} vs SE/CO
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Gráfico horário do dia */}
              {pld.hoje.chart.length > 0 && (
                <div style={s.pldChartBox}>
                  <p style={s.pldChartTitle}>PLD horário — {pld.hoje.data} · Sudeste</p>
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={pld.hoje.chart} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="hora" tick={{ fontSize: 11, fill: "#94a3b8" }} interval={3} />
                      <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} tickFormatter={v => `${v}`} width={52} />
                      <Tooltip
                        contentStyle={{ borderRadius: 8, fontSize: 13, border: "1px solid #e2e8f0" }}
                        formatter={v => [`R$ ${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`, "PLD"]}
                      />
                      <Line type="monotone" dataKey="pld" stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* ── CTA final ──────────────────────────────────────────── */}
      <section className="cta-section" style={s.ctaSection}>
        <div style={{ ...s.inner, textAlign: "center" }}>
          <h2 style={{ ...s.h2, color: "#fff" }}>Analise seus dados agora</h2>
          <p style={{ ...s.sectionSub, color: "#93c5fd", marginBottom: 32 }}>
            Visualize o histórico completo de um agente: consumo, compra, resultado e balanço.
          </p>
          <Link href="/dashboard" style={s.btnPrimary}>Abrir Dashboard →</Link>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer style={s.footer}>
        <div style={s.footerInner}>
          <span style={s.logo}>⚡Monitoramento Mercado Livre</span>
          <p style={s.footerText}>
            Dados abertos renderizados com amor — uso não oficial
          </p>
        </div>
      </footer>

    </div>
  );
}

/* ── Estilos ─────────────────────────────────────────────────────── */
const s = {
  page: {
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    color: "#0f172a",
    background: "#fff",
    margin: 0,
    overflowX: "hidden",
  },

  /* Navbar */
  nav: {
    position: "sticky",
    top: 0,
    zIndex: 100,
    background: "rgba(255,255,255,0.92)",
    backdropFilter: "blur(8px)",
    borderBottom: "1px solid #e2e8f0",
  },
  navInner: {
    maxWidth: 1100,
    margin: "0 auto",
    padding: "0 32px",
    height: 60,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  logo: { fontSize: 17, fontWeight: 700, color: "#0f172a", letterSpacing: -0.3 },

  /* Hero */
  hero: {
    background: "linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%)",
    padding: "100px 32px 80px",
  },
  heroInner: { maxWidth: 720, margin: "0 auto", textAlign: "center" },
  badge: {
    display: "inline-block",
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: "#93c5fd",
    background: "rgba(147,197,253,0.12)",
    border: "1px solid rgba(147,197,253,0.3)",
    borderRadius: 20,
    padding: "5px 14px",
    marginBottom: 24,
  },
  h1: {
    fontSize: "clamp(32px, 5vw, 52px)",
    fontWeight: 800,
    color: "#fff",
    lineHeight: 1.15,
    letterSpacing: -1,
    margin: "0 0 20px",
  },
  heroSub: {
    fontSize: 17,
    color: "#94a3b8",
    lineHeight: 1.7,
    margin: "0 auto 36px",
    maxWidth: 580,
  },
  searchForm: {
    display: "flex",
    gap: 0,
    maxWidth: 560,
    margin: "0 auto 20px",
    background: "rgba(255,255,255,0.07)",
    border: "1.5px solid rgba(255,255,255,0.15)",
    borderRadius: 12,
    overflow: "hidden",
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    padding: "14px 18px",
    background: "transparent",
    border: "none",
    outline: "none",
    color: "#fff",
  },
  searchBtn: {
    fontSize: 14,
    fontWeight: 700,
    padding: "14px 22px",
    background: "#2563eb",
    color: "#fff",
    border: "none",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  heroLink: {
    display: "block",
    fontSize: 13,
    color: "#64748b",
    textDecoration: "none",
    marginTop: 4,
  },
  dropdown: {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    right: 0,
    background: "#1e293b",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 10,
    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
    listStyle: "none",
    margin: 0,
    padding: "4px 0",
    zIndex: 200,
    maxHeight: 320,
    overflowY: "auto",
  },
  dropItem: {
    padding: "10px 16px",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: 2,
    borderRadius: 6,
    margin: "0 4px",
    transition: "background 0.1s",
  },
  dropAgente: {
    fontSize: 13,
    fontWeight: 700,
    color: "#f1f5f9",
    letterSpacing: 0.2,
  },
  dropRazao: {
    fontSize: 12,
    color: "#94a3b8",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  btnPrimary: {
    display: "inline-block",
    padding: "13px 28px",
    background: "#2563eb",
    color: "#fff",
    fontWeight: 700,
    fontSize: 15,
    borderRadius: 10,
    textDecoration: "none",
    boxShadow: "0 4px 14px rgba(37,99,235,0.4)",
  },
  btnGhost: {
    display: "inline-block",
    padding: "13px 28px",
    background: "transparent",
    color: "#cbd5e1",
    fontWeight: 600,
    fontSize: 15,
    borderRadius: 10,
    textDecoration: "none",
    border: "1.5px solid rgba(203,213,225,0.3)",
  },

  /* Sections */
  section: { padding: "80px 32px", background: "#fff" },
  inner:   { maxWidth: 1100, margin: "0 auto" },
  eyebrow: { fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#2563eb", margin: "0 0 10px" },
  h2:      { fontSize: "clamp(24px, 3vw, 36px)", fontWeight: 800, letterSpacing: -0.5, margin: "0 0 48px", color: "#0f172a" },
  sectionSub: { fontSize: 16, color: "#64748b", lineHeight: 1.7, maxWidth: 640, margin: "0 0 40px" },

  /* Cards de conceito */
  grid4: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 24,
  },
  card: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 14,
    padding: "28px 24px",
  },
  cardIcon:   { fontSize: 28, display: "block", marginBottom: 16 },
  cardTitulo: { fontSize: 15, fontWeight: 700, color: "#0f172a", margin: "0 0 10px" },
  cardTexto:  { fontSize: 14, color: "#64748b", lineHeight: 1.65, margin: 0 },

  /* Cards de vantagem */
  grid3: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: 24,
  },
  vCard: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 14,
    padding: "28px 24px",
  },
  vNum:    { fontSize: 13, fontWeight: 800, color: "#2563eb", display: "block", marginBottom: 12 },
  vTitulo: { fontSize: 17, fontWeight: 700, color: "#0f172a", margin: "0 0 10px" },

  link: { color: "#2563eb", textDecoration: "none", fontWeight: 600 },

  /* PLD */
  pldLoading: { display: "flex", alignItems: "center", gap: 12, padding: "48px 0" },
  spinner: {
    width: 24, height: 24, borderRadius: "50%",
    border: "3px solid #e2e8f0", borderTopColor: "#2563eb",
    animation: "spin 0.8s linear infinite",
  },
  pldGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: 16,
    marginBottom: 28,
  },
  pldCard: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 14,
    padding: "20px 20px 16px",
  },
  pldCardLabel: { fontSize: 12, fontWeight: 700, color: "#2563eb", margin: "0 0 2px", textTransform: "uppercase", letterSpacing: 0.5 },
  pldCardSub:   { fontSize: 11, color: "#94a3b8", margin: "0 0 10px" },
  pldCardValue: { fontSize: 22, fontWeight: 800, color: "#0f172a", margin: "0 0 2px", letterSpacing: -0.5 },
  pldCardUnit:  { fontSize: 11, color: "#94a3b8", margin: 0 },
  pldChartBox:  { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 14, padding: "20px 20px 12px" },
  pldChartTitle: { fontSize: 13, fontWeight: 700, color: "#374151", margin: "0 0 16px" },

  /* CTA final */
  ctaSection: {
    background: "linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%)",
    padding: "80px 32px",
  },

  /* Footer */
  footer: { background: "#0f172a", padding: "32px 32px" },
  footerInner: {
    maxWidth: 1100,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    alignItems: "center",
    textAlign: "center",
  },
  footerText: { fontSize: 13, color: "#475569", margin: 0 },
};
