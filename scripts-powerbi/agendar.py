"""
agendar.py
==========
Executa buscar_dados.py em loop com intervalo configurável.
Alternativa leve ao Windows Task Scheduler para rodar localmente.

Uso:
    python agendar.py                    # roda agora + a cada 24h
    python agendar.py --intervalo 6      # a cada 6 horas
    python agendar.py --intervalo 0      # roda uma vez e sai
    python agendar.py --api http://...   # API diferente
"""

import argparse
import subprocess
import sys
import time
from datetime import datetime, timedelta


def timestamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def rodar_busca(api: str, agentes: str):
    print(f"\n{'='*60}")
    print(f"[{timestamp()}] Iniciando busca...")
    result = subprocess.run(
        [sys.executable, "buscar_dados.py", "--api", api, "--agentes", agentes],
        cwd=__file__[:__file__.rfind("\\")],
    )
    if result.returncode != 0:
        print(f"[{timestamp()}] buscar_dados.py terminou com código {result.returncode}")

    # Tenta reprocessar não encontrados automaticamente
    from pathlib import Path
    if Path("csv_export/nao_encontrados.csv").exists():
        print(f"\n[{timestamp()}] Reprocessando não encontrados...")
        subprocess.run(
            [sys.executable, "reprocessar_nao_encontrados.py", "--api", api],
            cwd=__file__[:__file__.rfind("\\")],
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api",       default="https://ccee-api.onrender.com")
    parser.add_argument("--agentes",   default="agentes.txt")
    parser.add_argument("--intervalo", type=float, default=24,
                        help="Intervalo em horas entre execuções (0 = roda uma vez)")
    args = parser.parse_args()

    rodar_busca(args.api, args.agentes)

    if args.intervalo <= 0:
        return

    while True:
        proxima = datetime.now() + timedelta(hours=args.intervalo)
        print(f"\n[{timestamp()}] Próxima execução: {proxima.strftime('%Y-%m-%d %H:%M:%S')}")
        print("Pressione Ctrl+C para interromper.")
        try:
            time.sleep(args.intervalo * 3600)
        except KeyboardInterrupt:
            print("\nInterrompido pelo usuário.")
            break
        rodar_busca(args.api, args.agentes)


if __name__ == "__main__":
    main()
