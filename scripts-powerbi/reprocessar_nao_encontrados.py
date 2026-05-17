"""
reprocessar_nao_encontrados.py
================================
Lê csv_export/nao_encontrados.csv e tenta buscar novamente cada agente.
Agentes encontrados saem do arquivo; os que permanecem sem resultado ficam.

Uso:
    python reprocessar_nao_encontrados.py
    python reprocessar_nao_encontrados.py --api http://localhost:3001
"""

import argparse
import csv
import sys
from pathlib import Path
from buscar_dados import (
    DEFAULT_API, OUTPUT_DIR, DELAY_S,
    processar_agente, flatten_historico, flatten_cargas, flatten_modulacao,
    salvar_csv, timestamp,
)
import time

NAO_ENCONTRADOS_CSV = OUTPUT_DIR / "nao_encontrados.csv"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default=DEFAULT_API)
    args = parser.parse_args()

    if not NAO_ENCONTRADOS_CSV.exists():
        print("Arquivo nao_encontrados.csv não encontrado. Nada a reprocessar.")
        return

    with open(NAO_ENCONTRADOS_CSV, encoding="utf-8-sig") as f:
        pendentes = list(csv.DictReader(f, delimiter=";"))

    if not pendentes:
        print("Nenhum agente pendente.")
        return

    print(f"[{timestamp()}] {len(pendentes)} agentes para reprocessar\n")

    ainda_pendentes = []
    todos_dados    = []
    todas_cargas   = []
    toda_modulacao = []

    for i, row in enumerate(pendentes, 1):
        agente = row["agente"]
        print(f"[{i:>3}/{len(pendentes)}] {agente}... ", end="", flush=True)

        resultado = processar_agente(args.api, agente, None)

        if resultado["status"] == "ok":
            todos_dados.extend(flatten_historico(agente, resultado["historico"]))
            todas_cargas.extend(flatten_cargas(resultado["cargas"]))
            toda_modulacao.extend(flatten_modulacao(agente, resultado["modulacao"]))
            print(f"✅  encontrado agora!")
        else:
            ainda_pendentes.append({**row, "ultima_tentativa": timestamp()})
            print(f"⚠  ainda {resultado['status']} — {resultado['motivo']}")

        if i < len(pendentes):
            time.sleep(DELAY_S)

    # Acumula nos CSVs principais
    if todos_dados:
        salvar_csv(OUTPUT_DIR / "ccee_dados.csv", todos_dados, "a")
    if todas_cargas:
        salvar_csv(OUTPUT_DIR / "ccee_cargas.csv", todas_cargas, "a")
    if toda_modulacao:
        salvar_csv(OUTPUT_DIR / "ccee_modulacao.csv", toda_modulacao, "a")

    # Reescreve nao_encontrados apenas com os que ainda falharam
    if ainda_pendentes:
        salvar_csv(NAO_ENCONTRADOS_CSV, ainda_pendentes, "w")
        print(f"\n{len(ainda_pendentes)} agente(s) permanecem em nao_encontrados.csv")
    else:
        NAO_ENCONTRADOS_CSV.unlink()
        print("\nTodos os agentes foram encontrados! nao_encontrados.csv removido.")

    print(f"[{timestamp()}] Concluído.")


if __name__ == "__main__":
    main()
