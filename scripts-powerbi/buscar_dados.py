"""
buscar_dados.py
===============
Busca dados de agentes CCEE via API e salva em CSV para uso no Power BI.

Uso:
    python buscar_dados.py
    python buscar_dados.py --api http://localhost:3001
    python buscar_dados.py --agentes minha_lista.txt
    python buscar_dados.py --mes 2026-03
"""

import argparse
import csv
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

# ─── Configuração ─────────────────────────────────────────────────────────────

DEFAULT_API  = "https://ccee-api.onrender.com"   # substitua pela URL do Render
OUTPUT_DIR   = Path("csv_export")
DELAY_S      = 1.2   # pausa entre requisições (respeita rate limit da API)
TIMEOUT_S    = 30

# ─── Helpers ──────────────────────────────────────────────────────────────────

def get_json(url, timeout=TIMEOUT_S):
    req = urllib.request.Request(url, headers={"User-Agent": "CCEE-PowerBI-Exporter/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def salvar_csv(caminho: Path, linhas: list[dict], modo="w"):
    if not linhas:
        return
    caminho.parent.mkdir(parents=True, exist_ok=True)
    escrever_header = modo == "w" or not caminho.exists()
    with open(caminho, modo, newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=linhas[0].keys(), delimiter=";")
        if escrever_header:
            w.writeheader()
        w.writerows(linhas)

def ler_lista_agentes(caminho: str) -> list[str]:
    agentes = []
    with open(caminho, encoding="utf-8") as f:
        for linha in f:
            linha = linha.strip()
            if linha and not linha.startswith("#"):
                agentes.append(linha)
    return agentes

def timestamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

# ─── Funções de busca ─────────────────────────────────────────────────────────

def buscar_historico(api: str, agente: str) -> list[dict]:
    """Busca série histórica completa do agente."""
    url = f"{api}/inteligencia/{urllib.parse.quote(agente)}/historico"
    return get_json(url)

def buscar_mes(api: str, agente: str, mes: str | None = None) -> dict:
    """Busca dados do mês mais recente (ou mês específico) do agente."""
    url = f"{api}/inteligencia/{urllib.parse.quote(agente)}"
    if mes:
        url += f"?mes={mes}"
    return get_json(url)

def buscar_cargas(api: str, agente: str, mes: str) -> list[dict]:
    """Busca parcelas de carga do agente no mês."""
    url = f"{api}/inteligencia/{urllib.parse.quote(agente)}/cargas?mes={mes}"
    try:
        return get_json(url)
    except Exception:
        return []

def buscar_modulacao(api: str, agente: str) -> dict | None:
    """Busca resultado de modulação horária do agente."""
    url = f"{api}/inteligencia/{urllib.parse.quote(agente)}/modulacao"
    try:
        return get_json(url)
    except Exception:
        return None

# ─── Processamento principal ──────────────────────────────────────────────────

def processar_agente(api: str, agente: str, mes: str | None) -> dict:
    """
    Retorna:
        { "status": "ok", "historico": [...], "mes_atual": {...}, "cargas": [...] }
        { "status": "nao_encontrado", "motivo": "..." }
        { "status": "erro", "motivo": "..." }
    """
    try:
        historico = buscar_historico(api, agente)
        if not historico:
            return {"status": "nao_encontrado", "motivo": "histórico vazio"}

        mes_atual = buscar_mes(api, agente, mes)
        if mes_atual.get("error"):
            return {"status": "nao_encontrado", "motivo": mes_atual["error"]}

        mes_ref = mes_atual.get("mes") or (historico[-1]["mes"] if historico else None)
        cargas  = buscar_cargas(api, agente, mes_ref) if mes_ref else []
        mod     = buscar_modulacao(api, agente)

        return {
            "status":    "ok",
            "historico": historico,
            "mes_atual": mes_atual,
            "cargas":    cargas,
            "modulacao": mod,
        }

    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"status": "nao_encontrado", "motivo": f"HTTP 404"}
        return {"status": "erro", "motivo": f"HTTP {e.code}"}
    except Exception as e:
        return {"status": "erro", "motivo": str(e)}

def flatten_historico(agente: str, historico: list[dict]) -> list[dict]:
    """Normaliza linhas do histórico para o CSV ccee_dados."""
    campos = [
        "agente", "mes", "consumo", "compra", "mcp", "resultado",
        "resultado_mcp", "balanco_energetico", "geracao", "venda",
        "consumo_geracao", "mcp_rs_mwh", "mre_mais", "mre_menos",
        "razao_social", "sigla", "cnpj", "classe", "situacao", "capital_social",
    ]
    rows = []
    for h in historico:
        row = {c: h.get(c, "") for c in campos}
        row["agente"] = agente
        rows.append(row)
    return rows

def flatten_cargas(cargas: list[dict]) -> list[dict]:
    campos = [
        "agente", "mes_referencia", "sigla_parcela_carga", "nome_empresarial",
        "cidade", "estado_uf", "ramo_atividade", "submercado",
        "consumo_acl", "consumo_total", "capacidade_carga",
    ]
    return [{c: r.get(c, "") for c in campos} for r in cargas]

def flatten_modulacao(agente: str, mod: dict | None) -> list[dict]:
    if not mod or not mod.get("resultados"):
        return []
    campos = [
        "agente", "mes_referencia", "submercado",
        "consumo_total_mwh", "n_horas",
        "soma_curva_rs", "soma_flat_rs", "custo_modulacao_rs_mwh",
    ]
    rows = []
    for r in mod["resultados"]:
        row = {c: r.get(c, "") for c in campos}
        row["agente"] = agente
        rows.append(row)
    return rows

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Exporta dados CCEE para CSV (Power BI)")
    parser.add_argument("--api",      default=DEFAULT_API,  help="URL base da API")
    parser.add_argument("--agentes",  default="agentes.txt", help="Arquivo com lista de agentes")
    parser.add_argument("--mes",      default=None,         help="Mês específico (YYYY-MM)")
    parser.add_argument("--modo",     default="w",          choices=["w", "a"],
                        help="w=sobrescreve, a=acumula (append)")
    args = parser.parse_args()

    agentes = ler_lista_agentes(args.agentes)
    print(f"[{timestamp()}] {len(agentes)} agentes | API: {args.api}")
    print(f"[{timestamp()}] Saída: {OUTPUT_DIR.resolve()}\n")

    todos_dados     = []
    todas_cargas    = []
    toda_modulacao  = []
    nao_encontrados = []
    erros           = []

    for i, agente in enumerate(agentes, 1):
        print(f"[{i:>3}/{len(agentes)}] {agente}... ", end="", flush=True)
        resultado = processar_agente(args.api, agente, args.mes)

        if resultado["status"] == "ok":
            hist_rows = flatten_historico(agente, resultado["historico"])
            carg_rows = flatten_cargas(resultado["cargas"])
            mod_rows  = flatten_modulacao(agente, resultado["modulacao"])

            todos_dados.extend(hist_rows)
            todas_cargas.extend(carg_rows)
            toda_modulacao.extend(mod_rows)

            mes_ref = resultado["mes_atual"].get("mes", "?")
            print(f"✅  {len(hist_rows)} meses | {len(carg_rows)} cargas | mês={mes_ref}")

        elif resultado["status"] == "nao_encontrado":
            nao_encontrados.append({
                "agente":    agente,
                "motivo":    resultado["motivo"],
                "timestamp": timestamp(),
            })
            print(f"⚠  não encontrado — {resultado['motivo']}")

        else:
            erros.append({
                "agente":    agente,
                "motivo":    resultado["motivo"],
                "timestamp": timestamp(),
            })
            print(f"❌  erro — {resultado['motivo']}")

        if i < len(agentes):
            time.sleep(DELAY_S)

    # Salvar CSVs
    print(f"\n[{timestamp()}] Salvando arquivos...")

    if todos_dados:
        p = OUTPUT_DIR / "ccee_dados.csv"
        salvar_csv(p, todos_dados, args.modo)
        print(f"  ccee_dados.csv          → {len(todos_dados)} linhas")

    if todas_cargas:
        p = OUTPUT_DIR / "ccee_cargas.csv"
        salvar_csv(p, todas_cargas, args.modo)
        print(f"  ccee_cargas.csv         → {len(todas_cargas)} linhas")

    if toda_modulacao:
        p = OUTPUT_DIR / "ccee_modulacao.csv"
        salvar_csv(p, toda_modulacao, args.modo)
        print(f"  ccee_modulacao.csv      → {len(toda_modulacao)} linhas")

    if nao_encontrados:
        p = OUTPUT_DIR / "nao_encontrados.csv"
        salvar_csv(p, nao_encontrados, "a")   # sempre acumula
        print(f"  nao_encontrados.csv     → {len(nao_encontrados)} novos registros")

    if erros:
        p = OUTPUT_DIR / "erros.csv"
        salvar_csv(p, erros, "a")
        print(f"  erros.csv               → {len(erros)} novos registros")

    print(f"\n[{timestamp()}] Concluído.")
    print(f"  ✅ ok: {len(agentes) - len(nao_encontrados) - len(erros)}")
    print(f"  ⚠  não encontrados: {len(nao_encontrados)}")
    print(f"  ❌ erros: {len(erros)}")

if __name__ == "__main__":
    main()
