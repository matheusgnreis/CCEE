"""
buscar_dados.py
===============
Busca dados de agentes CCEE diretamente do Power BI e salva em CSV.
Não depende de nenhum servidor intermediário.

Uso:
    python buscar_dados.py
    python buscar_dados.py --agentes minha_lista.txt
    python buscar_dados.py --mes 2026-03
    python buscar_dados.py --modo a          # acumula sem sobrescrever
"""

import argparse
import calendar
import csv
import json
import math
import time
import urllib.request
import urllib.error
from datetime import date, datetime
from pathlib import Path

# ─── Credenciais Power BI (CCEE) ──────────────────────────────────────────────

POWERBI_RESOURCE_KEY = "f6267020-1b73-4885-8920-19a9d09f1395"
POWERBI_MODEL_ID     = 7427061
POWERBI_URL          = (
    "https://wabi-brazil-south-b-primary-api.analysis.windows.net"
    "/public/reports/querydata?synchronous=true"
)

# ─── Configuração geral ────────────────────────────────────────────────────────

OUTPUT_DIR = Path("csv_export")
DELAY_S    = 1.5   # pausa entre agentes
TIMEOUT_S  = 20

# ─── Helpers de data ──────────────────────────────────────────────────────────

def mes_referencia() -> str:
    """Estima o mês de referência (igual à lógica Node.js)."""
    hoje  = date.today()
    offset = 3 if hoje.day <= 5 else 2
    ano, mes = hoje.year, hoje.month - offset
    if mes <= 0:
        mes += 12
        ano -= 1
    return f"{ano:04d}-{mes:02d}"

def filtro_mes_ano(mes: str) -> str:
    """Converte YYYY-MM → '(mais recente)' ou 'YYYY/MM' para filtro Power BI."""
    if mes == mes_referencia():
        return "'(mais recente)'"
    return f"'{mes.replace('-', '/')}'"

def horas_do_mes(mes: str) -> int:
    ano, m = int(mes[:4]), int(mes[5:7])
    return calendar.monthrange(ano, m)[1] * 24

def ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

# ─── Power BI — queries ────────────────────────────────────────────────────────

def _q_filtro_mes(agente: str, mes: str, usar_mais_recente: bool) -> dict:
    filtro_val = "'(mais recente)'" if usar_mais_recente else filtro_mes_ano(mes)
    return {
        "Query": {"Commands": [{"SemanticQueryDataShapeCommand": {"Query": {
            "Version": 2,
            "From": [
                {"Name": "s", "Entity": "SEGURANCA_MERCADO", "Type": 0},
                {"Name": "t", "Entity": "TabelaBusca",       "Type": 0},
                {"Name": "c", "Entity": "CALENDARIO",        "Type": 0},
            ],
            "Select": [
                {"Column":      {"Expression": {"SourceRef": {"Source": "s"}}, "Property": "DS_ACR"}},
                {"Aggregation": {"Expression": {"Column": {"Expression": {"SourceRef": {"Source": "s"}},
                                 "Property": "VL_ACR"}}, "Function": 0}},
            ],
            "Where": [
                {"Condition": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "t"}},
                    "Property": "Valor"}}], "Values": [[{"Literal": {"Value": f"'{agente}'"}}]]}}},
                {"Condition": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "t"}},
                    "Property": "Tipo"}}], "Values": [[{"Literal": {"Value": "'Agente'"}}]]}}},
                {"Condition": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "c"}},
                    "Property": "FiltroMesAno"}}], "Values": [[{"Literal": {"Value": filtro_val}}]]}}},
            ],
        }}}]}
    }

def _q_serie(agente: str, medida_a: str, medida_b: str, proj: list, suppress: list) -> dict:
    """Query histórica genérica (Queries 1, 3, 4)."""
    selects = [
        {"Column":      {"Expression": {"SourceRef": {"Source": "c"}}, "Property": "ANO"}},
        {"Column":      {"Expression": {"SourceRef": {"Source": "c"}}, "Property": "MES_NOME"}},
        {"Aggregation": {"Expression": {"Column": {"Expression": {"SourceRef": {"Source": "c"}},
                         "Property": "MES_ANO_FORMATADO"}}, "Function": 3}},
        {"Measure":     {"Expression": {"SourceRef": {"Source": "m"}}, "Property": medida_a}},
        {"Measure":     {"Expression": {"SourceRef": {"Source": "m"}}, "Property": medida_b}},
    ]
    return {
        "Query": {"Commands": [{"SemanticQueryDataShapeCommand": {
            "Query": {
                "Version": 2,
                "From": [
                    {"Name": "c", "Entity": "CALENDARIO",         "Type": 0},
                    {"Name": "m", "Entity": "MEDIDAS_CALCULADAS", "Type": 0},
                    {"Name": "t", "Entity": "TabelaBusca",        "Type": 0},
                ],
                "Select": selects,
                "Where": [
                    {"Condition": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "t"}},
                        "Property": "Tipo"}}], "Values": [[{"Literal": {"Value": "'Agente'"}}]]}}},
                    {"Condition": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "t"}},
                        "Property": "Valor"}}], "Values": [[{"Literal": {"Value": f"'{agente}'"}}]]}}},
                    {"Condition": {"Between": {
                        "Expression": {"Column": {"Expression": {"SourceRef": {"Source": "c"}}, "Property": "DATA"}},
                        "LowerBound": {"DateSpan": {"Expression": {"DateAdd": {"Expression": {"DateAdd": {
                            "Expression": {"Now": {}}, "Amount": 1, "TimeUnit": 0}},
                            "Amount": -2, "TimeUnit": 3}}, "TimeUnit": 0}},
                        "UpperBound": {"DateSpan": {"Expression": {"Now": {}}, "TimeUnit": 0}},
                    }}},
                ],
                "OrderBy": [{"Direction": 1, "Expression": {"Aggregation": {"Expression": {"Column": {
                    "Expression": {"SourceRef": {"Source": "c"}},
                    "Property": "MES_ANO_FORMATADO"}}, "Function": 3}}}],
            },
            "Binding": {
                "Primary": {"Groupings": [{"Projections": proj}]},
                "DataReduction": {"DataVolume": 4, "Primary": {"Window": {"Count": 1000}}},
                "SuppressedJoinPredicates": suppress,
                "Version": 1,
            },
        }}]},
    }

def _q_metadados(agente: str) -> dict:
    return {
        "Query": {"Commands": [{"SemanticQueryDataShapeCommand": {
            "Query": {
                "Version": 2,
                "From": [
                    {"Name": "s", "Entity": "SEGURANCA_MERCADO",  "Type": 0},
                    {"Name": "m", "Entity": "MEDIDAS_CALCULADAS", "Type": 0},
                    {"Name": "t", "Entity": "TabelaBusca",        "Type": 0},
                    {"Name": "c", "Entity": "CALENDARIO",         "Type": 0},
                ],
                "Select": [
                    {"Column":  {"Expression": {"SourceRef": {"Source": "s"}}, "Property": "NM_CSSE"}},
                    {"Column":  {"Expression": {"SourceRef": {"Source": "s"}}, "Property": "NM_RZOA_SOCI"}},
                    {"Column":  {"Expression": {"SourceRef": {"Source": "s"}}, "Property": "SG_AGEN"}},
                    {"Column":  {"Expression": {"SourceRef": {"Source": "s"}}, "Property": "CNPJ_Formatado"}},
                    {"Column":  {"Expression": {"SourceRef": {"Source": "s"}}, "Property": "DS_STAT_AGEN"}},
                    {"Measure": {"Expression": {"SourceRef": {"Source": "m"}}, "Property": "Capital Social"}},
                ],
                "Where": [
                    {"Condition": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "t"}},
                        "Property": "Tipo"}}], "Values": [[{"Literal": {"Value": "'Agente'"}}]]}}},
                    {"Condition": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "c"}},
                        "Property": "FiltroMesAno"}}], "Values": [[{"Literal": {"Value": "'(mais recente)'"}}]]}}},
                    {"Condition": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "t"}},
                        "Property": "Valor"}}], "Values": [[{"Literal": {"Value": f"'{agente}'"}}]]}}},
                ],
            },
            "Binding": {
                "Primary": {"Groupings": [{"Projections": [0, 1, 2, 3, 4, 5]}]},
                "DataReduction": {"DataVolume": 3, "Primary": {"Window": {"Count": 500}}},
                "Version": 1,
            },
        }}]},
    }

def montar_body(agente: str, mes: str, usar_mais_recente: bool) -> dict:
    return {
        "version":  "1.0.0",
        "modelId":  POWERBI_MODEL_ID,
        "queries":  [
            _q_filtro_mes(agente, mes, usar_mais_recente),                           # Q0 financeiro
            _q_serie(agente, "Balanco_Energetico", "MCP",      [0,1,2,3,4], [2]),   # Q1 balanço+MCP
            _q_metadados(agente),                                                     # Q2 metadados
            _q_serie(agente, "Recurso",            "Requisito", [0,1,2,3,4], [2]),   # Q3 compra+consumo
            _q_serie(agente, "Montante Gerado",    "Compra",    [0,1,2,3,4,5,6], [2,5,6]),  # Q4 geração
        ],
        "cancelQueries": [],
    }

# ─── Power BI — chamada HTTP ───────────────────────────────────────────────────

def chamar_powerbi(body: dict) -> dict:
    data = json.dumps(body).encode()
    req  = urllib.request.Request(
        POWERBI_URL,
        data=data,
        headers={
            "Content-Type":       "application/json",
            "X-PowerBI-ResourceKey": POWERBI_RESOURCE_KEY,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return json.loads(r.read().decode())

# ─── Power BI — parsing DSR ───────────────────────────────────────────────────

def _resultado_por_job(json_resp: dict) -> dict:
    job_ids = json_resp.get("jobIds", [])
    results = json_resp.get("results", [])
    por_id  = {r["jobId"]: r for r in results}
    return {i: por_id.get(jid) for i, jid in enumerate(job_ids)}

def extrair_financeiro(result) -> dict:
    """Q0: PH[1].DM1 → map {DS_ACR: VL_ACR}"""
    dsr = result and result.get("result", {}).get("data", {}).get("dsr", {})
    dm  = dsr.get("DS", [{}])[0].get("PH", [None, {}])[1].get("DM1") if dsr else None
    if not dm:
        return {}
    mp = {}
    for x in dm:
        c = x.get("C", [])
        if len(c) >= 2:
            mp[c[0]] = c[1]
    return mp

def extrair_serie_dsr(result, campo_a: str, campo_b: str) -> list[dict]:
    """Q1/Q3: PH[0].DM0 com bitmask Ø/R → lista de {mes, campo_a, campo_b}"""
    dsr  = result and result.get("result", {}).get("data", {}).get("dsr", {})
    ds   = dsr.get("DS", [{}])[0] if dsr else {}
    dm   = ds.get("PH", [{}])[0].get("DM0")
    if not dm:
        return []
    meses = ds.get("ValueDicts", {}).get("D1", [])
    N     = 5
    prev  = [None] * N
    rows  = []
    for item in dm:
        C    = item.get("C", [])
        full = [None] * N
        ci   = 0
        if "Ø" in item:
            mask = item["Ø"]
            for i in range(N):
                full[i] = None if (mask & (1 << i)) else (C[ci] if ci < len(C) else None)
                if not (mask & (1 << i)):
                    ci += 1
        else:
            mask = item.get("R", 0)
            for i in range(N):
                full[i] = prev[i] if (mask & (1 << i)) else (C[ci] if ci < len(C) else None)
                if not (mask & (1 << i)):
                    ci += 1
        prev = full
        mes_val = meses[full[2]] if isinstance(full[2], int) and full[2] < len(meses) else full[2]
        if not isinstance(mes_val, str):
            continue
        mes = mes_val.replace("/", "-")
        if len(mes) != 7:
            continue
        va = float(full[3]) if full[3] is not None else 0.0
        vb = float(full[4]) if full[4] is not None else 0.0
        rows.append({"mes": mes, campo_a: va, campo_b: vb})
    return rows

def extrair_metadados(result) -> dict:
    """Q2: PH[0].DM0 primeira linha → metadados do agente"""
    dsr   = result and result.get("result", {}).get("data", {}).get("dsr", {})
    ds    = dsr.get("DS", [{}])[0] if dsr else {}
    dm    = ds.get("PH", [{}])[0].get("DM0")
    dicts = ds.get("ValueDicts", {})
    if not dm:
        return {}
    row = dm[0]
    C   = row.get("C", [])
    def d(key, idx):
        if isinstance(idx, str):
            return idx
        lst = dicts.get(key, [])
        return lst[idx] if isinstance(idx, int) and idx < len(lst) else None
    return {
        "classe":        d("D0", C[0]) if len(C) > 0 else None,
        "razao_social":  d("D1", C[1]) if len(C) > 1 else None,
        "sigla":         d("D2", C[2]) if len(C) > 2 else None,
        "cnpj":          d("D3", C[3]) if len(C) > 3 else None,
        "situacao":      d("D4", C[4]) if len(C) > 4 else None,
        "capital_social": float(C[5]) if len(C) > 5 and C[5] is not None else 0,
    }

# ─── Cálculos ─────────────────────────────────────────────────────────────────

def calc_mcp_rs_mwh(mcp, consumo, balanco, mes) -> float | None:
    if not mcp or not mes:
        return None
    divisor = consumo if (consumo and consumo > 0) else (balanco if balanco and balanco != 0 else None)
    if not divisor:
        return None
    h = horas_do_mes(mes)
    return round(mcp / (divisor * h), 4)

# ─── Busca principal por agente ───────────────────────────────────────────────

def buscar_agente(agente: str, mes: str | None) -> dict:
    """
    Retorna:
        {"status": "ok", "historico": [...], "mes": "YYYY-MM", "meta": {...}}
        {"status": "nao_encontrado", "motivo": "..."}
        {"status": "erro", "motivo": "..."}
    """
    mes_alvo          = mes or mes_referencia()
    usar_mais_recente = mes is None

    try:
        body = montar_body(agente, mes_alvo, usar_mais_recente)
        resp = chamar_powerbi(body)
    except urllib.error.HTTPError as e:
        return {"status": "erro", "motivo": f"HTTP {e.code}"}
    except Exception as e:
        return {"status": "erro", "motivo": str(e)}

    por_idx = _resultado_por_job(resp)

    # Metadados
    meta = extrair_metadados(por_idx.get(2))

    # Financeiro do mês (Q0)
    fin_map = extrair_financeiro(por_idx.get(0))
    if not fin_map:
        return {"status": "nao_encontrado", "motivo": "sem dados financeiros no Power BI"}

    # Séries históricas
    serie_bal_mcp  = extrair_serie_dsr(por_idx.get(1), "balanco_energetico", "mcp")
    serie_rec_req  = extrair_serie_dsr(por_idx.get(3), "compra",             "consumo")
    serie_ger      = extrair_serie_dsr(por_idx.get(4), "geracao",            "_compra2")

    # Merge histórico
    hist_map: dict[str, dict] = {}
    for s in (serie_bal_mcp, serie_rec_req, serie_ger):
        for r in s:
            m = r["mes"]
            if m not in hist_map:
                hist_map[m] = {"mes": m}
            hist_map[m].update({k: v for k, v in r.items() if k != "mes" and not k.startswith("_")})

    # Mês efetivo = último do histórico ou mes_alvo
    mes_efetivo = sorted(hist_map.keys())[-1] if hist_map else mes_alvo

    # Dados do mês atual (do Q0)
    dados_mes = {
        "consumo":            float(fin_map.get("Consumo", 0) or 0),
        "compra":             float(fin_map.get("Compra",  0) or 0),
        "mcp":                float(fin_map.get("MCP",     0) or 0),
        "resultado":          float(fin_map.get("Resultado com Ajustes", 0) or 0),
        "resultado_mcp":      float(fin_map.get("Resultado do MCP", 0) or 0),
        "balanco_energetico": float(fin_map.get("Balanço Energético", 0) or 0),
        "geracao":            fin_map.get("Geração"),
        "venda":              fin_map.get("Venda"),
        "consumo_geracao":    fin_map.get("Cons.da Ger."),
        "mre_mais":           fin_map.get("MRE +"),
        "mre_menos":          fin_map.get("MRE -"),
    }

    # Garante que o mês atual está no histórico com dados completos
    if mes_efetivo not in hist_map:
        hist_map[mes_efetivo] = {"mes": mes_efetivo}
    hist_map[mes_efetivo].update({k: v for k, v in dados_mes.items() if v is not None})

    # Adiciona mcp_rs_mwh e metadados em cada linha do histórico
    historico = []
    for m, row in sorted(hist_map.items()):
        mcp_v    = row.get("mcp")
        cons_v   = row.get("consumo")
        bal_v    = row.get("balanco_energetico")
        rs_mwh   = calc_mcp_rs_mwh(mcp_v, cons_v, bal_v, m)
        historico.append({
            "agente":             agente,
            "mes":                m,
            "consumo":            row.get("consumo"),
            "compra":             row.get("compra"),
            "mcp":                row.get("mcp"),
            "resultado":          row.get("resultado"),
            "resultado_mcp":      row.get("resultado_mcp"),
            "balanco_energetico": row.get("balanco_energetico"),
            "geracao":            row.get("geracao"),
            "venda":              row.get("venda"),
            "consumo_geracao":    row.get("consumo_geracao"),
            "mcp_rs_mwh":         rs_mwh,
            "mre_mais":           row.get("mre_mais"),
            "mre_menos":          row.get("mre_menos"),
            **{k: meta.get(k) for k in ("razao_social", "sigla", "cnpj", "classe", "situacao", "capital_social")},
        })

    return {"status": "ok", "historico": historico, "mes": mes_efetivo, "meta": meta}

# ─── CSV ──────────────────────────────────────────────────────────────────────

CAMPOS_DADOS = [
    "agente", "mes", "consumo", "compra", "mcp", "resultado", "resultado_mcp",
    "balanco_energetico", "geracao", "venda", "consumo_geracao",
    "mcp_rs_mwh", "mre_mais", "mre_menos",
    "razao_social", "sigla", "cnpj", "classe", "situacao", "capital_social",
]
CAMPOS_NAO_ENCONTRADOS = ["agente", "motivo", "timestamp"]
CAMPOS_CONSUMO_H = ["agente", "mes_referencia", "periodo", "submercado", "consumo_mwh"]
CAMPOS_GERACAO_H = ["agente", "mes_referencia", "sigla_usina", "periodo", "submercado", "geracao_mwmed"]

def salvar_csv(caminho: Path, linhas: list[dict], campos: list[str], modo: str = "w"):
    if not linhas:
        return
    caminho.parent.mkdir(parents=True, exist_ok=True)
    escrever_header = modo == "w" or not caminho.exists()
    with open(caminho, modo, newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=campos, delimiter=";", extrasaction="ignore")
        if escrever_header:
            w.writeheader()
        w.writerows(linhas)

def ler_agentes(caminho: str) -> list[str]:
    agentes = []
    with open(caminho, encoding="utf-8") as f:
        for linha in f:
            l = linha.strip()
            if l and not l.startswith("#"):
                agentes.append(l)
    return agentes

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Exporta dados CCEE para CSV (Power BI + CKAN direto)")
    parser.add_argument("--agentes",  default="agentes.txt")
    parser.add_argument("--mes",      default=None,  help="Mês específico YYYY-MM (padrão: mais recente)")
    parser.add_argument("--modo",     default="w",   choices=["w", "a"])
    parser.add_argument("--horario",  action="store_true",
                        help="Baixa consumo horário e geração horária (arquivos grandes ~400MB)")
    parser.add_argument("--sem-ckan", action="store_true",
                        help="Pula cargas, usinas e contabilização (só Power BI)")
    args = parser.parse_args()

    from ckan import (
        buscar_cargas, buscar_usinas, buscar_contabilizacao,
        buscar_consumo_horario, buscar_geracao_horaria,
        buscar_pld_mapa, calcular_modulacao,
        buscar_desligamento,
        remover_acentos,
    )

    agentes = ler_agentes(args.agentes)
    print(f"[{ts()}] {len(agentes)} agente(s) | mês: {args.mes or 'mais recente'}")
    print(f"[{ts()}] CKAN: {'NÃO' if args.sem_ckan else 'SIM'} | Horário: {'SIM' if args.horario else 'NÃO (use --horario)'}\n")

    todos_dados        = []
    todas_cargas       = []
    todas_usinas       = []
    toda_contab        = []
    todo_desligamento  = []
    nao_encontrados    = []
    erros            = []

    # Coleta metadados de cada agente (para usar nos downloads horários)
    metas: dict[str, dict] = {}  # agente → meta

    # ── 1. Power BI + CKAN paginado por agente ────────────────────────────────
    for i, agente in enumerate(agentes, 1):
        print(f"\n[{i:>3}/{len(agentes)}] {'─'*50}")
        print(f"  Power BI: {agente}... ", end="", flush=True)
        r = buscar_agente(agente, args.mes)

        if r["status"] != "ok":
            motivo = r["motivo"]
            bucket = nao_encontrados if r["status"] == "nao_encontrado" else erros
            bucket.append({"agente": agente, "motivo": motivo, "timestamp": ts()})
            print(f"{'⚠' if r['status'] == 'nao_encontrado' else '❌'}  {motivo}")
            continue

        todos_dados.extend(r["historico"])
        meta  = r["meta"]
        metas[agente] = meta
        razao = meta.get("razao_social") or ""
        classe = meta.get("classe", "")
        print(f"✅  {len(r['historico'])} meses | mês={r['mes']} | {classe}")

        if not args.sem_ckan:
            # Cargas
            try:
                cargas = buscar_cargas(razao or None, agente)
                for c in cargas:
                    c["agente"] = agente
                todas_cargas.extend(cargas)
            except Exception as e:
                print(f"  ⚠ Cargas: {e}")

            # Usinas (só para quem tem geração)
            if razao:
                try:
                    usinas = buscar_usinas(razao)
                    for u in usinas:
                        u["agente"] = agente
                    todas_usinas.extend(usinas)
                except Exception as e:
                    print(f"  ⚠ Usinas: {e}")

            # Contabilização
            if razao:
                try:
                    contab = buscar_contabilizacao(razao)
                    for c in contab:
                        c["agente"] = agente
                    toda_contab.extend(contab)
                except Exception as e:
                    print(f"  ⚠ Contabilização: {e}")

            # Desligamento por descumprimento
            cnpj_ag = r.get("cnpj") if r["status"] == "ok" else None
            sigla_ag = r.get("meta", {}).get("sigla") if r["status"] == "ok" else None
            try:
                deslig = buscar_desligamento(cnpj_ag, sigla_ag or agente)
                if deslig:
                    todo_desligamento.append({"agente": agente, **deslig})
                    print(f"  ⚠ Desligamento: {deslig['status']}")
            except Exception as e:
                print(f"  ⚠ Desligamento: {e}")

        if i < len(agentes):
            time.sleep(DELAY_S)

    # ── 2. Downloads horários (um arquivo por mês, filtra todos os agentes) ───
    if args.horario and metas:
        # Descobre todos os meses presentes nos dados
        meses_unicos = sorted({r["mes"] for r in todos_dados})

        # Prepara filtros de consumo: {sigla: razao_social_norm}
        filtro_consumo = {
            ag: remover_acentos((m.get("razao_social") or "").strip().upper())
            for ag, m in metas.items()
        }

        # Prepara filtros de geração: {agente: [sigla_usinas]}
        filtro_geracao: dict[str, list[str]] = {}
        for u in todas_usinas:
            ag = u.get("agente", "")
            su = (u.get("sigla_parcela_usina") or u.get("sigla_ativo") or "").strip().upper()
            if ag and su:
                filtro_geracao.setdefault(ag, []).append(su)

        todos_consumo_h  = []
        toda_geracao_h   = []

        print(f"\n[{ts()}] Downloads horários — {len(meses_unicos)} mês(es)\n")
        for mes in meses_unicos:
            print(f"── {mes} ──")
            try:
                res_consumo = buscar_consumo_horario(mes, filtro_consumo)
                for rows in res_consumo.values():
                    todos_consumo_h.extend(rows)
            except Exception as e:
                print(f"  ⚠ Consumo horário {mes}: {e}")

            if filtro_geracao:
                try:
                    res_geracao = buscar_geracao_horaria(mes, filtro_geracao)
                    for rows in res_geracao.values():
                        toda_geracao_h.extend(rows)
                except Exception as e:
                    print(f"  ⚠ Geração horária {mes}: {e}")

        if todos_consumo_h:
            p = OUTPUT_DIR / "ccee_consumo_horario.csv"
            salvar_csv(p, todos_consumo_h, CAMPOS_CONSUMO_H, args.modo)
            print(f"  ccee_consumo_horario.csv  → {len(todos_consumo_h):,} linhas")

            # Calcula modulação por mês (PLD + consumo)
            toda_modulacao_h = []
            print(f"\n[{ts()}] Calculando modulação horária...")
            for mes in meses_unicos:
                try:
                    pld = buscar_pld_mapa(mes)
                    consumo_mes = [r for r in todos_consumo_h if r["mes_referencia"] == mes]
                    if consumo_mes and pld:
                        resultados_mod = calcular_modulacao(consumo_mes, pld)
                        toda_modulacao_h.extend(resultados_mod)
                        for r in resultados_mod:
                            print(f"    {mes} {r['agente']} {r['submercado']}: "
                                  f"{r['consumo_total_mwh']} MWh | {r['custo_modulacao_rs_mwh']} R$/MWh")
                except Exception as e:
                    print(f"    ⚠ Modulação {mes}: {e}")

            if toda_modulacao_h:
                campos_mod = ["agente", "mes_referencia", "submercado", "consumo_total_mwh",
                              "n_horas", "soma_curva_rs", "soma_flat_rs", "custo_modulacao_rs_mwh"]
                p = OUTPUT_DIR / "ccee_modulacao.csv"
                salvar_csv(p, toda_modulacao_h, campos_mod, args.modo)
                print(f"  ccee_modulacao.csv        → {len(toda_modulacao_h)} linhas")

        if toda_geracao_h:
            p = OUTPUT_DIR / "ccee_geracao_horaria.csv"
            salvar_csv(p, toda_geracao_h, CAMPOS_GERACAO_H, args.modo)
            print(f"  ccee_geracao_horaria.csv  → {len(toda_geracao_h):,} linhas")

    # ── 3. Salvar CSVs principais ─────────────────────────────────────────────
    print(f"\n[{ts()}] Salvando CSVs...")

    if todos_dados:
        p = OUTPUT_DIR / "ccee_dados.csv"
        salvar_csv(p, todos_dados, CAMPOS_DADOS, args.modo)
        print(f"  ccee_dados.csv            → {len(todos_dados)} linhas")

    if todas_cargas:
        campos_c = ["agente","mes_referencia","sigla_parcela_carga","nome_empresarial",
                    "cidade","estado_uf","ramo_atividade","submercado",
                    "consumo_acl","consumo_total","capacidade_carga"]
        p = OUTPUT_DIR / "ccee_cargas.csv"
        salvar_csv(p, todas_cargas, campos_c, args.modo)
        print(f"  ccee_cargas.csv           → {len(todas_cargas)} linhas")

    if todas_usinas:
        campos_u = ["agente","mes_referencia","sigla_ativo","sigla_parcela_usina",
                    "fonte_energia_primaria","submercado","estado_uf",
                    "cap_t","geracao_centro_gravidade"]
        p = OUTPUT_DIR / "ccee_usinas.csv"
        salvar_csv(p, todas_usinas, campos_u, args.modo)
        print(f"  ccee_usinas.csv           → {len(todas_usinas)} linhas")

    if toda_contab:
        campos_k = ["agente","mes_referencia","sigla_perfil_agente","nome_empresarial",
                    "valor_tm_mcp","compensacao_mre","valor_encargo","valor_ajuste_exposicao",
                    "resultado_financeiro_er","resultado_final"]
        p = OUTPUT_DIR / "ccee_contabilizacao.csv"
        salvar_csv(p, toda_contab, campos_k, args.modo)
        print(f"  ccee_contabilizacao.csv   → {len(toda_contab)} linhas")

    if todo_desligamento:
        campos_d = ["agente","sigla","cnpj","classe","status","data_desligamento",
                    "inicio_monitoramento","fim_monitoramento","reuniao_cad",
                    "suspensao_fornecimento","tipos_descumprimentos",
                    "caucionamento","tipo_desligamento","data_publicacao"]
        p = OUTPUT_DIR / "ccee_desligamento.csv"
        salvar_csv(p, todo_desligamento, campos_d, args.modo)
        print(f"  ccee_desligamento.csv     → {len(todo_desligamento)} linhas")

    if nao_encontrados:
        p = OUTPUT_DIR / "nao_encontrados.csv"
        salvar_csv(p, nao_encontrados, CAMPOS_NAO_ENCONTRADOS, "a")
        print(f"  nao_encontrados.csv       → {len(nao_encontrados)} registro(s)")

    if erros:
        p = OUTPUT_DIR / "erros.csv"
        salvar_csv(p, erros, CAMPOS_NAO_ENCONTRADOS, "a")
        print(f"  erros.csv            → {len(erros)} registro(s)")

    print(f"\n[{ts()}] Concluído — ✅ {len(todos_dados) and len(agentes)-len(nao_encontrados)-len(erros)} ok"
          f" | ⚠ {len(nao_encontrados)} não encontrados | ❌ {len(erros)} erros")

if __name__ == "__main__":
    main()
