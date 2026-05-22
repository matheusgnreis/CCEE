"""
agendar.py
==========
Executa buscar_dados.py em loop com intervalo configurável.
Alternativa leve ao Windows Task Scheduler para rodar localmente.

Uso:
    python agendar.py                        # roda agora + a cada 24h
    python agendar.py --intervalo 6          # a cada 6 horas
    python agendar.py --intervalo 0          # roda uma vez e sai
    python agendar.py --horario              # inclui curva horária + modulação
    python agendar.py --agentes lista.txt    # arquivo de agentes diferente
"""

import argparse
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent


def timestamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def rodar_busca(agentes: str, horario: bool):
    print(f"\n{'='*60}")
    print(f"[{timestamp()}] Iniciando busca...")

    cmd = [sys.executable, "buscar_dados.py", "--agentes", agentes, "--modo", "w"]
    if horario:
        cmd.append("--horario")

    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        print(f"[{timestamp()}] buscar_dados.py terminou com código {result.returncode}")

    nao_enc = SCRIPT_DIR / "csv_export" / "nao_encontrados.csv"
    if nao_enc.exists():
        print(f"\n[{timestamp()}] Reprocessando não encontrados...")
        subprocess.run([sys.executable, "reprocessar_nao_encontrados.py"], cwd=SCRIPT_DIR)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--agentes",   default="agentes.txt",
                        help="Arquivo com lista de agentes (um por linha)")
    parser.add_argument("--intervalo", type=float, default=24,
                        help="Intervalo em horas entre execuções (0 = roda uma vez)")
    parser.add_argument("--horario",   action="store_true",
                        help="Inclui download de curva horária e cálculo de modulação")
    args = parser.parse_args()

    rodar_busca(args.agentes, args.horario)

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
        rodar_busca(args.agentes, args.horario)


if __name__ == "__main__":
    main()
