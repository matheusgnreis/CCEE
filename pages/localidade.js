import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import dynamic from "next/dynamic";
import MultiSelect from "../components/MultiSelect";

const MapaRota = dynamic(() => import("../components/MapaRota"), { ssr: false });

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

// ─── Aba: Por Localidade ──────────────────────────────────────────────────────

function AbaLocalidade({ opcoes }) {
  const router = useRouter();
  const [busca,      setBusca]      = useState("");
  const [estadosSel, setEstadosSel] = useState([]);
  const [cidadesSel, setCidadesSel] = useState([]);
  const [resultado,  setResultado]  = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [erro,       setErro]       = useState(null);

  useEffect(() => {
    if (!router.isReady) return;
    const { estado, cidade, q } = router.query;
    if (estado) { const ufs = [estado]; setEstadosSel(ufs); pesquisar({ estado: ufs.join(",") }); }
    else if (cidade) { const cs = [cidade]; setCidadesSel(cs); pesquisar({ cidade: cs.join(",") }); }
    else if (q)      { setBusca(q); pesquisar({ q }); }
  }, [router.isReady]);

  async function pesquisar(params) {
    const p = params || buildParams();
    if (!p.estado && !p.cidade && !p.q) return;
    setLoading(true); setErro(null); setResultado(null);
    const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v));
    try {
      const r = await fetch(`${API_URL}/localidade?${qs}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setResultado(d);
    } catch (e) { setErro(e.message); }
    finally { setLoading(false); }
  }

  function buildParams() {
    if (cidadesSel.length) return { cidade: cidadesSel.join(",") };
    if (estadosSel.length) return { estado: estadosSel.join(",") };
    if (busca.trim())      return { q: busca.trim() };
    return {};
  }

  function onEstados(ufs) {
    setEstadosSel(ufs); setCidadesSel([]); setBusca("");
    if (ufs.length) pesquisar({ estado: ufs.join(",") }); else setResultado(null);
  }

  function onCidades(cs) {
    setCidadesSel(cs);
    if (cs.length)          pesquisar({ cidade: cs.join(",") });
    else if (estadosSel.length) pesquisar({ estado: estadosSel.join(",") });
    else setResultado(null);
  }

  const cidadesFiltradas = estadosSel.length
    ? opcoes.cidades.filter(c => estadosSel.includes(c.estado_uf))
    : opcoes.cidades;

  const opcoesEstados = opcoes.estados.map(uf => ({ value: uf, label: `${UF_NOME[uf] || uf} (${uf})` }));
  const opcoesCidades = cidadesFiltradas.map(c => ({ value: c.cidade, label: c.cidade }));

  const totalParcelas = resultado?.reduce((s, a) => s + a.n_parcelas, 0) ?? 0;
  const totalConsumo  = resultado?.reduce((s, a) => s + a.consumo_medio_mwh, 0) ?? 0;
  const temFiltro     = estadosSel.length || cidadesSel.length || busca;

  return (
    <>
      <style jsx>{`
        .agente-link:hover { text-decoration: underline; }
        .row-card:hover { background: #f8fafc; }
        input:focus { border-color: #2563eb !important; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
      `}</style>

      {/* Filtros */}
      <div style={{ display: "flex", gap: 8, marginBottom: 24, alignItems: "center", flexWrap: "wrap" }}>
        <form onSubmit={e => { e.preventDefault(); setEstadosSel([]); setCidadesSel([]); pesquisar({ q: busca.trim() }); }}
              style={{ display: "flex", gap: 8, flex: 1, minWidth: 220 }}>
          <input
            value={busca}
            onChange={e => { setBusca(e.target.value); setEstadosSel([]); setCidadesSel([]); }}
            placeholder="Buscar por cidade, ramo de atividade..."
            style={s.input}
          />
          <button type="submit" style={s.btnPrimary} disabled={!busca.trim() || loading}>
            {loading ? "..." : "Buscar"}
          </button>
        </form>

        <MultiSelect
          options={opcoesEstados}
          value={estadosSel}
          onChange={onEstados}
          placeholder="Estado..."
          width={220}
        />

        {estadosSel.length > 0 && opcoesCidades.length > 0 && (
          <MultiSelect
            options={opcoesCidades}
            value={cidadesSel}
            onChange={onCidades}
            placeholder="Todas as cidades"
            width={220}
          />
        )}

        {temFiltro && (
          <button onClick={() => { setEstadosSel([]); setCidadesSel([]); setBusca(""); setResultado(null); }} style={s.btnClear}>
            Limpar
          </button>
        )}
      </div>

      {erro && <div style={s.errorBox}>⚠ {erro}</div>}
      {loading && <div style={s.emptyState}>Buscando...</div>}

      {resultado && !loading && (
        <>
          <div style={s.resumo}>
            <span><b>{resultado.length}</b> agente{resultado.length !== 1 ? "s" : ""}</span>
            <span style={s.sep}>·</span>
            <span><b>{totalParcelas.toLocaleString("pt-BR")}</b> parcelas</span>
            <span style={s.sep}>·</span>
            <span><b>{fmt(totalConsumo)}</b> MWh consumo médio/mês</span>
          </div>
          <TabelaAgentes agentes={resultado} mostrarDist={false} />
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
    </>
  );
}

// ─── GeoInput com autocomplete ────────────────────────────────────────────────

function GeoInput({ q, setQ, geo, setGeo, placeholder }) {
  const [sugestoes,  setSugestoes]  = useState([]);
  const [showDrop,   setShowDrop]   = useState(false);
  const [loadingAC,  setLoadingAC]  = useState(false);
  const debounceRef = useRef(null);
  const wrapRef     = useRef(null);

  useEffect(() => {
    function onOut(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setShowDrop(false); }
    document.addEventListener("mousedown", onOut);
    return () => document.removeEventListener("mousedown", onOut);
  }, []);

  function handleChange(v) {
    setQ(v); setGeo(null);
    clearTimeout(debounceRef.current);
    if (v.trim().length < 2) { setSugestoes([]); setShowDrop(false); return; }
    debounceRef.current = setTimeout(async () => {
      setLoadingAC(true);
      try {
        const r = await fetch(`${API_URL}/geocode?q=${encodeURIComponent(v)}`);
        const d = await r.json();
        if (!d.error && d.length) { setSugestoes(d); setShowDrop(true); }
        else { setSugestoes([]); }
      } catch {}
      finally { setLoadingAC(false); }
    }, 400);
  }

  function selecionar(item) {
    const label = item.nome.split(",").slice(0, 2).join(",").trim();
    setQ(label); setGeo(item); setSugestoes([]); setShowDrop(false);
  }

  async function confirmar() {
    if (!q.trim() || geo) return;
    setLoadingAC(true);
    try {
      const r = await fetch(`${API_URL}/geocode?q=${encodeURIComponent(q)}`);
      const d = await r.json();
      if (!d.error && d.length) selecionar(d[0]);
    } catch {}
    finally { setLoadingAC(false); }
  }

  const borderColor = geo ? "#16a34a" : q.trim() ? "#f59e0b" : "#e2e8f0";
  const bg          = geo ? "#f0fdf4" : "#fff";

  return (
    <div ref={wrapRef} style={{ position: "relative", flex: 1, minWidth: 200 }}>
      <form onSubmit={e => { e.preventDefault(); confirmar(); }} style={{ display: "flex", gap: 6 }}>
        <input
          value={q}
          onChange={e => handleChange(e.target.value)}
          onBlur={confirmar}
          placeholder={placeholder}
          style={{ ...s.input, flex: 1, borderColor, background: bg }}
          autoComplete="off"
        />
        <button type="submit" style={s.btnSm} disabled={loadingAC || !q.trim()}>
          {loadingAC ? "…" : geo ? "✓" : "↵"}
        </button>
      </form>

      {geo && (
        <p style={s.geoLabel}>✅ {q}</p>
      )}
      {!geo && q.trim() && !loadingAC && (
        <p style={{ ...s.geoLabel, color: "#f59e0b" }}>
          {showDrop ? "Selecione uma sugestão ou pressione ↵" : "Pressione ↵ para confirmar"}
        </p>
      )}

      {showDrop && sugestoes.length > 0 && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 300,
          background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.12)", overflow: "hidden",
        }}>
          {sugestoes.map((item, i) => {
            // Remove "Brasil" / "Brazil" do final antes de exibir
            const partes = item.nome.split(",").map(p => p.trim())
              .filter(p => !["Brasil", "Brazil"].includes(p));
            const titulo  = partes.slice(0, 1).join(", ");
            const detalhe = partes.slice(1, 3).join(", ");
            return (
              <button
                key={i}
                onMouseDown={() => selecionar(item)}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  padding: "9px 14px", fontSize: 13, border: "none",
                  background: "transparent", cursor: "pointer",
                  borderBottom: i < sugestoes.length - 1 ? "1px solid #f1f5f9" : "none",
                }}
              >
                <span style={{ color: "#1e293b", fontWeight: 500 }}>{titulo}</span>
                {detalhe && <span style={{ color: "#94a3b8", fontSize: 11, marginLeft: 6 }}>{detalhe}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Aba: Por Rota ────────────────────────────────────────────────────────────

function AbaRota() {
  const [origemQ,    setOrigemQ]    = useState("");
  const [destinoQ,   setDestinoQ]   = useState("");
  const [origemGeo,  setOrigemGeo]  = useState(null);
  const [destinoGeo, setDestinoGeo] = useState(null);
  const [raioKm,     setRaioKm]     = useState(30);
  const [minConsumo, setMinConsumo] = useState(0);
  const [maxConsumo, setMaxConsumo] = useState("");
  const [ramoQ,      setRamoQ]      = useState("");

  const [resultado,  setResultado]  = useState(null);
  const [rotaInfo,   setRotaInfo]   = useState(null);
  const [mapaDados,  setMapaDados]  = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [erro,       setErro]       = useState(null);
  const [removidos,  setRemovidos]  = useState(new Set());

  async function buscarRota() {
    setLoading(true); setErro(null); setResultado(null); setRotaInfo(null); setMapaDados(null); setRemovidos(new Set());
    try {
      const r = await fetch(`${API_URL}/localidade/rota`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          origemLat:  origemGeo.lat, origemLon:  origemGeo.lon,
          destinoLat: destinoGeo.lat, destinoLon: destinoGeo.lon,
          raioKm, minConsumoMwh: Number(minConsumo) || 0, ramo: ramoQ,
        }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setResultado(d.agentes);
      setRotaInfo({ distanciaKm: d.distanciaKm, duracaoMin: d.duracaoMin, cidadesNaRota: d.cidadesNaRota });
      setMapaDados({ rotaGeojson: d.rotaGeojson, cidadesMapa: d.cidadesMapa });
    } catch (e) { setErro(e.message); }
    finally { setLoading(false); }
  }

  function remover(agente) {
    setRemovidos(prev => new Set([...prev, agente]));
  }

  function restaurar(agente) {
    setRemovidos(prev => { const n = new Set(prev); n.delete(agente); return n; });
  }

  function exportarPDF() { window.print(); }

  // Aplica filtros client-side (removidos + faixa de consumo)
  const resultadoVis = resultado?.filter(a =>
    !removidos.has(a.agente) &&
    (!maxConsumo || a.consumo_medio_mwh <= Number(maxConsumo))
  ) ?? [];

  const totalConsumo  = resultadoVis.reduce((s, a) => s + a.consumo_medio_mwh, 0);
  const totalParcelas = resultadoVis.reduce((s, a) => s + a.n_parcelas, 0);
  const podeCalcular  = !!origemGeo && !!destinoGeo && !loading;
  const temResultado  = resultado && !loading && resultado.length > 0;

  return (
    <>
      <style jsx global>{`
        .agente-link:hover { text-decoration: underline; }
        .row-card:hover { background: #f8fafc; }
        input:focus { border-color: #2563eb !important; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
        @media print {
          body * { visibility: hidden; }
          #rota-print-area, #rota-print-area * { visibility: visible; }
          #rota-print-area {
            position: absolute; top: 0; left: 0; width: 100%; padding: 24px; background: #fff;
          }
          /* Remove scroll/clip para imprimir todas as linhas */
          #rota-print-area div {
            max-height: none !important;
            height: auto !important;
            overflow: visible !important;
          }
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          #rota-print-area table { width: 100%; border-collapse: collapse; font-size: 11px; }
          #rota-print-area th {
            background: #f1f5f9 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact;
            padding: 6px 8px; text-align: left; border-bottom: 2px solid #e2e8f0;
            font-size: 10px; text-transform: uppercase; position: static !important;
          }
          #rota-print-area td { padding: 6px 8px; border-bottom: 1px solid #f1f5f9; }
          #rota-print-area .print-header { margin-bottom: 16px; }
          #rota-print-area tr { page-break-inside: avoid; }
        }
      `}</style>

      {/* Painel de configuração */}
      <div className="no-print" style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <p style={s.labelSecao}>Rota</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={s.label}>Origem</label>
            <GeoInput q={origemQ} setQ={setOrigemQ} geo={origemGeo} setGeo={setOrigemGeo} placeholder="ex: Belo Horizonte MG" />
          </div>
          <div style={{ display: "flex", alignItems: "center", paddingTop: 20, color: "#94a3b8", fontSize: 20 }}>→</div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={s.label}>Destino</label>
            <GeoInput q={destinoQ} setQ={setDestinoQ} geo={destinoGeo} setGeo={setDestinoGeo} placeholder="ex: Uberlândia MG" />
          </div>
        </div>

        <p style={{ ...s.labelSecao, marginTop: 4 }}>Filtros</p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label style={s.label}>Raio da rota</label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="range" min={5} max={150} step={5} value={raioKm}
                onChange={e => setRaioKm(Number(e.target.value))}
                style={{ width: 120, accentColor: "#2563eb" }}
              />
              <span style={{ fontSize: 14, fontWeight: 700, color: "#2563eb", minWidth: 52 }}>{raioKm} km</span>
            </div>
          </div>
          <div>
            <label style={s.label}>Consumo (MWh/mês)</label>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="number" min={0} step={100} value={minConsumo}
                onChange={e => setMinConsumo(e.target.value)}
                placeholder="Mín"
                style={{ ...s.input, width: 90 }}
              />
              <span style={{ color: "#94a3b8", fontSize: 13 }}>—</span>
              <input type="number" min={0} step={100} value={maxConsumo}
                onChange={e => setMaxConsumo(e.target.value)}
                placeholder="Máx"
                style={{ ...s.input, width: 90 }}
              />
            </div>
          </div>
          <div>
            <label style={s.label}>Ramo de atividade</label>
            <input value={ramoQ} onChange={e => setRamoQ(e.target.value)}
              placeholder="ex: Metalurgia"
              style={{ ...s.input, width: 160 }}
            />
          </div>
          <button onClick={buscarRota} disabled={!podeCalcular}
            style={{ ...s.btnPrimary, ...(!podeCalcular ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
          >
            {loading ? "Calculando…" : "Buscar clientes na rota"}
          </button>
        </div>
      </div>

      {erro && <div className="no-print" style={s.errorBox}>⚠ {erro}</div>}

      {/* Mapa */}
      {mapaDados && (
        <div className="no-print" style={{ marginBottom: 16, borderRadius: 12, overflow: "hidden", border: "1px solid #e2e8f0" }}>
          <MapaRota rotaGeojson={mapaDados.rotaGeojson} cidadesMapa={mapaDados.cidadesMapa} origem={origemGeo} destino={destinoGeo} />
          <div style={{ padding: "8px 14px", background: "#f8fafc", fontSize: 11, color: "#94a3b8", display: "flex", gap: 16, flexWrap: "wrap" }}>
            <span><span style={{ color: "#2563eb" }}>━</span> Rota</span>
            <span><span style={{ color: "#16a34a", fontWeight: 700 }}>●</span> Origem</span>
            <span><span style={{ color: "#dc2626", fontWeight: 700 }}>●</span> Destino</span>
            <span><span style={{ color: "#f59e0b", fontWeight: 700 }}>●</span> Cidades com agentes</span>
            <span><span style={{ color: "#94a3b8", fontWeight: 700 }}>●</span> Sem agentes no filtro</span>
          </div>
        </div>
      )}

      {/* Área de resultados (também serve de print area) */}
      <div id="rota-print-area" style={{ display: temResultado ? "block" : "none" }}>

        {/* Cabeçalho visível só no PDF */}
        <div className="print-only" style={{ display: "none" }}>
          <div className="print-header">
            <h2 style={{ margin: "0 0 4px", fontSize: 18, color: "#1e293b" }}>Roteiro de Visitas</h2>
            <p style={{ margin: "0 0 2px", fontSize: 13, color: "#64748b" }}>
              {origemQ} → {destinoQ} · Raio {raioKm} km
            </p>
            {rotaInfo && (
              <p style={{ margin: "0 0 2px", fontSize: 12, color: "#94a3b8" }}>
                Distância: {rotaInfo.distanciaKm} km · Tempo estimado: {Math.floor(rotaInfo.duracaoMin / 60)}h{String(rotaInfo.duracaoMin % 60).padStart(2, "0")}min
              </p>
            )}
            <p style={{ margin: "0 0 12px", fontSize: 11, color: "#94a3b8" }}>
              Gerado em {new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })} · CCEE Monitor
            </p>
          </div>
        </div>

        {/* Barra de resumo + ações */}
        {rotaInfo && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 12, fontSize: 13, color: "#374151", flexWrap: "wrap", alignItems: "center" }}>
              <span>🛣 <b>{rotaInfo.distanciaKm} km</b></span>
              <span style={s.sep}>·</span>
              <span>⏱ <b>{Math.floor(rotaInfo.duracaoMin / 60)}h{String(rotaInfo.duracaoMin % 60).padStart(2, "0")}min</b></span>
              <span style={s.sep}>·</span>
              <span>📍 <b>{rotaInfo.cidadesNaRota}</b> cidades no raio</span>
              <span style={s.sep}>·</span>
              <span><b>{resultadoVis.length}</b> agentes</span>
              {removidos.size > 0 && <span style={{ color: "#94a3b8" }}>({removidos.size} removido{removidos.size > 1 ? "s" : ""})</span>}
              <span style={s.sep}>·</span>
              <span><b>{fmt(totalConsumo)}</b> MWh/mês</span>
              <span style={s.sep}>·</span>
              <span><b>{totalParcelas.toLocaleString("pt-BR")}</b> parcelas</span>
            </div>
            <div className="no-print" style={{ display: "flex", gap: 8 }}>
              {removidos.size > 0 && (
                <button onClick={() => setRemovidos(new Set())} style={s.btnClear}>
                  Restaurar {removidos.size} removido{removidos.size > 1 ? "s" : ""}
                </button>
              )}
              <button onClick={exportarPDF} style={{ ...s.btnClear, color: "#2563eb", borderColor: "#bfdbfe", background: "#eff6ff" }}>
                Exportar PDF
              </button>
            </div>
          </div>
        )}

        {resultadoVis.length === 0 && resultado?.length > 0 ? (
          <p style={{ color: "#94a3b8", padding: "24px 0", textAlign: "center" }}>
            Todos os agentes foram removidos ou filtrados. Use "Restaurar" ou ajuste o filtro de consumo máximo.
          </p>
        ) : (
          <TabelaAgentes agentes={resultadoVis} mostrarDist onRemover={remover} />
        )}
      </div>

      {resultado && !loading && resultado.length === 0 && (
        <p style={{ color: "#94a3b8", padding: "32px 0", textAlign: "center" }}>
          Nenhum agente no raio de {raioKm} km. Tente aumentar o raio ou reduzir o consumo mínimo.
        </p>
      )}

      {!resultado && !loading && !erro && (
        <div style={s.emptyState}>
          <p style={{ fontSize: 32, margin: "0 0 12px" }}>🗺</p>
          <p style={{ margin: 0, color: "#64748b" }}>
            Digite origem e destino — use as sugestões ou pressione ↵ para confirmar.
          </p>
        </div>
      )}
    </>
  );
}

// ─── Tabela compartilhada ─────────────────────────────────────────────────────

function TabelaAgentes({ agentes, mostrarDist, onRemover }) {
  return (
    <div style={s.tableWrap}>
      <table style={s.table}>
        <thead>
          <tr>
            {onRemover && <th style={{ ...s.th, width: 32 }} className="no-print" />}
            <th style={s.th}>Agente</th>
            <th style={s.th}>Razão Social</th>
            {mostrarDist && <th style={{ ...s.th, textAlign: "center" }}>Dist. rota</th>}
            <th style={{ ...s.th, textAlign: "center" }}>Parcelas</th>
            <th style={{ ...s.th, textAlign: "right" }}>Consumo médio/mês (MWh)</th>
            <th style={{ ...s.th, textAlign: "right" }}>Modulação média</th>
            <th style={s.th}>Localidades</th>
            <th style={s.th}>Último mês</th>
          </tr>
        </thead>
        <tbody>
          {agentes.map(a => (
            <tr key={a.agente} className="row-card" style={s.tr}>
              {onRemover && (
                <td style={{ ...s.td, padding: "0 4px 0 10px" }} className="no-print">
                  <button
                    onClick={() => onRemover(a.agente)}
                    title="Remover da lista"
                    style={{
                      border: "none", background: "none", cursor: "pointer",
                      color: "#cbd5e1", fontSize: 16, lineHeight: 1, padding: "2px 4px",
                      borderRadius: 4, transition: "color 0.15s",
                    }}
                    onMouseEnter={e => e.target.style.color = "#ef4444"}
                    onMouseLeave={e => e.target.style.color = "#cbd5e1"}
                  >×</button>
                </td>
              )}
              <td style={s.td}>
                <Link href={`/inteligencia/${encodeURIComponent(a.agente)}`} style={s.agenteLink} className="agente-link">
                  {a.sigla || a.agente}
                </Link>
              </td>
              <td style={{ ...s.td, color: "#64748b", fontSize: 12 }}>{a.razao_social || "—"}</td>
              {mostrarDist && (
                <td style={{ ...s.td, textAlign: "center", fontSize: 12, color: "#64748b" }}>
                  {a.dist_km != null ? `${a.dist_km.toFixed(0)} km` : "—"}
                </td>
              )}
              <td style={{ ...s.td, textAlign: "center", fontWeight: 600 }}>{a.n_parcelas}</td>
              <td style={{ ...s.td, textAlign: "right", fontWeight: 700, color: "#2563eb" }}>
                {fmt(a.consumo_medio_mwh)}
                <span style={{ fontSize: 10, fontWeight: 400, color: "#94a3b8", marginLeft: 2 }}>MWh</span>
              </td>
              <td style={{ ...s.td, textAlign: "right" }}>
                {a.media_custo_mod != null ? (
                  <span style={{ fontWeight: 700, color: a.media_custo_mod >= 0 ? "#16a34a" : "#ea580c" }}>
                    {a.media_custo_mod >= 0 ? "+" : ""}{fmt(a.media_custo_mod)}
                    <span style={{ fontSize: 10, fontWeight: 400, color: "#94a3b8", marginLeft: 2 }}>R$/MWh</span>
                  </span>
                ) : <span style={{ color: "#94a3b8" }}>—</span>}
              </td>
              <td style={s.td}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {[...new Map(a.localidades.map(l => [`${l.estado_uf}|${l.cidade}`, l])).values()].slice(0, 5).map(l => (
                    <span key={`${l.estado_uf}|${l.cidade}`} style={s.tag} title={l.ramo}>
                      {l.cidade ? `${l.cidade} (${l.estado_uf})` : l.estado_uf}
                    </span>
                  ))}
                  {new Set(a.localidades.map(l => `${l.estado_uf}|${l.cidade}`)).size > 5 && (
                    <span style={{ ...s.tag, background: "#e2e8f0", color: "#64748b" }}>
                      +{new Set(a.localidades.map(l => `${l.estado_uf}|${l.cidade}`)).size - 5}
                    </span>
                  )}
                </div>
              </td>
              <td style={{ ...s.td, color: "#64748b", fontSize: 12 }}>{a.localidades[0]?.ultimo_mes || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Página principal ─────────────────────────────────────────────────────────

export default function Localidade() {
  const [aba,    setAba]    = useState("local");
  const [opcoes, setOpcoes] = useState({ estados: [], cidades: [] });

  useEffect(() => {
    fetch(`${API_URL}/localidade/opcoes`)
      .then(r => r.json())
      .then(d => { if (!d.error) setOpcoes(d); })
      .catch(() => {});
  }, []);

  return (
    <div style={s.page}>
      <style jsx global>{`
        @media (max-width: 768px) {
          .nav-inner { padding: 0 16px !important; }
          .inner     { padding: 24px 16px !important; }
        }
      `}</style>

      <nav style={s.nav}>
        <div className="nav-inner" style={s.navInner}>
          <Link href="/" style={s.navBack}>← Início</Link>
          <span style={s.logo}>⚡ CCEE Monitor</span>
          <span />
        </div>
      </nav>

      <div className="inner" style={s.inner}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={s.titulo}>Cargas por Localidade</h1>
          <p style={s.subtitulo}>Encontre agentes pelo estado, cidade ou ao longo de uma rota de prospecção</p>
        </div>

        {/* Abas */}
        <div style={s.tabs}>
          <button onClick={() => setAba("local")} style={{ ...s.tab, ...(aba === "local" ? s.tabAtivo : {}) }}>
            📍 Por localidade
          </button>
          <button onClick={() => setAba("rota")} style={{ ...s.tab, ...(aba === "rota" ? s.tabAtivo : {}) }}>
            🗺 Por rota
          </button>
        </div>

        {aba === "local" ? <AbaLocalidade opcoes={opcoes} /> : <AbaRota />}
      </div>
    </div>
  );
}

// ─── Estilos ──────────────────────────────────────────────────────────────────

const s = {
  page:      { minHeight: "100vh", background: "#f8fafc", fontFamily: "system-ui, sans-serif" },
  nav:       { background: "#fff", borderBottom: "1px solid #e2e8f0", position: "sticky", top: 0, zIndex: 10 },
  navInner:  { maxWidth: 1200, margin: "0 auto", padding: "0 24px", height: 52, display: "flex", alignItems: "center", justifyContent: "space-between" },
  navBack:   { fontSize: 13, color: "#2563eb", textDecoration: "none", fontWeight: 500 },
  logo:      { fontSize: 15, fontWeight: 700, color: "#1e293b" },
  inner:     { maxWidth: 1200, margin: "0 auto", padding: "32px 24px" },
  titulo:    { fontSize: 26, fontWeight: 800, color: "#1e293b", margin: "0 0 6px" },
  subtitulo: { fontSize: 14, color: "#64748b", margin: 0 },

  tabs:    { display: "flex", gap: 4, marginBottom: 20, borderBottom: "2px solid #e2e8f0", paddingBottom: 0 },
  tab:     { padding: "8px 18px", fontSize: 13, fontWeight: 600, border: "none", background: "transparent", cursor: "pointer", color: "#64748b", borderBottom: "2px solid transparent", marginBottom: -2, borderRadius: "6px 6px 0 0", transition: "all 0.15s" },
  tabAtivo:{ color: "#2563eb", borderBottomColor: "#2563eb", background: "#eff6ff" },

  input: {
    padding: "10px 14px", fontSize: 14, border: "1px solid #e2e8f0",
    borderRadius: 8, outline: "none", background: "#fff", color: "#1e293b",
    transition: "border-color 0.15s, box-shadow 0.15s", width: "100%", boxSizing: "border-box",
  },
  select: {
    padding: "10px 14px", fontSize: 14, border: "1px solid #e2e8f0",
    borderRadius: 8, outline: "none", background: "#fff", color: "#1e293b",
    cursor: "pointer", minWidth: 180,
  },
  btnPrimary: {
    padding: "10px 18px", background: "#2563eb", color: "#fff",
    border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600,
    cursor: "pointer", whiteSpace: "nowrap",
  },
  btnClear: {
    padding: "10px 14px", background: "transparent", color: "#64748b",
    border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13,
    cursor: "pointer", whiteSpace: "nowrap", fontWeight: 500,
  },
  btnSm: {
    padding: "10px 14px", background: "#f1f5f9", color: "#374151",
    border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13,
    cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap",
  },

  labelSecao: { fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 8, marginTop: 0, textTransform: "uppercase", letterSpacing: "0.06em" },
  label:      { display: "block", fontSize: 11, fontWeight: 600, color: "#64748b", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" },
  geoLabel:   { fontSize: 11, color: "#16a34a", margin: "4px 0 0", fontWeight: 500 },

  resumo: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 13, color: "#374151", flexWrap: "wrap" },
  sep:    { color: "#cbd5e1" },

  tableWrap: {
    background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0",
    maxHeight: 560, overflowY: "auto", overflowX: "auto",
  },
  table:     { width: "100%", borderCollapse: "collapse" },
  th: {
    padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "#64748b",
    textTransform: "uppercase", letterSpacing: "0.04em",
    background: "#f8fafc", borderBottom: "1px solid #e2e8f0", textAlign: "left",
    position: "sticky", top: 0, zIndex: 1,
  },
  tr:        { borderBottom: "1px solid #f1f5f9", transition: "background 0.1s" },
  td:        { padding: "10px 14px", fontSize: 13, color: "#1e293b", verticalAlign: "middle" },
  agenteLink: { color: "#2563eb", fontWeight: 700, textDecoration: "none", fontSize: 13 },
  tag:        { fontSize: 11, padding: "2px 7px", background: "#eff6ff", color: "#2563eb", borderRadius: 4, fontWeight: 500, whiteSpace: "nowrap" },

  errorBox:   { background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 16px", color: "#dc2626", fontSize: 13, marginBottom: 16 },
  emptyState: { textAlign: "center", padding: "64px 0", color: "#94a3b8" },
};
