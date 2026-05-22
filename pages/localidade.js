import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

function fmt(v, dec = 2) {
  if (v == null || v === "") return "—";
  return Number(v).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

const UF_NOME = {
  AC:"Acre",AM:"Amazonas",AP:"Amapá",PA:"Pará",RO:"Rondônia",RR:"Roraima",TO:"Tocantins",
  AL:"Alagoas",BA:"Bahia",CE:"Ceará",MA:"Maranhão",PB:"Paraíba",PE:"Pernambuco",
  PI:"Piauí",RN:"Rio G. Norte",SE:"Sergipe",
  DF:"Distrito Federal",GO:"Goiás",MT:"Mato Grosso",MS:"Mato G. Sul",
  ES:"Espírito Santo",MG:"Minas Gerais",RJ:"Rio de Janeiro",SP:"São Paulo",
  PR:"Paraná",RS:"Rio G. Sul",SC:"Santa Catarina",
};

export default function Localidade() {
  const router = useRouter();

  const [opcoes,    setOpcoes]    = useState({ estados: [], cidades: [] });
  const [busca,     setBusca]     = useState("");
  const [estadoSel, setEstadoSel] = useState("");
  const [cidadeSel, setCidadeSel] = useState("");
  const [resultado, setResultado] = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [erro,      setErro]      = useState(null);

  const inputRef = useRef(null);

  // Carrega opções de estados/cidades ao montar
  useEffect(() => {
    fetch(`${API_URL}/localidade/opcoes`)
      .then(r => r.json())
      .then(d => { if (!d.error) setOpcoes(d); })
      .catch(() => {});
  }, []);

  // Sincroniza com query string (para links externos)
  useEffect(() => {
    if (!router.isReady) return;
    const { estado, cidade, q } = router.query;
    if (estado) { setEstadoSel(estado); pesquisar({ estado }); }
    else if (cidade) { setCidadeSel(cidade); pesquisar({ cidade }); }
    else if (q)     { setBusca(q); pesquisar({ q }); }
  }, [router.isReady]);

  async function pesquisar(params) {
    const p = params || buildParams();
    if (!p.estado && !p.cidade && !p.q) return;

    setLoading(true);
    setErro(null);
    setResultado(null);

    const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v));
    try {
      const r = await fetch(`${API_URL}/localidade?${qs}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setResultado(d);
    } catch (e) {
      setErro(e.message);
    } finally {
      setLoading(false);
    }
  }

  function buildParams() {
    if (estadoSel) return { estado: estadoSel };
    if (cidadeSel) return { cidade: cidadeSel };
    if (busca.trim()) return { q: busca.trim() };
    return {};
  }

  function onEstado(uf) {
    setEstadoSel(uf);
    setCidadeSel("");
    setBusca("");
    pesquisar({ estado: uf });
  }

  function onSubmitBusca(e) {
    e.preventDefault();
    setEstadoSel("");
    setCidadeSel("");
    pesquisar({ q: busca.trim() });
  }

  // Cidades filtradas pelo estado selecionado
  const cidadesFiltradas = estadoSel
    ? opcoes.cidades.filter(c => c.estado_uf === estadoSel)
    : opcoes.cidades;

  const totalParcelas = resultado?.reduce((s, a) => s + a.n_parcelas, 0) ?? 0;
  const totalConsumo  = resultado?.reduce((s, a) => s + a.consumo_medio_mwm, 0) ?? 0;

  return (
    <div style={s.page}>
      <style jsx>{`
        @media (max-width: 768px) {
          .nav-inner { padding: 0 16px !important; }
          .inner { padding: 24px 16px !important; }
          .ufs { gap: 6px !important; }
          .uf-btn { font-size: 11px !important; padding: 4px 8px !important; }
        }
        .agente-link:hover { text-decoration: underline; }
        .row-card:hover { background: #f8fafc; }
      `}</style>

      {/* Nav */}
      <nav style={s.nav}>
        <div className="nav-inner" style={s.navInner}>
          <Link href="/" style={s.navBack}>← Início</Link>
          <span style={s.logo}>⚡ CCEE Monitor</span>
          <span />
        </div>
      </nav>

      <div className="inner" style={s.inner}>
        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <h1 style={s.titulo}>Cargas por Localidade</h1>
          <p style={s.subtitulo}>Busque agentes pelo estado ou cidade onde possuem parcelas de carga</p>
        </div>

        {/* Busca livre */}
        <form onSubmit={onSubmitBusca} style={s.searchRow}>
          <input
            ref={inputRef}
            value={busca}
            onChange={e => { setBusca(e.target.value); setEstadoSel(""); setCidadeSel(""); }}
            placeholder="Digite cidade, estado ou ramo de atividade..."
            style={s.searchInput}
          />
          <button type="submit" style={s.searchBtn} disabled={!busca.trim() || loading}>
            {loading ? "Buscando..." : "Buscar"}
          </button>
        </form>

        {/* Filtro por estado */}
        <div style={{ marginBottom: 20 }}>
          <p style={s.labelSecao}>Filtrar por estado</p>
          <div className="ufs" style={s.ufsWrap}>
            {opcoes.estados.map(uf => (
              <button
                key={uf}
                onClick={() => estadoSel === uf ? (setEstadoSel(""), setResultado(null)) : onEstado(uf)}
                style={{
                  ...s.ufBtn,
                  ...(estadoSel === uf ? s.ufBtnAtivo : {}),
                }}
                className="uf-btn"
                title={UF_NOME[uf] || uf}
              >
                {uf}
              </button>
            ))}
          </div>
        </div>

        {/* Filtro por cidade (aparece após selecionar estado) */}
        {estadoSel && cidadesFiltradas.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <p style={s.labelSecao}>Filtrar por cidade em {UF_NOME[estadoSel] || estadoSel}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {cidadesFiltradas.map(c => (
                <button
                  key={c.cidade}
                  onClick={() => {
                    const nova = cidadeSel === c.cidade ? "" : c.cidade;
                    setCidadeSel(nova);
                    pesquisar(nova ? { cidade: nova } : { estado: estadoSel });
                  }}
                  style={{
                    ...s.ufBtn,
                    fontSize: 11,
                    ...(cidadeSel === c.cidade ? s.ufBtnAtivo : {}),
                  }}
                >
                  {c.cidade}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Erro */}
        {erro && <div style={s.errorBox}>⚠ {erro}</div>}

        {/* Resultados */}
        {resultado && (
          <>
            {/* Resumo */}
            <div style={s.resumo}>
              <span style={s.resumoItem}>
                <b>{resultado.length}</b> agente{resultado.length !== 1 ? "s" : ""}
              </span>
              <span style={s.resumoSep}>·</span>
              <span style={s.resumoItem}>
                <b>{totalParcelas.toLocaleString("pt-BR")}</b> parcelas
              </span>
              <span style={s.resumoSep}>·</span>
              <span style={s.resumoItem}>
                <b>{fmt(totalConsumo)}</b> MWm consumo médio/mês
              </span>
            </div>

            {resultado.length === 0 ? (
              <p style={{ color: "#94a3b8", padding: "32px 0", textAlign: "center" }}>
                Nenhuma carga encontrada para este filtro.
              </p>
            ) : (
              <div style={s.tableWrap}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Agente</th>
                      <th style={s.th}>Razão Social</th>
                      <th style={{ ...s.th, textAlign: "center" }}>Parcelas</th>
                      <th style={{ ...s.th, textAlign: "right" }}>Consumo médio/mês</th>
                      <th style={{ ...s.th, textAlign: "right" }}>Modulação média</th>
                      <th style={s.th}>Localidades</th>
                      <th style={s.th}>Último mês</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultado.map(a => (
                      <tr key={a.agente} className="row-card" style={s.tr}>
                        <td style={s.td}>
                          <Link
                            href={`/inteligencia/${encodeURIComponent(a.agente)}`}
                            style={s.agenteLink}
                            className="agente-link"
                          >
                            {a.sigla || a.agente}
                          </Link>
                        </td>
                        <td style={{ ...s.td, color: "#64748b", fontSize: 12 }}>
                          {a.razao_social || "—"}
                        </td>
                        <td style={{ ...s.td, textAlign: "center", fontWeight: 600 }}>
                          {a.n_parcelas}
                        </td>
                        <td style={{ ...s.td, textAlign: "right", fontWeight: 700, color: "#2563eb" }}>
                          {fmt(a.consumo_medio_mwm)}
                          <span style={{ fontSize: 10, fontWeight: 400, color: "#94a3b8", marginLeft: 2 }}>MWm</span>
                        </td>
                        <td style={{ ...s.td, textAlign: "right" }}>
                          {a.media_custo_mod != null ? (
                            <span style={{ fontWeight: 700, color: a.media_custo_mod >= 0 ? "#16a34a" : "#ea580c" }}>
                              {a.media_custo_mod >= 0 ? "+" : ""}{fmt(a.media_custo_mod)} <span style={{ fontSize: 10, fontWeight: 400, color: "#94a3b8" }}>R$/MWh</span>
                            </span>
                          ) : <span style={{ color: "#94a3b8" }}>—</span>}
                        </td>
                        <td style={s.td}>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {[...new Map(
                              a.localidades.map(l => [`${l.estado_uf}|${l.cidade}`, l])
                            ).values()].slice(0, 6).map(l => (
                              <span
                                key={`${l.estado_uf}|${l.cidade}`}
                                style={s.tag}
                                title={l.ramo}
                              >
                                {l.cidade ? `${l.cidade} (${l.estado_uf})` : l.estado_uf}
                              </span>
                            ))}
                            {new Set(a.localidades.map(l => `${l.estado_uf}|${l.cidade}`)).size > 6 && (
                              <span style={{ ...s.tag, background: "#e2e8f0", color: "#64748b" }}>
                                +{new Set(a.localidades.map(l => `${l.estado_uf}|${l.cidade}`)).size - 6}
                              </span>
                            )}
                          </div>
                        </td>
                        <td style={{ ...s.td, color: "#64748b", fontSize: 12 }}>
                          {a.localidades[0]?.ultimo_mes || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {!resultado && !loading && !erro && (
          <div style={s.emptyState}>
            <p style={{ fontSize: 32, margin: "0 0 12px" }}>📍</p>
            <p style={{ margin: 0, color: "#64748b" }}>
              Selecione um estado ou busque por cidade para ver os agentes com cargas nessa localidade.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const s = {
  page:      { minHeight: "100vh", background: "#f8fafc", fontFamily: "system-ui, sans-serif" },
  nav:       { background: "#fff", borderBottom: "1px solid #e2e8f0", position: "sticky", top: 0, zIndex: 10 },
  navInner:  { maxWidth: 1200, margin: "0 auto", padding: "0 24px", height: 52, display: "flex", alignItems: "center", justifyContent: "space-between" },
  navBack:   { fontSize: 13, color: "#2563eb", textDecoration: "none", fontWeight: 500 },
  logo:      { fontSize: 15, fontWeight: 700, color: "#1e293b" },
  inner:     { maxWidth: 1200, margin: "0 auto", padding: "32px 24px" },
  titulo:    { fontSize: 26, fontWeight: 800, color: "#1e293b", margin: "0 0 6px" },
  subtitulo: { fontSize: 14, color: "#64748b", margin: 0 },

  searchRow:  { display: "flex", gap: 8, marginBottom: 20 },
  searchInput: {
    flex: 1, padding: "10px 14px", fontSize: 14,
    border: "1px solid #e2e8f0", borderRadius: 8, outline: "none",
    background: "#fff", color: "#1e293b",
  },
  searchBtn: {
    padding: "10px 20px", background: "#2563eb", color: "#fff",
    border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600,
    cursor: "pointer", whiteSpace: "nowrap",
  },

  labelSecao: { fontSize: 12, fontWeight: 600, color: "#64748b", marginBottom: 8, marginTop: 0, textTransform: "uppercase", letterSpacing: "0.05em" },
  ufsWrap:    { display: "flex", flexWrap: "wrap", gap: 6 },
  ufBtn:      {
    padding: "5px 10px", fontSize: 12, fontWeight: 600,
    border: "1px solid #e2e8f0", borderRadius: 6,
    background: "#fff", color: "#374151", cursor: "pointer",
    transition: "all 0.15s",
  },
  ufBtnAtivo: { background: "#2563eb", color: "#fff", borderColor: "#2563eb" },

  resumo:     { display: "flex", alignItems: "center", gap: 8, marginBottom: 16, fontSize: 13, color: "#374151" },
  resumoItem: {},
  resumoSep:  { color: "#cbd5e1" },

  tableWrap: { background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", overflow: "hidden" },
  table:     { width: "100%", borderCollapse: "collapse" },
  th:        { padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", textAlign: "left" },
  tr:        { borderBottom: "1px solid #f1f5f9", transition: "background 0.1s" },
  td:        { padding: "10px 14px", fontSize: 13, color: "#1e293b", verticalAlign: "middle" },
  agenteLink: { color: "#2563eb", fontWeight: 700, textDecoration: "none", fontSize: 13 },
  tag:        { fontSize: 11, padding: "2px 7px", background: "#eff6ff", color: "#2563eb", borderRadius: 4, fontWeight: 500, whiteSpace: "nowrap" },

  errorBox: { background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 16px", color: "#dc2626", fontSize: 13, marginBottom: 16 },
  emptyState: { textAlign: "center", padding: "64px 0", color: "#94a3b8" },
};
