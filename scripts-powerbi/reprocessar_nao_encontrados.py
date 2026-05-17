"""
reprocessar_nao_encontrados.py
================================
Relê csv_export/nao_encontrados.csv e tenta buscar novamente cada agente.
Encontrados → movidos para ccee_dados.csv. Permanecem no arquivo apenas os que
continuam sem resultado.

Uso:
    python reprocessar_nao_encontrados.py
    python reprocessar_nao_encontrados.py --mes 2026-03
"""

import argparse
import csv
import time
from pathlib import Path
from buscar_dados import (
    OUTPUT_DIR, DELAY_S, CAMPOS_DADOS, CAMPOS_NAO_ENCONTRADOS,
    buscar_agente, salvar_csv, ts,
)

NAO_ENCONTRADOS = OUTPUT_DIR / "nao_encontrados.csv"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mes", default=None)
    args = parser.parse_args()

    if not NAO_ENCONTRADOS.exists():
        print("nao_encontrados.csv não existe. Nada a reprocessar.")
        return

    with open(NAO_ENCONTRADOS, encoding="utf-8-sig") as f:
        pendentes = list(csv.DictReader(f, delimiter=";"))

    if not pendentes:
        print("Arquivo vazio.")
        return

    print(f"[{ts()}] {len(pendentes)} agente(s) para reprocessar\n")

    todos_dados     = []
    ainda_pendentes = []

    for i, row in enumerate(pendentes, 1):
        agente = row["agente"]
        print(f"[{i:>3}/{len(pendentes)}] {agente}... ", end="", flush=True)
        r = buscar_agente(agente, args.mes)

        if r["status"] == "ok":
            todos_dados.extend(r["historico"])
            print(f"✅  encontrado — {len(r['historico'])} meses")
        else:
            ainda_pendentes.append({**row, "timestamp": ts()})
            print(f"⚠   ainda {r['status']} — {r['motivo']}")

        if i < len(pendentes):
            time.sleep(DELAY_S)

    if todos_dados:
        salvar_csv(OUTPUT_DIR / "ccee_dados.csv", todos_dados, CAMPOS_DADOS, "a")
        print(f"\nccee_dados.csv: +{len(todos_dados)} linhas acumuladas")

    if ainda_pendentes:
        salvar_csv(NAO_ENCONTRADOS, ainda_pendentes, CAMPOS_NAO_ENCONTRADOS, "w")
        print(f"{len(ainda_pendentes)} agente(s) permanecem em nao_encontrados.csv")
    else:
        NAO_ENCONTRADOS.unlink()
        print("Todos encontrados! nao_encontrados.csv removido.")

    print(f"[{ts()}] Concluído.")


if __name__ == "__main__":
    main()
