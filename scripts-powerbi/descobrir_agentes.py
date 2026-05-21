"""
descobrir_agentes.py
====================
Descobre todos os agentes disponíveis nos dados abertos da CCEE,
consulta a classe de cada um no Power BI e gera agentes.txt pronto
para uso no buscar_dados.py.

Comercializadores são automaticamente excluídos.

Uso:
    python descobrir_agentes.py
    python descobrir_agentes.py --saida minha_lista.txt
    python descobrir_agentes.py --salvar-info   # grava agentes_info.csv também
"""

import argparse
import csv
import json
import time
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path

# ─── Credenciais Power BI ─────────────────────────────────────────────────────

POWERBI_RESOURCE_KEY = "f6267020-1b73-4885-8920-19a9d09f1395"
POWERBI_MODEL_ID     = 7427061
POWERBI_URL          = (
    "https://wabi-brazil-south-b-primary-api.analysis.windows.net"
    "/public/reports/querydata?synchronous=true"
)

# ─── CKAN ─────────────────────────────────────────────────────────────────────

CKAN_SQL    = "https://dadosabertos.ccee.org.br/api/3/action/datastore_search_sql"
CKAN_PKG    = "https://dadosabertos.ccee.org.br/api/3/action/package_show"
CKAN_RES    = "https://dadosabertos.ccee.org.br/api/3/action/resource_show"
USER_AGENT  = "Mozilla/5.0 (compatible; CCEEMonitor-Python/1.0)"
SEED_CONTAB = "d47f9660-28d6-4542-9dbc-9648e13b3c67"  # contabilização 2024

CLASSE_SKIP = {"Comercializador"}
DELAY_S     = 1.5   # pausa entre chamadas Power BI

# ─── Helpers HTTP ─────────────────────────────────────────────────────────────

def _get(url: str, timeout: int = 20) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def _post_powerbi(body: dict, timeout: int = 20) -> dict:
    data = json.dumps(body).encode()
    req  = urllib.request.Request(
        POWERBI_URL, data=data,
        headers={"Content-Type": "application/json",
                 "X-PowerBI-ResourceKey": POWERBI_RESOURCE_KEY},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

# ─── CKAN: descobrir todos os agentes ─────────────────────────────────────────

def _resource_id_mais_recente(seed: str) -> str:
    """Acha o resource_id do ano mais recente para o dataset do seed."""
    import re
    data = _get(f"{CKAN_RES}?id={seed}")
    package_id = data["result"]["package_id"]
    pkg  = _get(f"{CKAN_PKG}?id={package_id}")
    melhor_ano = -1
    melhor_id  = seed
    for res in pkg["result"].get("resources", []):
        texto = res.get("name", "") + " " + (res.get("description") or "")
        m = re.search(r"\b(20\d{2})\b", texto)
        if m and int(m.group(1)) > melhor_ano:
            melhor_ano = int(m.group(1))
            melhor_id  = res["id"]
    print(f"  Contabilização: usando resource do ano {melhor_ano} ({melhor_id})")
    return melhor_id

def descobrir_nomes_ckan() -> list[str]:
    """
    Retorna lista de NOME_EMPRESARIAL distintos da contabilização CKAN
    (mês mais recente do ano mais recente).
    """
    resource_id = _resource_id_mais_recente(SEED_CONTAB)

    # SQL DISTINCT — mais recente mês disponível
    sql = (
        f'SELECT DISTINCT "NOME_EMPRESARIAL" '
        f'FROM "{resource_id}" '
        f'WHERE "NOME_EMPRESARIAL" IS NOT NULL '
        f'ORDER BY "NOME_EMPRESARIAL"'
    )
    url  = f"{CKAN_SQL}?sql={urllib.parse.quote(sql)}"
    data = _get(url, timeout=30)
    if not data.get("success"):
        raise RuntimeError(f"CKAN SQL falhou: {data.get('error')}")

    nomes = [r["NOME_EMPRESARIAL"].strip() for r in data["result"]["records"]
             if r.get("NOME_EMPRESARIAL")]
    print(f"  {len(nomes)} nomes distintos encontrados na contabilização")
    return nomes

# ─── Power BI: buscar classe de um agente ────────────────────────────────────

def _query_metadados(agente: str) -> dict:
    """Body Power BI com só a query de metadados (Q2)."""
    return {
        "version":  "1.0.0",
        "modelId":  POWERBI_MODEL_ID,
        "queries":  [{
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
        }],
        "cancelQueries": [],
    }

def buscar_classe(agente: str) -> dict | None:
    """
    Chama o Power BI com só a query de metadados.
    Retorna {classe, razao_social, sigla, cnpj, situacao} ou None se não encontrado.
    """
    try:
        resp    = _post_powerbi(_query_metadados(agente))
        results = resp.get("results", [])
        if not results:
            return None
        dsr   = results[0].get("result", {}).get("data", {}).get("dsr", {})
        ds    = dsr.get("DS", [{}])[0]
        dm    = ds.get("PH", [{}])[0].get("DM0")
        dicts = ds.get("ValueDicts", {})
        if not dm:
            return None
        row = dm[0]
        C   = row.get("C", [])
        def d(key, idx):
            if isinstance(idx, str): return idx
            lst = dicts.get(key, [])
            return lst[idx] if isinstance(idx, int) and idx < len(lst) else None
        return {
            "classe":       d("D0", C[0]) if len(C) > 0 else None,
            "razao_social": d("D1", C[1]) if len(C) > 1 else None,
            "sigla":        d("D2", C[2]) if len(C) > 2 else None,
            "cnpj":         d("D3", C[3]) if len(C) > 3 else None,
            "situacao":     d("D4", C[4]) if len(C) > 4 else None,
        }
    except Exception:
        return None

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Descobre agentes CCEE e gera agentes.txt")
    parser.add_argument("--saida",      default="agentes.txt",      help="Arquivo de saída com agentes")
    parser.add_argument("--salvar-info", action="store_true",        help="Salva agentes_info.csv com classe, CNPJ, etc.")
    args = parser.parse_args()

    print("═" * 60)
    print("Descobrindo agentes nos dados abertos da CCEE...")
    print("═" * 60)

    # 1. Descobre nomes via contabilização CKAN
    print("\n[1/3] Consultando CKAN (contabilização)...")
    nomes = descobrir_nomes_ckan()

    # 2. Para cada nome, consulta classe no Power BI
    print(f"\n[2/3] Consultando Power BI para {len(nomes)} agentes...\n")

    incluidos    = []
    excluidos    = []
    nao_achados  = []

    for i, nome in enumerate(nomes, 1):
        print(f"  [{i:>3}/{len(nomes)}] {nome:<45} ", end="", flush=True)
        meta = buscar_classe(nome)

        if meta is None:
            nao_achados.append(nome)
            print("⚠  não encontrado no Power BI")
        elif meta.get("classe") in CLASSE_SKIP:
            excluidos.append({**meta, "agente": nome})
            print(f"⏭  {meta['classe']} — pulado")
        else:
            incluidos.append({**meta, "agente": nome})
            print(f"✅  {meta.get('classe') or '?'}")

        if i < len(nomes):
            time.sleep(DELAY_S)

    # 3. Salva resultados
    print(f"\n[3/3] Salvando...")

    saida = Path(args.saida)
    with open(saida, "w", encoding="utf-8") as f:
        f.write("# Gerado por descobrir_agentes.py — CCEE Monitor\n")
        f.write(f"# Total: {len(incluidos)} agentes | {len(excluidos)} comercializadores excluídos\n")
        for ag in sorted(incluidos, key=lambda x: x["agente"]):
            f.write(f"{ag['agente']}\n")
    print(f"  {saida}: {len(incluidos)} agentes")

    if args.salvar_info:
        campos = ["agente", "classe", "razao_social", "sigla", "cnpj", "situacao"]
        info_path = Path("agentes_info.csv")
        with open(info_path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=campos, delimiter=";", extrasaction="ignore")
            w.writeheader()
            for ag in sorted(incluidos + excluidos, key=lambda x: x["agente"]):
                w.writerow(ag)
        print(f"  agentes_info.csv: {len(incluidos) + len(excluidos)} linhas")

    print(f"\n{'═'*60}")
    print(f"  ✅ Incluídos:    {len(incluidos)}")
    print(f"  ⏭  Excluídos:   {len(excluidos)} ({', '.join(x['agente'] for x in excluidos[:5])})")
    print(f"  ⚠  Não achados: {len(nao_achados)}")
    if nao_achados:
        print(f"     {nao_achados}")
    print(f"\n  Próximo passo: python buscar_dados.py --agentes {saida}")

if __name__ == "__main__":
    main()
