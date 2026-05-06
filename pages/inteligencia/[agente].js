import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import {
  LineChart, AreaChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine
} from "recharts";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

const SUBMERCADOS = ["SE", "S", "NE", "N"];

const METRICAS = [
  { key: "consumo",            label: "Consumo",            color: "#2563eb", unidade: "MWm" },
  { key: "compra",             label: "Compra",             color: "#16a34a", unidade: "MWm" },
  { key: "geracao",            label: "Geração",            color: "#059669", unidade: "MWm", apenasComValor: true },
  { key: "venda",              label: "Venda",              color: "#f59e0b", unidade: "MWm", apenasComValor: true },
  { key: "consumo_geracao",    label: "Cons. da Ger.",      color: "#8b5cf6", unidade: "MWm", apenasComValor: true },
  { key: "resultado",          label: "Resultado com ajustes",          color: "#dc2626", unidade: "R$"  },
  { key: "mcp",                label: "MCP",                color: "#d97706", unidade: "R$"  },
  { key: "resultado_mcp",      label: "Resultado final",      color: "#7c3aed", unidade: "R$"  },
  { key: "balanco_energetico", label: "Balanço Energético", color: "#0891b2", unidade: "MWm" },
];

const GRAFICOS = [
  {
    titulo: "Consumo e Compra",
    domain: [0, 'auto'],
    unidade: "MWm",
    linhas: [
      { key: "consumo", label: "Consumo", color: "#2563eb" },
      { key: "compra",  label: "Compra",  color: "#16a34a" },
    ],
  },
  {
    titulo: "Geração",
    domain: [0, 'auto'],
    unidade: "MWm",
    skipIfAllNull: "geracao",
    linhas: [
      { key: "geracao", label: "Geração", color: "#059669" },
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
    titulo: "MCP",
    unidade: "R$",
    linhas: [
      { key: "mcp", label: "MCP", color: "#d97706" },
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

  const [cargas,         setCargas]         = useState([]);
  const [mesCargas,      setMesCargas]      = useState(null);
  const [loadingCargas,  setLoadingCargas]  = useState(false);
  const [filtroEstado,   setFiltroEstado]   = useState("");
  const [filtroCidade,   setFiltroCidade]   = useState("");
  const [filtroRamo,     setFiltroRamo]     = useState("");
  const [filtroSub,      setFiltroSub]      = useState("");

  const [usinas,         setUsinas]         = useState([]);
  const [mesUsinas,      setMesUsinas]      = useState(null);
  const [loadingUsinas,  setLoadingUsinas]  = useState(false);
  const [filtroFonte,    setFiltroFonte]    = useState("");
  const [filtroSubU,     setFiltroSubU]     = useState("");
  const [filtroEstadoU,  setFiltroEstadoU]  = useState("");

  const [modulacao,        setModulacao]        = useState(null);
  const [modulacaoGer,     setModulacaoGer]     = useState(null);
  const modulacaoIntervalRef    = useRef(null);
  const modulacaoGerIntervalRef = useRef(null);

  const [contabilizacao,   setContabilizacao]   = useState([]);
  const [loadingContab,    setLoadingContab]    = useState(false);

  const [curvaCarga,        setCurvaCarga]        = useState([]);
  const [loadingCurva,      setLoadingCurva]      = useState(false);
  const [curvaCargaPerfil,  setCurvaCargaPerfil]  = useState([]);
  const [activePerfilCarga, setActivePerfilCarga] = useState(null);
  const [curvaGeracao,      setCurvaGeracao]      = useState([]);
  const [loadingCurvaGer,   setLoadingCurvaGer]   = useState(false);
  const [activeUsinaGer,    setActiveUsinaGer]    = useState(null);
  const [activeSubCarga,    setActiveSubCarga]    = useState(null);

  const [sazonalizacao,    setSazonalizacao]    = useState(null);
  const [contratoMWm,      setContratoMWm]      = useState("");

  const [modulacaoPerfil,   setModulacaoPerfil]   = useState(null);
  const [sazMode,           setSazMode]           = useState("total"); // "total" | "sub" | "perfil"
  const [sazoSub,           setSazoSub]           = useState(null);
  const [sazoPerfilData,    setSazoPerfilData]     = useState(null);

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
          // Agente já existe no banco — busca sem ?mes para o backend verificar
          // se há mês mais recente na CCEE (freshness check). O mês selecionado
          // virá da resposta, não do histórico local.
          setHistorico(json);
          const r2    = await fetch(`${API_URL}/inteligencia/${encoded}`);
          const dados = await r2.json();
          if (dados.error) throw new Error(dados.error);

          fetchedMesRef.current = dados.mes;
          setDadosMes(dados);
          setMesSelecionado(dados.mes);

          // Se o backend trouxe um mês mais novo, re-busca histórico atualizado
          if (dados.mes > json[json.length - 1].mes) {
            const r3   = await fetch(`${API_URL}/inteligencia/${encoded}/historico`);
            const hist = await r3.json();
            if (Array.isArray(hist)) setHistorico(hist);
          }
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

  // ── 3. Busca cargas quando o agente ou mês selecionado mudar ─────
  useEffect(() => {
    if (!agente || !mesSelecionado) return;
    const params = new URLSearchParams();
    params.set("mes", mesSelecionado);
    if (filtroEstado) params.set("estado",     filtroEstado);
    if (filtroCidade) params.set("cidade",     filtroCidade);
    if (filtroRamo)   params.set("ramo",       filtroRamo);
    if (filtroSub)    params.set("submercado", filtroSub);

    setLoadingCargas(true);
    fetch(`${API_URL}/inteligencia/${encodeURIComponent(agente)}/cargas?${params}`)
      .then(r => r.json())
      .then(json => {
        if (json.error) setError(`Cargas: ${json.error}`);
        else { setCargas(json.registros); setMesCargas(json.mes); }
      })
      .catch(err => setError(`Cargas: ${err.message}`))
      .finally(() => setLoadingCargas(false));
  }, [agente, mesSelecionado, filtroEstado, filtroCidade, filtroRamo, filtroSub]);

  // ── 4. Curvas de carga e geração típicas em pu (carrega uma vez por agente)
  useEffect(() => {
    if (!agente) return;
    setLoadingCurva(true);
    fetch(`${API_URL}/inteligencia/${encodeURIComponent(agente)}/curva-carga`)
      .then(r => r.json())
      .then(json => { if (!json.error) setCurvaCarga(json); })
      .catch(() => {})
      .finally(() => setLoadingCurva(false));

    fetch(`${API_URL}/inteligencia/${encodeURIComponent(agente)}/curva-carga-perfil`)
      .then(r => r.json())
      .then(json => { if (!json.error) setCurvaCargaPerfil(json); })
      .catch(() => {});

    fetch(`${API_URL}/inteligencia/${encodeURIComponent(agente)}/sazonalizacao`)
      .then(r => r.json())
      .then(json => { if (!json.error) setSazonalizacao(json); })
      .catch(() => {});

    fetch(`${API_URL}/inteligencia/${encodeURIComponent(agente)}/sazonalizacao?modo=sub`)
      .then(r => r.json())
      .then(json => { if (!json.error) setSazoSub(json); })
      .catch(() => {});

    fetch(`${API_URL}/inteligencia/${encodeURIComponent(agente)}/sazonalizacao?modo=perfil`)
      .then(r => r.json())
      .then(json => { if (!json.error) setSazoPerfilData(json); })
      .catch(() => {});

    setLoadingCurvaGer(true);
    fetch(`${API_URL}/inteligencia/${encodeURIComponent(agente)}/curva-geracao`)
      .then(r => r.json())
      .then(json => {
        if (!json.error) setCurvaGeracao(json);
      })
      .catch(() => {})
      .finally(() => setLoadingCurvaGer(false));
  }, [agente]);

  // ── 5. Busca contabilização por perfil quando agente ou mês mudar ──
  useEffect(() => {
    if (!agente || !mesSelecionado) return;
    setLoadingContab(true);
    fetch(`${API_URL}/inteligencia/${encodeURIComponent(agente)}/contabilizacao?mes=${mesSelecionado}`)
      .then(r => r.json())
      .then(json => {
        if (json.error) console.warn("Contabilização:", json.error);
        else setContabilizacao(json);
      })
      .catch(() => {})
      .finally(() => setLoadingContab(false));
  }, [agente, mesSelecionado]);

  // ── 5. Busca usinas quando o agente ou mês selecionado mudar ────────
  useEffect(() => {
    if (!agente || !mesSelecionado) return;
    const params = new URLSearchParams();
    params.set("mes", mesSelecionado);
    if (filtroFonte)   params.set("fonte",      filtroFonte);
    if (filtroSubU)    params.set("submercado",  filtroSubU);
    if (filtroEstadoU) params.set("estado",      filtroEstadoU);

    setLoadingUsinas(true);
    fetch(`${API_URL}/inteligencia/${encodeURIComponent(agente)}/usinas?${params}`)
      .then(r => r.json())
      .then(json => {
        if (json.error) setError(`Usinas: ${json.error}`);
        else { setUsinas(json.registros); setMesUsinas(json.mes); }
      })
      .catch(err => setError(`Usinas: ${err.message}`))
      .finally(() => setLoadingUsinas(false));
  }, [agente, mesSelecionado, filtroFonte, filtroSubU, filtroEstadoU]);

  // ── 5. Polling de modulação — inicia após histórico, para quando concluído ──
  useEffect(() => {
    if (!agente || loadingHist) return;

    const fetchModulacao = () => {
      fetch(`${API_URL}/inteligencia/${encodeURIComponent(agente)}/modulacao`)
        .then(r => r.json())
        .then(json => {
          if (json.error) return;
          setModulacao(json);
          // Para o polling quando não há mais nada calculando
          if (!json.calculando && modulacaoIntervalRef.current) {
            clearInterval(modulacaoIntervalRef.current);
            modulacaoIntervalRef.current = null;
          }
        })
        .catch(() => {});
    };

    fetchModulacao(); // fetch imediato
    modulacaoIntervalRef.current = setInterval(fetchModulacao, 5000);

    return () => {
      clearInterval(modulacaoIntervalRef.current);
      modulacaoIntervalRef.current = null;
    };
  }, [agente, loadingHist]);

  // ── Busca modulação por perfil quando mês selecionado muda ──────────────────
  useEffect(() => {
    if (!agente || !mesSelecionado) return;
    fetch(`${API_URL}/inteligencia/${encodeURIComponent(agente)}/modulacao-perfil?mes=${mesSelecionado}`)
      .then(r => r.json())
      .then(json => { if (!json.error) setModulacaoPerfil(json); })
      .catch(() => {});
  }, [agente, mesSelecionado]);

  // ── 6. Polling modulação de geração ──────────────────────────────────────────
  useEffect(() => {
    if (!agente || loadingHist) return;

    const fetch_ = () => {
      fetch(`${API_URL}/inteligencia/${encodeURIComponent(agente)}/modulacao-geracao`)
        .then(r => r.json())
        .then(json => {
          if (json.error) return;
          setModulacaoGer(json);
          if (!json.calculando && modulacaoGerIntervalRef.current) {
            clearInterval(modulacaoGerIntervalRef.current);
            modulacaoGerIntervalRef.current = null;
          }
        })
        .catch(() => {});
    };

    fetch_();
    modulacaoGerIntervalRef.current = setInterval(fetch_, 5000);
    return () => {
      clearInterval(modulacaoGerIntervalRef.current);
      modulacaoGerIntervalRef.current = null;
    };
  }, [agente, loadingHist]);

  // Metadados vêm do mês atual ou do primeiro registro do histórico
  const meta = dadosMes ?? (historico.length > 0 ? historico[0] : null);

  if (!agente) return <div style={s.center}>Carregando...</div>;

  return (
    <div style={s.page}>
      <style jsx>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (max-width: 768px) {
          .nav-inner    { padding: 0 16px !important; }
          .page-inner   { padding: 24px 16px !important; }
          .metrics-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .cargas-grid  { grid-template-columns: repeat(2, 1fr) !important; }
          .agent-name   { font-size: 20px !important; }
          .card-value   { font-size: 19px !important; flex-wrap: wrap; }
        }
        @media (max-width: 480px) {
          .metrics-grid { grid-template-columns: 1fr 1fr !important; }
          .cargas-grid  { grid-template-columns: 1fr 1fr !important; }
          .card-value   { font-size: 15px !important; flex-wrap: wrap; }
        }
      `}</style>

      {/* ── Navbar ──────────────────────────────────────────────── */}
      <nav style={s.nav}>
        <div className="nav-inner" style={s.navInner}>
          <Link href="/" style={s.navBack}>← Início</Link>
          <span style={s.logo}>⚡ CCEE Monitor</span>
          <div style={{ width: 80 }} /> {/* spacer */}
        </div>
      </nav>

      <div className="page-inner" style={s.inner}>

        {/* ── Header do agente ────────────────────────────────── */}
        <div style={s.header}>
          <div style={{ flex: 1 }}>
            <h1 className="agent-name" style={s.agenteName}>{agente}</h1>
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

            <div className="metrics-grid" style={s.grid}>
              {METRICAS.map(m => {
                // Cards opcionais: visibilidade determinada pelo histórico (estável após carga)
                // Evita layout shift — a decisão não muda a cada troca de mês
                if (m.apenasComValor && !loadingHist) {
                  const temNoHistorico = historico.some(h => h[m.key] != null && Number(h[m.key]) !== 0);
                  const temNoDadosMes  = dadosMes?.[m.key] != null && Number(dadosMes[m.key]) !== 0;
                  if (!temNoHistorico && !temNoDadosMes) return null;
                }
                const val      = dadosMes?.[m.key];
                const negativo = !loadingMes
                  && ["mcp", "resultado", "resultado_mcp"].includes(m.key)
                  && Number(val) < 0;
                const cor = loadingMes ? "#d1d5db" : negativo ? "#dc2626" : m.color;

                return (
                  <div key={m.key} style={{ ...s.card, ...(negativo ? s.cardAlerta : {}) }}>
                    <p style={s.cardLabel}>{m.label}</p>
                    <p className="card-value" style={{ ...s.cardValue, color: cor }}>
                      {!loadingMes && val != null && m.unidade === "R$" && (
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8" }}>R$</span>
                      )}
                      {loadingMes ? "—" : fmt(val)}
                      {!loadingMes && val != null && m.unidade === "MWm" && (
                        <span style={{ fontSize: 11, fontWeight: 400, color: "#94a3b8" }}>MWm</span>
                      )}
                      {negativo && <span style={s.alertaIcon} title="Aporte necessário na CCEE">⚠</span>}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* ── Gráficos históricos ───────────────────────────── */}
            {historico.length > 0 && GRAFICOS.map(g => {
              if (g.skipIfAllNull && !historico.some(d => d[g.skipIfAllNull] != null)) return null;

              const valores = historico
                .flatMap(d => g.linhas.map(l => d[l.key]))
                .filter(v => v != null && isFinite(Number(v)))
                .map(Number)
                .sort((a, b) => a - b);

              let yDomain = g.domain || ['auto', 'auto'];
              if (!g.domain && valores.length >= 4) {
                const p2  = valores[Math.floor(valores.length * 0.02)];
                const p98 = valores[Math.ceil(valores.length * 0.98) - 1];
                const pad = (p98 - p2) * 0.1 || Math.abs(p2) * 0.1 || 100;
                yDomain = [Math.floor(p2 - pad), Math.ceil(p98 + pad)];
              }

              const fmtTick = v => {
                const n = Number(v);
                if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
                return n.toFixed(0);
              };

              return (
              <div key={g.titulo} style={s.chartBox}>
                <h2 style={s.chartTitle}>{g.titulo}</h2>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={historico} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="mes" tick={{ fontSize: 11, fill: "#9ca3af" }} />
                    <YAxis
                      tick={{ fontSize: 11, fill: "#9ca3af" }}
                      domain={yDomain}
                      tickFormatter={fmtTick}
                      label={{
                        value: g.unidade,
                        angle: -90,
                        position: "insideLeft",
                        offset: 10,
                        style: { fontSize: 11, fill: "#9ca3af" }
                      }}
                      width={55}
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
            ); })}
          </>
        )}

        {/* ── Curva de Carga Típica por Submercado ─────────────── */}
        {curvaCarga.length > 0 && (() => {
          const COR_SUB = { SE: "#2563eb", S: "#059669", NE: "#f59e0b", N: "#dc2626" };
          const subs = [...new Set(curvaCarga.map(r => r.submercado))];
          const porHora = {};
          for (const r of curvaCarga) {
            if (!porHora[r.hora]) porHora[r.hora] = { hora: r.hora };
            porHora[r.hora][r.submercado] = r.pu;
          }
          const dados = Object.values(porHora).sort((a, b) => a.hora - b.hora);

          return (
            <div style={s.chartBox}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
                <h2 style={{ ...s.chartTitle, margin: 0 }}>Curva de Carga Típica</h2>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>média histórica por hora do dia • pu por submercado</span>
                {activeSubCarga && (
                  <button onClick={() => setActiveSubCarga(null)}
                    style={{ fontSize: 11, color: "#6b7280", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 6, padding: "2px 8px", cursor: "pointer" }}>
                    ver todas
                  </button>
                )}
              </div>

              {/* Legenda clicável */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                {subs.map(sub => {
                  const cor   = COR_SUB[sub] || "#2563eb";
                  const ativa = !activeSubCarga || activeSubCarga === sub;
                  return (
                    <button key={sub} onClick={() => setActiveSubCarga(prev => prev === sub ? null : sub)} style={{
                      display: "flex", alignItems: "center", gap: 5,
                      fontSize: 11, fontWeight: 600,
                      color: ativa ? cor : "#94a3b8",
                      background: ativa ? `${cor}18` : "#f8fafc",
                      border: `1px solid ${ativa ? cor : "#e2e8f0"}`,
                      borderRadius: 20, padding: "4px 10px",
                      cursor: "pointer", transition: "all 0.15s",
                    }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: ativa ? cor : "#d1d5db", flexShrink: 0 }} />
                      {sub}
                    </button>
                  );
                })}
              </div>

              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={dados} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    {subs.map(sub => (
                      <linearGradient key={sub} id={`gradCarga${sub}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor={COR_SUB[sub] || "#2563eb"} stopOpacity={0.22} />
                        <stop offset="95%" stopColor={COR_SUB[sub] || "#2563eb"} stopOpacity={0.01} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f8" />
                  <XAxis dataKey="hora" tickFormatter={h => `${String(h).padStart(2,"0")}h`} tick={{ fontSize: 11, fill: "#64748b" }} interval={1} />
                  <YAxis domain={[0, 1]} tickFormatter={v => `${(v*100).toFixed(0)}%`} tick={{ fontSize: 11, fill: "#64748b" }} width={42} />
                  <Tooltip
                    labelFormatter={h => `Hora ${String(h).padStart(2,"0")}:00`}
                    formatter={(v, name) => [`${(v*100).toFixed(1)}%`, name]}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <ReferenceLine y={1} stroke="#94a3b8" strokeDasharray="4 2" strokeWidth={1} />
                  {subs.map(sub => {
                    const cor   = COR_SUB[sub] || "#2563eb";
                    const ativa = !activeSubCarga || activeSubCarga === sub;
                    return (
                      <Area
                        key={sub}
                        type="monotone"
                        dataKey={sub}
                        name={sub}
                        stroke={cor}
                        strokeWidth={activeSubCarga === sub ? 2.5 : 1.5}
                        strokeOpacity={ativa ? 1 : 0.1}
                        fill={ativa ? `url(#gradCarga${sub})` : "transparent"}
                        dot={false}
                        activeDot={ativa ? { r: 4 } : false}
                      />
                    );
                  })}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          );
        })()}

        {/* ── Curva de Carga por Perfil (só mostra quando há 2+ perfis distintos) ── */}
        {curvaCargaPerfil.length > 0 && [...new Set(curvaCargaPerfil.map(r => r.sigla_perfil))].length > 1 && (() => {
          const CORES = ["#2563eb","#059669","#f59e0b","#dc2626","#7c3aed","#0891b2","#ea580c","#16a34a"];
          const perfis = [...new Set(curvaCargaPerfil.map(r => r.sigla_perfil))];
          const porHora = {};
          for (const r of curvaCargaPerfil) {
            if (!porHora[r.hora]) porHora[r.hora] = { hora: r.hora };
            porHora[r.hora][r.sigla_perfil] = r.pu;
          }
          const dados = Object.values(porHora).sort((a, b) => a.hora - b.hora);

          return (
            <div style={s.chartBox}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
                <h2 style={{ ...s.chartTitle, margin: 0 }}>Curva de Carga por Perfil</h2>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>média histórica por hora do dia • pu por perfil de agente</span>
                {activePerfilCarga && (
                  <button onClick={() => setActivePerfilCarga(null)}
                    style={{ fontSize: 11, color: "#6b7280", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 6, padding: "2px 8px", cursor: "pointer" }}>
                    ver todos
                  </button>
                )}
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                {perfis.map((p, i) => {
                  const cor   = CORES[i % CORES.length];
                  const ativa = !activePerfilCarga || activePerfilCarga === p;
                  return (
                    <button key={p} onClick={() => setActivePerfilCarga(prev => prev === p ? null : p)} style={{
                      display: "flex", alignItems: "center", gap: 5,
                      fontSize: 11, fontWeight: 600,
                      color: ativa ? cor : "#94a3b8",
                      background: ativa ? `${cor}18` : "#f8fafc",
                      border: `1px solid ${ativa ? cor : "#e2e8f0"}`,
                      borderRadius: 20, padding: "4px 10px",
                      cursor: "pointer", transition: "all 0.15s",
                    }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: ativa ? cor : "#d1d5db", flexShrink: 0 }} />
                      {p}
                    </button>
                  );
                })}
              </div>

              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={dados} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    {perfis.map((p, i) => (
                      <linearGradient key={p} id={`gradCargaPerfil${i}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor={CORES[i % CORES.length]} stopOpacity={0.22} />
                        <stop offset="95%" stopColor={CORES[i % CORES.length]} stopOpacity={0.01} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f8" />
                  <XAxis dataKey="hora" tickFormatter={h => `${String(h).padStart(2,"0")}h`} tick={{ fontSize: 11, fill: "#64748b" }} interval={1} />
                  <YAxis domain={[0, 1]} tickFormatter={v => `${(v*100).toFixed(0)}%`} tick={{ fontSize: 11, fill: "#64748b" }} width={42} />
                  <Tooltip
                    labelFormatter={h => `Hora ${String(h).padStart(2,"0")}:00`}
                    formatter={(v, name) => [`${(v*100).toFixed(1)}%`, name]}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <ReferenceLine y={1} stroke="#94a3b8" strokeDasharray="4 2" strokeWidth={1} />
                  {perfis.map((p, i) => {
                    const ativa = !activePerfilCarga || activePerfilCarga === p;
                    return (
                      <Area
                        key={p}
                        type="monotone"
                        dataKey={p}
                        name={p}
                        stroke={CORES[i % CORES.length]}
                        strokeWidth={activePerfilCarga === p ? 2.5 : 1.5}
                        strokeOpacity={ativa ? 1 : 0.1}
                        fill={ativa ? `url(#gradCargaPerfil${i})` : "transparent"}
                        dot={false}
                        activeDot={ativa ? { r: 4 } : false}
                      />
                    );
                  })}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          );
        })()}

        {/* ── Curva de Geração por Usina ───────────────────────── */}
        {curvaGeracao.length > 0 && (() => {
          const CORES = ["#059669","#2563eb","#f59e0b","#dc2626","#7c3aed","#0891b2","#ea580c","#16a34a"];
          const usinas = [...new Set(curvaGeracao.map(r => r.sigla_usina))];
          const porHora = {};
          for (const r of curvaGeracao) {
            if (!porHora[r.hora]) porHora[r.hora] = { hora: r.hora };
            porHora[r.hora][r.sigla_usina] = r.pu;
          }
          const dados = Object.values(porHora).sort((a, b) => a.hora - b.hora);

          return (
            <div style={s.chartBox}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
                <h2 style={{ ...s.chartTitle, margin: 0 }}>Curva de Geração por Usina</h2>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>média histórica • pu por unidade geradora</span>
                {activeUsinaGer && (
                  <button onClick={() => setActiveUsinaGer(null)}
                    style={{ fontSize: 11, color: "#6b7280", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 6, padding: "2px 8px", cursor: "pointer" }}>
                    ver todas
                  </button>
                )}
              </div>

              {/* Legenda clicável: clica para isolar, clica novamente para voltar todas */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                {usinas.map((u, i) => {
                  const cor   = CORES[i % CORES.length];
                  const ativa = !activeUsinaGer || activeUsinaGer === u;
                  return (
                    <button key={u} onClick={() => setActiveUsinaGer(prev => prev === u ? null : u)} style={{
                      display: "flex", alignItems: "center", gap: 5,
                      fontSize: 11, fontWeight: 600,
                      color: ativa ? cor : "#94a3b8",
                      background: ativa ? `${cor}18` : "#f8fafc",
                      border: `1px solid ${ativa ? cor : "#e2e8f0"}`,
                      borderRadius: 20, padding: "4px 10px",
                      cursor: "pointer", transition: "all 0.15s",
                    }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: ativa ? cor : "#d1d5db", flexShrink: 0 }} />
                      {u}
                    </button>
                  );
                })}
              </div>

              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={dados} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    {usinas.map((u, i) => (
                      <linearGradient key={u} id={`gradGer${i}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor={CORES[i % CORES.length]} stopOpacity={0.22} />
                        <stop offset="95%" stopColor={CORES[i % CORES.length]} stopOpacity={0.01} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f8" />
                  <XAxis dataKey="hora" tickFormatter={h => `${String(h).padStart(2,"0")}h`} tick={{ fontSize: 11, fill: "#64748b" }} interval={1} />
                  <YAxis domain={[0, 1]} tickFormatter={v => `${(v*100).toFixed(0)}%`} tick={{ fontSize: 11, fill: "#64748b" }} width={42} />
                  <Tooltip
                    labelFormatter={h => `Hora ${String(h).padStart(2,"0")}:00`}
                    formatter={(v, name) => [`${(v*100).toFixed(1)}%`, name]}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <ReferenceLine y={1} stroke="#94a3b8" strokeDasharray="4 2" strokeWidth={1} />
                  {usinas.map((u, i) => {
                    const ativa = !activeUsinaGer || activeUsinaGer === u;
                    return (
                      <Area
                        key={u}
                        type="monotone"
                        dataKey={u}
                        name={u}
                        stroke={CORES[i % CORES.length]}
                        strokeWidth={activeUsinaGer === u ? 2.5 : 1.5}
                        strokeOpacity={ativa ? 1 : 0.1}
                        fill={ativa ? `url(#gradGer${i})` : "transparent"}
                        dot={false}
                        activeDot={ativa ? { r: 4 } : false}
                      />
                    );
                  })}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          );
        })()}

        {/* ── Unidades Consumidoras ────────────────────────────── */}
        {!loadingHist && (
          <div style={s.chartBox}>
            <div style={s.cargasHeader}>
              <h2 style={s.chartTitle}>
                Unidades Consumidoras
                {mesCargas && mesCargas !== mesSelecionado && (
                  <span style={{ fontSize: 12, fontWeight: 400, color: "#94a3b8", marginLeft: 10 }}>
                    (dados mais recentes disponíveis: {mesCargas})
                  </span>
                )}
              </h2>
              {loadingCargas && <span style={s.mesLoading}>carregando...</span>}
            </div>

            {/* Filtros */}
            <div style={s.filtros}>
              <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)} style={s.filtroSelect}>
                <option value="">Todos os estados</option>
                {[...new Set(cargas.map(c => c.estado_uf).filter(Boolean))].sort().map(e => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
              <input
                placeholder="Cidade"
                value={filtroCidade}
                onChange={e => setFiltroCidade(e.target.value)}
                style={s.filtroInput}
              />
              <input
                placeholder="Ramo de atividade"
                value={filtroRamo}
                onChange={e => setFiltroRamo(e.target.value)}
                style={s.filtroInput}
              />
              <select value={filtroSub} onChange={e => setFiltroSub(e.target.value)} style={s.filtroSelect}>
                <option value="">Todos submercados</option>
                {SUBMERCADOS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {/* Cards resumo */}
            {cargas.length > 0 && (() => {
              const totalConsumo    = cargas.reduce((s, c) => s + (Number(c.consumo_total) || 0), 0);
              const totalConsumACL  = cargas.reduce((s, c) => s + (Number(c.consumo_acl)   || 0), 0);
              const porSub          = cargas.reduce((acc, c) => {
                acc[c.submercado || "—"] = (acc[c.submercado || "—"] || 0) + 1;
                return acc;
              }, {});
              return (
                <div className="cargas-grid" style={s.cargasResumo}>
                  <div style={s.card}>
                    <p style={s.cardLabel}>Unidades Consumidoras</p>
                    <p className="card-value" style={{ ...s.cardValue, color: "#2563eb" }}>{cargas.length}</p>
                  </div>
                  <div style={s.card}>
                    <p style={s.cardLabel}>Consumo Total (MWh)</p>
                    <p className="card-value" style={{ ...s.cardValue, color: "#16a34a" }}>{fmt(totalConsumo)}</p>
                  </div>
                  <div style={s.card}>
                    <p style={s.cardLabel}>Consumo ACL (MWh)</p>
                    <p className="card-value" style={{ ...s.cardValue, color: "#0891b2" }}>{fmt(totalConsumACL)}</p>
                  </div>
                  {Object.entries(porSub).map(([sub, n]) => (
                    <div key={sub} style={s.card}>
                      <p style={s.cardLabel}>Submercado {sub}</p>
                      <p className="card-value" style={{ ...s.cardValue, color: "#7c3aed" }}>{n}</p>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Tabela */}
            {cargas.length === 0 && !loadingCargas ? (
              <p style={{ fontSize: 14, color: "#94a3b8", textAlign: "center", padding: "24px 0" }}>
                Nenhuma unidade consumidora encontrada.
              </p>
            ) : (
              <div style={s.tableScroll}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      {["Parcela","Mês ref.","Cidade","UF","Ramo","Submercado","Demanda (MW)","Consumo ACL (MWh)","Consumo Total (MWh)"].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cargas.map((c, i) => (
                      <tr key={i} style={i % 2 === 0 ? s.trEven : {}}>
                        <td style={s.td}>{c.sigla_parcela_carga || "—"}</td>
                        <td style={s.td}>{c.mes_referencia || "—"}</td>
                        <td style={s.td}>{c.cidade || "—"}</td>
                        <td style={s.td}>{c.estado_uf || "—"}</td>
                        <td style={s.td}>{c.ramo_atividade || "—"}</td>
                        <td style={s.td}>{c.submercado || "—"}</td>
                        <td style={{ ...s.td, textAlign: "right" }}>{fmt(c.capacidade_carga)}</td>
                        <td style={{ ...s.td, textAlign: "right" }}>{fmt(c.consumo_acl)}</td>
                        <td style={{ ...s.td, textAlign: "right" }}>{fmt(c.consumo_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Modulação horária ────────────────────────────────── */}
        {!loadingHist && (
          <div style={s.chartBox}>
            <div style={s.cargasHeader}>
              <h2 style={s.chartTitle}>Modulação Horária</h2>
              {modulacao?.calculando && (
                <span style={{ fontSize: 13, color: "#2563eb", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={s.spinnerSm} />
                  Calculando{modulacao.calculados > 0 ? ` (${modulacao.calculados}/${modulacao.total_meses} meses)` : "…"}
                </span>
              )}
              {modulacao && !modulacao.calculando && modulacao.calculados === 0 && (
                <span style={{ fontSize: 13, color: "#94a3b8" }}>Sem dados de consumo horário disponíveis</span>
              )}
            </div>

            {(!modulacao || (modulacao.calculando && modulacao.calculados === 0)) ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "24px 0" }}>
                <span style={s.spinnerSm} />
                <span style={{ fontSize: 14, color: "#64748b" }}>
                  {modulacao ? "Aguardando primeiros resultados…" : "Carregando…"}
                </span>
              </div>
            ) : modulacao.resultados.length > 0 ? (
              <div style={s.tableScroll}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      {["Mês","Submercado","Consumo (MWh)","Horas","Curva (R$)","Flat (R$)","Custo Mod. (R$/MWh)",""].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      // Coleta todos os submercados por mês (agente pode ter SE e S no mesmo mês)
                      const subsPorMes = {};
                      modulacao.resultados.forEach(r => {
                        if (!subsPorMes[r.mes_referencia]) subsPorMes[r.mes_referencia] = [];
                        subsPorMes[r.mes_referencia].push(r.submercado);
                      });
                      const mesesVistos = new Set();
                      return modulacao.resultados.map((r, i) => {
                        const custo       = Number(r.custo_modulacao_rs_mwh);
                        const cor         = custo > 0 ? "#dc2626" : custo < 0 ? "#16a34a" : "#374151";
                        const primeiroMes = !mesesVistos.has(r.mes_referencia);
                        if (primeiroMes) mesesVistos.add(r.mes_referencia);
                        const csvUrl    = `${API_URL}/inteligencia/${encodeURIComponent(agente)}/consumo-horario/csv?mes=${r.mes_referencia}`;
                        const subParams = (subsPorMes[r.mes_referencia] || []).join(",");
                        return (
                          <tr key={i} style={i % 2 === 0 ? s.trEven : {}}>
                            <td style={s.td}>{r.mes_referencia}</td>
                            <td style={s.td}>{r.submercado}</td>
                            <td style={{ ...s.td, textAlign: "right" }}>{fmt(r.consumo_total_mwh)}</td>
                            <td style={{ ...s.td, textAlign: "right" }}>{r.n_horas}</td>
                            <td style={{ ...s.td, textAlign: "right" }}>{fmt(r.soma_curva_rs)}</td>
                            <td style={{ ...s.td, textAlign: "right" }}>{fmt(r.soma_flat_rs)}</td>
                            <td style={{ ...s.td, textAlign: "right", fontWeight: 700, color: cor }}>
                              {custo > 0 ? "+" : ""}{fmt(custo)}
                            </td>
                            <td style={{ ...s.td, textAlign: "center" }}>
                              {primeiroMes && (
                                <span style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                                  <a href={csvUrl} download style={s.csvBtn} title="Consumo horário">
                                    ↓ Consumo
                                  </a>
                                  <a href={`${API_URL}/pld/horario/csv?mes=${r.mes_referencia}&submercado=${subParams}`} download style={{ ...s.csvBtn, color: "#7c3aed", background: "#f5f3ff", borderColor: "#ddd6fe" }} title={`PLD horário — ${subParams}`}>
                                    ↓ PLD
                                  </a>
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        )}

        {/* ── Modulação Horária — por Perfil ──────────────────── */}
        {!loadingHist && modulacaoPerfil?.resultados?.length > 0 && (
          <div style={s.chartBox}>
            <div style={s.cargasHeader}>
              <h2 style={s.chartTitle}>Modulação Horária — por Perfil</h2>
              <span style={{ fontSize: 13, color: "#64748b" }}>{mesSelecionado}</span>
            </div>
            <div style={s.tableScroll}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {["Perfil","Submercado","Consumo (MWh)","Horas","Curva (R$)","Flat (R$)","Custo Mod. (R$/MWh)"].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {modulacaoPerfil.resultados.map((r, i) => {
                    const custo = Number(r.custo_modulacao_rs_mwh);
                    const cor   = custo > 0 ? "#dc2626" : custo < 0 ? "#16a34a" : "#374151";
                    return (
                      <tr key={i} style={i % 2 === 0 ? s.trEven : {}}>
                        <td style={{ ...s.td, fontWeight: 600, whiteSpace: "nowrap" }}>{r.sigla_perfil}</td>
                        <td style={s.td}>{r.submercado}</td>
                        <td style={{ ...s.td, textAlign: "right" }}>{fmt(r.consumo_total_mwh)}</td>
                        <td style={{ ...s.td, textAlign: "right" }}>{r.n_horas}</td>
                        <td style={{ ...s.td, textAlign: "right" }}>{fmt(r.soma_curva_rs)}</td>
                        <td style={{ ...s.td, textAlign: "right" }}>{fmt(r.soma_flat_rs)}</td>
                        <td style={{ ...s.td, textAlign: "right", fontWeight: 700, color: cor }}>
                          {custo > 0 ? "+" : ""}{fmt(custo)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Unidades Geradoras ───────────────────────────────── */}
        {!loadingHist && usinas.length > 0 && (
          <div style={s.chartBox}>
            <div style={s.cargasHeader}>
              <h2 style={s.chartTitle}>
                Unidades Geradoras
                {mesUsinas && mesUsinas !== mesSelecionado && (
                  <span style={{ fontSize: 12, fontWeight: 400, color: "#94a3b8", marginLeft: 10 }}>
                    (dados mais recentes disponíveis: {mesUsinas})
                  </span>
                )}
              </h2>
              {loadingUsinas && <span style={s.mesLoading}>carregando...</span>}
            </div>

            {/* Filtros */}
            <div style={s.filtros}>
              <select value={filtroFonte} onChange={e => setFiltroFonte(e.target.value)} style={s.filtroSelect}>
                <option value="">Todas as fontes</option>
                {[...new Set(usinas.map(u => u.fonte_energia_primaria).filter(Boolean))].sort().map(f => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
              <select value={filtroSubU} onChange={e => setFiltroSubU(e.target.value)} style={s.filtroSelect}>
                <option value="">Todos submercados</option>
                {SUBMERCADOS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={filtroEstadoU} onChange={e => setFiltroEstadoU(e.target.value)} style={s.filtroSelect}>
                <option value="">Todos os estados</option>
                {[...new Set(usinas.map(u => u.estado_uf).filter(Boolean))].sort().map(e => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
            </div>

            {usinas.length === 0 && !loadingUsinas ? (
              <p style={{ fontSize: 14, color: "#94a3b8", textAlign: "center", padding: "24px 0" }}>
                Nenhuma unidade geradora encontrada para este agente.
              </p>
            ) : (
              <div style={s.tableScroll}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      {["Ativo","Fonte","Submercado","UF","Cap. (MW)","Ger. CG (MWmed)","GF CG (MWmed)","Desc. (%)","MRE"].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {usinas.map((u, i) => (
                      <tr key={i} style={i % 2 === 0 ? s.trEven : {}}>
                        <td style={s.td}>{u.sigla_ativo || "—"}</td>
                        <td style={s.td}>{u.fonte_energia_primaria || "—"}</td>
                        <td style={s.td}>{u.submercado || "—"}</td>
                        <td style={s.td}>{u.estado_uf || "—"}</td>
                        <td style={{ ...s.td, textAlign: "right" }}>{fmt(u.cap_t)}</td>
                        <td style={{ ...s.td, textAlign: "right" }}>{fmt(u.geracao_centro_gravidade)}</td>
                        <td style={{ ...s.td, textAlign: "right" }}>{fmt(u.gf_centro_gravidade)}</td>
                        <td style={{ ...s.td, textAlign: "right" }}>
                          {u.percentual_desconto_usina != null && !isNaN(Number(u.percentual_desconto_usina))
                            ? `${fmt(u.percentual_desconto_usina)}%`
                            : "—"}
                        </td>
                        <td style={s.td}>
                          {["S", "Sim", "SIM", "s"].includes(u.participante_mre)
                            ? <span style={s.badgeSim}>Sim</span>
                            : <span style={s.badgeNao}>Não</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Modulação de Geração ─────────────────────────────── */}
        {!loadingHist && usinas.length > 0 && (
          <div style={s.chartBox}>
            <div style={s.cargasHeader}>
              <h2 style={s.chartTitle}>Modulação Horária — Geração</h2>
              {modulacaoGer?.calculando && (
                <span style={{ fontSize: 13, color: "#059669", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ ...s.spinnerSm, borderTopColor: "#059669" }} />
                  Calculando{modulacaoGer.calculados > 0 ? ` (${modulacaoGer.calculados}/${modulacaoGer.total_meses} meses)` : "…"}
                </span>
              )}
              {modulacaoGer && !modulacaoGer.calculando && modulacaoGer.calculados === 0 && (
                <span style={{ fontSize: 13, color: "#94a3b8" }}>Sem dados de geração horária disponíveis</span>
              )}
            </div>

            {(!modulacaoGer || (modulacaoGer.calculando && modulacaoGer.calculados === 0)) ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "24px 0" }}>
                <span style={{ ...s.spinnerSm, borderTopColor: "#059669" }} />
                <span style={{ fontSize: 14, color: "#64748b" }}>
                  {modulacaoGer ? "Aguardando primeiros resultados…" : "Carregando…"}
                </span>
              </div>
            ) : modulacaoGer.resultados.length > 0 ? (
              <div style={s.tableScroll}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      {["Mês","Usina","Submercado","Geração (MWh)","Horas","Curva (R$)","Flat (R$)","Custo Mod. (R$/MWh)",""].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const mesesVistos = new Set();
                      return modulacaoGer.resultados.map((r, i) => {
                        const custo       = Number(r.custo_modulacao_rs_mwh);
                        const cor         = custo > 0 ? "#dc2626" : custo < 0 ? "#16a34a" : "#374151";
                        const primeiroMes = !mesesVistos.has(r.mes_referencia);
                        if (primeiroMes) mesesVistos.add(r.mes_referencia);
                        return (
                          <tr key={i} style={i % 2 === 0 ? s.trEven : {}}>
                            <td style={s.td}>{r.mes_referencia}</td>
                            <td style={{ ...s.td, fontWeight: 600, whiteSpace: "nowrap" }}>{r.sigla_usina || "—"}</td>
                            <td style={s.td}>{r.submercado}</td>
                            <td style={{ ...s.td, textAlign: "right" }}>{fmt(r.geracao_total_mwh)}</td>
                            <td style={{ ...s.td, textAlign: "right" }}>{r.n_horas}</td>
                            <td style={{ ...s.td, textAlign: "right" }}>{fmt(r.soma_curva_rs)}</td>
                            <td style={{ ...s.td, textAlign: "right" }}>{fmt(r.soma_flat_rs)}</td>
                            <td style={{ ...s.td, textAlign: "right", fontWeight: 700, color: cor }}>
                              {custo > 0 ? "+" : ""}{fmt(custo)}
                            </td>
                            <td style={{ ...s.td, textAlign: "center" }}>
                              {primeiroMes && (
                                <a
                                  href={`${API_URL}/inteligencia/${encodeURIComponent(agente)}/geracao-horaria/csv?mes=${r.mes_referencia}`}
                                  download
                                  style={{ ...s.csvBtn, color: "#059669", background: "#f0fdf4", borderColor: "#bbf7d0" }}
                                  title="Geração horária por usina"
                                >
                                  ↓ Geração
                                </a>
                              )}
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        )}

        {/* ── Sugestão de Sazonalização ────────────────────────── */}
        {sazonalizacao && (() => {
          const contrato  = parseFloat(contratoMWm.replace(",", ".")) || 0;
          // horas do ano-alvo (ano base + 1 como proxy, ou ano corrente)
          const anoAlvo   = sazonalizacao.ano_base + 1;
          const horasAlvo = sazonalizacao.meses.reduce((s, m) => {
            // replica horas do mês base para o mesmo mês do ano alvo
            const mesNum = Number(m.mes.split("-")[1]);
            return s + new Date(anoAlvo, mesNum, 0).getDate() * 24;
          }, 0);
          const totalMWhContratado = contrato * horasAlvo;

          const MESES_PT = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

          return (
            <div style={s.chartBox}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
                <div>
                  <h2 style={{ ...s.chartTitle, margin: "0 0 4px" }}>Sugestão de Sazonalização</h2>
                  <span style={{ fontSize: 12, color: "#94a3b8" }}>
                    base: {sazonalizacao.ano_base} • média anual: <strong>{sazonalizacao.media_mwm.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} MWm</strong>
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3, marginLeft: "auto" }}>
                  <label style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>Montante contratado (MWm)</label>
                  <input
                    type="text"
                    value={contratoMWm}
                    onChange={e => setContratoMWm(e.target.value)}
                    placeholder={sazonalizacao.media_mwm.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}
                    style={{ width: 130, fontSize: 13, padding: "6px 10px", border: "1.5px solid #e2e8f0", borderRadius: 8, outline: "none" }}
                  />
                  <span style={{ fontSize: 11, color: "#94a3b8" }}>use vírgula — ex: {sazonalizacao.media_mwm.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</span>
                </div>
              </div>

              {/* Tabs */}
              <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: "2px solid #e2e8f0", paddingBottom: 0 }}>
                {[["total","Total"],["sub","Por Submercado"],["perfil","Por Perfil"]].map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setSazMode(key)}
                    style={{
                      padding: "7px 16px", fontSize: 13, fontWeight: sazMode === key ? 700 : 400,
                      background: "none", border: "none", cursor: "pointer",
                      borderBottom: sazMode === key ? "2px solid #2563eb" : "2px solid transparent",
                      color: sazMode === key ? "#2563eb" : "#64748b",
                      marginBottom: -2, outline: "none",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {sazMode === "total" && (
                <>
                  {contrato > 0 && Math.abs(contrato / sazonalizacao.media_mwm - 1) > 0.5 && (
                    <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 14px", marginBottom: 12, fontSize: 12, color: "#92400e" }}>
                      ⚠ Montante informado ({contrato.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} MWm) difere muito da média histórica ({sazonalizacao.media_mwm.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} MWm). Verifique se o valor está correto — use vírgula como separador decimal.
                    </div>
                  )}
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ ...s.table, fontSize: 12 }}>
                      <thead>
                        <tr>
                          {["Mês", "Horas", `Base (MWm) ${sazonalizacao.ano_base}`, "Part. (%)", "Sugestão (MWm)", `Realizado ${sazonalizacao.ano_atual} (MWm)`, "Aderência", "Desvio do flat"].map(h => (
                            <th key={h} style={{ ...s.th, textAlign: h === "Mês" ? "left" : "right" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sazonalizacao.meses.map((m, i) => {
                          const mesNum      = Number(m.mes.split("-")[1]);
                          const diasAlvo    = new Date(anoAlvo, mesNum, 0).getDate();
                          const horasMes    = diasAlvo * 24;
                          const part        = m.participacao_pct / 100;
                          const mwhSug      = contrato > 0 ? totalMWhContratado * part : null;
                          const mwmSug      = mwhSug != null ? mwhSug / horasMes : null;
                          const flatMWh     = contrato > 0 ? contrato * horasMes : null;
                          const fator       = (flatMWh && flatMWh > 0 && mwhSug != null) ? mwhSug / flatMWh : null;
                          const corFator    = fator == null ? "#374151" : fator > 1.05 ? "#dc2626" : fator < 0.95 ? "#2563eb" : "#16a34a";
                          const realizado   = sazonalizacao.realizado_atual?.[mesNum] ?? null;
                          const aderencia   = (realizado != null && mwmSug != null && mwmSug > 0)
                                                ? realizado / mwmSug
                                                : null;
                          const corAder     = aderencia == null ? "#374151"
                                            : aderencia > 1.05 ? "#dc2626"
                                            : aderencia < 0.95 ? "#2563eb"
                                            : "#16a34a";
                          return (
                            <tr key={m.mes} style={i % 2 === 0 ? s.trEven : {}}>
                              <td style={s.td}><strong>{MESES_PT[mesNum - 1]}/{anoAlvo}</strong></td>
                              <td style={{ ...s.td, textAlign: "right" }}>{horasMes}</td>
                              <td style={{ ...s.td, textAlign: "right", color: "#64748b" }}>
                                {m.consumo_mwm.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}
                              </td>
                              <td style={{ ...s.td, textAlign: "right", fontWeight: 600 }}>
                                {m.participacao_pct.toFixed(2)}%
                              </td>
                              <td style={{ ...s.td, textAlign: "right", fontWeight: 600 }}>
                                {mwmSug != null ? mwmSug.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : "—"}
                              </td>
                              <td style={{ ...s.td, textAlign: "right", color: realizado != null ? "#0f172a" : "#94a3b8" }}>
                                {realizado != null ? realizado.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : "—"}
                              </td>
                              <td style={{ ...s.td, textAlign: "right", fontWeight: aderencia != null ? 700 : 400, color: corAder }}>
                                {aderencia != null ? `${(aderencia * 100).toFixed(1)}%` : "—"}
                              </td>
                              <td style={{ ...s.td, textAlign: "right", fontWeight: 700, color: corFator }}>
                                {fator != null ? `${(fator * 100).toFixed(1)}%` : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      {contrato > 0 && (
                        <tfoot>
                          <tr style={{ background: "#f1f5f9", fontWeight: 700 }}>
                            <td style={s.td}>Total / Média</td>
                            <td style={{ ...s.td, textAlign: "right" }}>{horasAlvo}</td>
                            <td style={{ ...s.td, textAlign: "right" }}>
                              {sazonalizacao.media_mwm.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}
                            </td>
                            <td style={{ ...s.td, textAlign: "right" }}>100,00%</td>
                            <td style={{ ...s.td, textAlign: "right" }}>
                              {contrato.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}
                            </td>
                            <td style={{ ...s.td, textAlign: "right", color: "#64748b" }}>
                              {(() => {
                                const vals = Object.values(sazonalizacao.realizado_atual || {});
                                if (!vals.length) return "—";
                                const soma  = vals.reduce((s, v) => s + v, 0);
                                const media = soma / vals.length;
                                return media.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
                              })()}
                            </td>
                            <td style={{ ...s.td, textAlign: "right" }}>—</td>
                            <td style={{ ...s.td, textAlign: "right" }}>—</td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </>
              )}

              {sazMode === "sub" && (
                sazoSub ? (() => {
                  const subs = [...new Set(sazoSub.meses.map(m => m.submercado))].sort();
                  const mesesBase = [...new Set(sazoSub.meses.map(m => m.mes))].sort();
                  const dataMap = {};
                  sazoSub.meses.forEach(m => { dataMap[`${m.mes}|${m.submercado}`] = m; });
                  return (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ ...s.table, fontSize: 12 }}>
                        <thead>
                          <tr>
                            <th style={{ ...s.th, textAlign: "left" }}>Mês ({sazoSub.ano_base})</th>
                            {subs.map(sub => (
                              <React.Fragment key={sub}>
                                <th style={{ ...s.th, textAlign: "right" }}>{sub} Part. (%)</th>
                                <th style={{ ...s.th, textAlign: "right" }}>{sub} Real. {sazoSub.ano_atual} (MWh)</th>
                              </React.Fragment>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {mesesBase.map((mes_r, i) => {
                            const mesNum = Number(mes_r.split("-")[1]);
                            return (
                              <tr key={mes_r} style={i % 2 === 0 ? s.trEven : {}}>
                                <td style={s.td}><strong>{MESES_PT[mesNum - 1]}</strong></td>
                                {subs.map(sub => {
                                  const d = dataMap[`${mes_r}|${sub}`];
                                  return (
                                    <React.Fragment key={sub}>
                                      <td style={{ ...s.td, textAlign: "right" }}>{d ? `${d.participacao_pct.toFixed(2)}%` : "—"}</td>
                                      <td style={{ ...s.td, textAlign: "right", color: d?.realizado_mwh != null ? "#0f172a" : "#94a3b8" }}>
                                        {d?.realizado_mwh != null ? d.realizado_mwh.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : "—"}
                                      </td>
                                    </React.Fragment>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })()
                : <p style={{ fontSize: 14, color: "#94a3b8", padding: "16px 0" }}>Dados de consumo horário necessários</p>
              )}

              {sazMode === "perfil" && (
                sazoPerfilData ? (() => {
                  const perfis = [...new Set(sazoPerfilData.meses.map(m => m.sigla_perfil))].sort();
                  const mesesBase = [...new Set(sazoPerfilData.meses.map(m => m.mes))].sort();
                  const dataMap = {};
                  sazoPerfilData.meses.forEach(m => { dataMap[`${m.mes}|${m.sigla_perfil}`] = m; });
                  return (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ ...s.table, fontSize: 12 }}>
                        <thead>
                          <tr>
                            <th style={{ ...s.th, textAlign: "left" }}>Mês ({sazoPerfilData.ano_base})</th>
                            {perfis.map(p => (
                              <React.Fragment key={p}>
                                <th style={{ ...s.th, textAlign: "right" }}>{p} Part. (%)</th>
                                <th style={{ ...s.th, textAlign: "right" }}>{p} Real. {sazoPerfilData.ano_atual} (MWh)</th>
                              </React.Fragment>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {mesesBase.map((mes_r, i) => {
                            const mesNum = Number(mes_r.split("-")[1]);
                            return (
                              <tr key={mes_r} style={i % 2 === 0 ? s.trEven : {}}>
                                <td style={s.td}><strong>{MESES_PT[mesNum - 1]}</strong></td>
                                {perfis.map(p => {
                                  const d = dataMap[`${mes_r}|${p}`];
                                  return (
                                    <React.Fragment key={p}>
                                      <td style={{ ...s.td, textAlign: "right" }}>{d ? `${d.participacao_pct.toFixed(2)}%` : "—"}</td>
                                      <td style={{ ...s.td, textAlign: "right", color: d?.realizado_mwh != null ? "#0f172a" : "#94a3b8" }}>
                                        {d?.realizado_mwh != null ? d.realizado_mwh.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : "—"}
                                      </td>
                                    </React.Fragment>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })()
                : <p style={{ fontSize: 14, color: "#94a3b8", padding: "16px 0" }}>Dados de consumo horário necessários</p>
              )}
            </div>
          );
        })()}

        {/* ── Contabilização por Perfil ─────────────────────────── */}
        {contabilizacao.length > 0 && (
          <div style={s.chartBox}>
            <div style={s.cargasHeader}>
              <h2 style={s.chartTitle}>Contabilização por Perfil</h2>
              {loadingContab && <span style={{ fontSize: 12, color: "#94a3b8" }}>Carregando...</span>}
            </div>

            {contabilizacao.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <table style={s.tabelaSimples}>
                  <thead>
                    <tr>
                      {[
                        "Perfil", "MCP (R$)", "Encargo (R$)", "Exposição (R$)",
                        "Ef. Disp.", "Ef. Cota GF", "Ef. Nuclear",
                        "Ef. CCEAR-Q", "Ef. Itaipu", "Ef. RRH",
                        "Ef. Desc. PLD/CMO", "Aj. Recontr.", "Aj. MCSD",
                        "Comp. MRE", "Res. ER", "Resultado Final (R$)",
                      ].map(h => <th key={h} style={s.thSimples}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {contabilizacao.map((r, i) => (
                      <tr key={r.sigla_perfil_agente + i} style={i % 2 === 0 ? { background: "#fafbfc" } : {}}>
                        <td style={{ ...s.tdSimples, fontWeight: 600, whiteSpace: "nowrap" }}>{r.sigla_perfil_agente}</td>
                        {[
                          r.valor_tm_mcp, r.valor_encargo, r.valor_ajuste_exposicao,
                          r.efeito_contrat_disp, r.efeito_contrat_cota_gf, r.efeito_contrat_nuclear,
                          r.efeito_ccearq, r.efeito_contrat_itaipu, r.efeito_repasse_risco_hidro,
                          r.efeito_desloc_pld_cmo, r.ajuste_recontab, r.ajuste_mcsd_ex,
                          r.compensacao_mre, r.resultado_financeiro_er, r.resultado_final,
                        ].map((v, j) => {
                          const n = v != null ? Number(v) : null;
                          const cor = n == null ? "#94a3b8" : n > 0 ? "#16a34a" : n < 0 ? "#dc2626" : "#374151";
                          return (
                            <td key={j} style={{ ...s.tdSimples, textAlign: "right", color: cor, fontWeight: n != null && n !== 0 ? 600 : 400 }}>
                              {n == null ? "—" : n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

/* ── Estilos ─────────────────────────────────────────────────────── */
const s = {
  page:    { background: "#f8fafc", minHeight: "100vh", fontFamily: "system-ui, -apple-system, sans-serif", overflowX: "hidden" },

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
  card:       { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "18px 20px", minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" },
  cardAlerta: { border: "1px solid #fecaca", background: "#fff7f7" },
  cardLabel:  { fontSize: 12, color: "#6b7280", margin: "0 0 6px", fontWeight: 600, minHeight: 32 },
  cardValue:  { fontSize: 24, fontWeight: 800, margin: 0, letterSpacing: -0.5, transition: "color 0.2s", display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" },
  alertaIcon: { fontSize: 18, lineHeight: 1 },

  chartBox:   { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "24px 24px 12px", marginBottom: 20, overflow: "hidden", minWidth: 0 },
  chartTitle: { fontSize: 15, fontWeight: 700, color: "#374151", margin: "0 0 16px" },

  cargasHeader: { display: "flex", alignItems: "center", gap: 12, marginBottom: 16 },
  filtros:      { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 },
  filtroSelect: { fontSize: 13, padding: "7px 10px", border: "1.5px solid #e2e8f0", borderRadius: 7, background: "#fff", color: "#374151", cursor: "pointer" },
  filtroInput:  { fontSize: 13, padding: "7px 10px", border: "1.5px solid #e2e8f0", borderRadius: 7, color: "#374151", outline: "none", minWidth: 160 },

  cargasResumo: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 12, marginBottom: 24 },

  tableWrap:   { overflowX: "auto" },
  tableScroll: { overflowX: "auto", overflowY: "auto", maxHeight: 360 },
  table:       { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th:        { padding: "10px 12px", textAlign: "left", background: "#f1f5f9", color: "#64748b", fontWeight: 600, whiteSpace: "nowrap", borderBottom: "1px solid #e2e8f0" },
  td:        { padding: "9px 12px", color: "#374151", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  trEven:    { background: "#fafbfc" },

  badgeSim:  { fontSize: 11, fontWeight: 600, color: "#059669", background: "#d1fae5", borderRadius: 20, padding: "2px 8px" },
  badgeNao:  { fontSize: 11, fontWeight: 600, color: "#6b7280", background: "#f1f5f9", borderRadius: 20, padding: "2px 8px" },
  spinnerSm: { display: "inline-block", width: 14, height: 14, borderRadius: "50%", border: "2px solid #e2e8f0", borderTopColor: "#2563eb", animation: "spin 0.8s linear infinite", flexShrink: 0 },
  csvBtn:    { fontSize: 11, fontWeight: 600, color: "#2563eb", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 6, padding: "3px 8px", textDecoration: "none", whiteSpace: "nowrap" },

  tabelaSimples: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  thSimples:     { padding: "8px 10px", textAlign: "right", background: "#f8fafc", color: "#64748b", fontWeight: 600, whiteSpace: "nowrap", borderBottom: "2px solid #e2e8f0", fontSize: 11 },
  tdSimples:     { padding: "8px 10px", color: "#374151", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap", fontSize: 12 },
};
