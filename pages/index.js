import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/router";

// URL da página de PLD da CCEE — substitua pelo endereço exato que você encontrar
// em https://www.ccee.org.br (ex: aba "Dados do Mercado" > PLD)
const CCEE_PLD_URL = "https://www.ccee.org.br";

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

export default function Home() {
  const router = useRouter();
  const [busca, setBusca] = useState("");

  function handleBusca(e) {
    e.preventDefault();
    const nome = busca.trim().toUpperCase();
    if (nome.length >= 2) {
      router.push(`/inteligencia/${encodeURIComponent(nome)}`);
    }
  }

  return (
    <div style={s.page}>
      <style jsx>{`
        @media (max-width: 768px) {
          .nav-inner    { padding: 0 16px !important; }
          .hero-section { padding: 64px 16px 48px !important; }
          .section-pad  { padding: 48px 16px !important; }
          .cta-section  { padding: 48px 16px !important; }
        }
        @media (max-width: 480px) {
          .search-form  { flex-direction: column !important; border-radius: 12px !important; overflow: visible !important; }
          .search-input { border-radius: 10px !important; border: 1.5px solid rgba(255,255,255,0.15) !important; }
          .search-btn   { border-radius: 10px !important; width: 100% !important; padding: 14px !important; }
        }
      `}</style>

      {/* ── Navbar ─────────────────────────────────────────────── */}
      <nav style={s.nav}>
        <div className="nav-inner" style={s.navInner}>
          <span style={s.logo}>⚡Monitoramento Mercado Livre</span>
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
          <form onSubmit={handleBusca} className="search-form" style={s.searchForm}>
            <input
              type="text"
              placeholder="Nome do agente"
              value={busca}
              onChange={e => setBusca(e.target.value)}
              className="search-input"
              style={s.searchInput}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className="search-btn" style={s.searchBtn}>Buscar →</button>
          </form>
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
          <p style={s.eyebrow}>Mercado de curto prazo</p>
          <h2 style={s.h2}>PLD — Preço de Liquidação das Diferenças</h2>
          <p style={s.sectionSub}>
            O PLD é calculado semanalmente pela CCEE com base no custo marginal de operação do
            Sistema Interligado Nacional (SIN). Ele define o custo de liquidar sobras e déficits
            de energia no mercado de curto prazo.
          </p>
          <div style={s.iframeWrap}>
            <iframe
              src={CCEE_PLD_URL}
              title="PLD CCEE"
              style={s.iframe}
              frameBorder="0"
              loading="lazy"
            />
          </div>
          <p style={s.iframeFallback}>
            Se a visualização não aparecer,{" "}
            <a href={CCEE_PLD_URL} target="_blank" rel="noopener noreferrer" style={s.link}>
              acesse diretamente no site da CCEE ↗
            </a>
          </p>
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

  /* PLD iframe */
  iframeWrap: {
    width: "100%",
    borderRadius: 14,
    overflow: "hidden",
    border: "1px solid #e2e8f0",
    background: "#f8fafc",
  },
  iframe: {
    display: "block",
    width: "100%",
    height: 520,
    border: "none",
  },
  iframeFallback: {
    fontSize: 13,
    color: "#94a3b8",
    marginTop: 12,
  },
  link: { color: "#2563eb", textDecoration: "none", fontWeight: 600 },

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
