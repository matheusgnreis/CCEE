"""
rodar_tudo.py
=============
Pipeline completo em Python (sem dependência de API ou banco de dados):

  [1/4] Streama CKAN consumo horário → descobre TODOS os agentes do arquivo
  [2/4] Novos agentes → Power BI Q2 (metadata) + dados históricos + CKAN cargas/usinas/contab
  [3/4] Todos → salva consumo horário por mês + geração horária (se houver usinas)
  [4/4] Todos → calcula modulação e salva

CSVs gerados em csv_export/:
  ccee_agentes.csv        — catálogo de agentes conhecidos
  ccee_dados.csv          — séries financeiras mensais (Power BI)
  ccee_cargas.csv         — parcelas de carga (CKAN)
  ccee_usinas.csv         — parcelas de usina (CKAN)
  ccee_contabilizacao.csv — contabilização de montante (CKAN)
  ccee_consumo_horario.csv — consumo horário por período (CKAN)
  ccee_geracao_horaria.csv — geração horária por usina (CKAN)
  ccee_modulacao.csv      — custo de modulação calculado
  nao_encontrados.csv     — agentes não encontrados no Power BI

Uso:
  python rodar_tudo.py                         # tudo, todos os meses pendentes
  python rodar_tudo.py --mes 2025-06           # mês específico
  python rodar_tudo.py --sem-powerbi           # pula onboarding (só consumo+modulação)
  python rodar_tudo.py --primeiro-mes 2025-01  # ignora meses anteriores
"""

import argparse
import csv
import json
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

# ─── Imports dos módulos existentes ───────────────────────────────────────────

# Adiciona o diretório atual ao path para importar ckan e buscar_dados
sys.path.insert(0, str(Path(__file__).parent))

from ckan import (
    buscar_cargas,
    buscar_usinas,
    buscar_contabilizacao,
    buscar_consumo_horario,
    buscar_geracao_horaria,
    buscar_pld_mapa,
    calcular_modulacao,
    meses_disponiveis_consumo,
    meses_disponiveis_geracao,
    _listar_recursos_ckan,
    _stream_csv_gzip,
    remover_acentos,
    DATASET_CONSUMO_HORARIO,
    DATASET_GERACAO_HORARIA,
    SUB_MAP,
)

from buscar_dados import (
    buscar_agente,
    salvar_csv,
    chamar_powerbi,
    extrair_metadados,
    _q_metadados,
    CAMPOS_DADOS,
    CAMPOS_CONSUMO_H,
    CAMPOS_GERACAO_H,
    POWERBI_RESOURCE_KEY,
    POWERBI_MODEL_ID,
    POWERBI_URL,
    OUTPUT_DIR,
    ts,
)

# ─── Configuração ─────────────────────────────────────────────────────────────

CLASSES_SKIP  = {"Comercializador"}
DELAY_S       = 1.5
PRIMEIRO_MES  = "2025-01"

CAMPOS_AGENTES    = ["agente", "classe", "razao_social", "sigla", "cnpj", "situacao"]
CAMPOS_CARGAS     = [
    "agente", "sigla_perfil_agente", "mes_referencia", "cod_perf_agente",
    "nome_empresarial", "cod_parcela_carga", "sigla_parcela_carga", "cnpj_carga",
    "cidade", "estado_uf", "ramo_atividade", "submercado",
    "capacidade_carga", "consumo_acl", "consumo_cativo_parc_livre", "consumo_total",
]
CAMPOS_USINAS     = [
    "agente", "sigla_perfil", "mes_referencia", "sigla_ativo", "cod_parcela_usina",
    "sigla_parcela_usina", "tipo_despacho", "fonte_energia_primaria", "submercado",
    "estado_uf", "caracteristica_parcela", "participante_mre", "participante_regime_cotas",
    "percentual_desconto_usina", "cap_t", "geracao_centro_gravidade", "gf_centro_gravidade",
]
CAMPOS_CONTAB     = [
    "agente", "mes_referencia", "sigla_perfil_agente", "nome_empresarial", "cod_perf_agente",
    "valor_tm_mcp", "compensacao_mre", "valor_encargo", "valor_ajuste_exposicao",
    "valor_ajuste_alivio_ret", "efeito_contrat_disp", "efeito_contrat_cota_gf",
    "efeito_contrat_nuclear", "ajuste_recontab", "ajuste_mcsd_ex",
    "resultado_financeiro_er", "efeito_ccearq", "efeito_contrat_itaipu",
    "efeito_repasse_risco_hidro", "efeito_desloc_pld_cmo", "resultado_final",
]
CAMPOS_MODULACAO  = [
    "agente", "mes_referencia", "submercado", "consumo_total_mwh",
    "n_horas", "soma_curva_rs", "soma_flat_rs", "custo_modulacao_rs_mwh",
]
CAMPOS_NAO_ENCONTRADOS = ["agente", "motivo", "timestamp"]

# ─── CSV helpers ──────────────────────────────────────────────────────────────

def ler_csv(caminho: Path, chave: str) -> dict:
    """Lê CSV e retorna {valor_da_chave: row_dict}. Retorna {} se não existir."""
    if not caminho.exists():
        return {}
    with open(caminho, encoding="utf-8-sig") as f:
        return {r[chave]: r for r in csv.DictReader(f, delimiter=";")}

def ler_set_csv(caminho: Path, coluna: str) -> set:
    """Retorna conjunto de valores de uma coluna. Retorna set() se não existir."""
    if not caminho.exists():
        return set()
    with open(caminho, encoding="utf-8-sig") as f:
        return {r[coluna] for r in csv.DictReader(f, delimiter=";") if r.get(coluna)}

def salvar_agentes_csv(agentes: dict):
    """Salva/atualiza ccee_agentes.csv com todos os agentes conhecidos."""
    linhas = [{"agente": k, **{c: v.get(c, "") for c in CAMPOS_AGENTES[1:]}}
              for k, v in sorted(agentes.items())]
    salvar_csv(OUTPUT_DIR / "ccee_agentes.csv", linhas, CAMPOS_AGENTES, modo="w")

# ─── Fase 1: Descoberta de agentes via stream CKAN ────────────────────────────

def descobrir_agentes_no_ckan(mes_fixo: str | None) -> tuple[list[str], str]:
    """
    Streama o CSV de consumo horário (mês mais recente ou fixo) e coleta
    todos os NOME_EMPRESARIAL distintos. Retorna (lista_de_nomes, mes_usado).
    """
    recursos = _listar_recursos_ckan(DATASET_CONSUMO_HORARIO)
    recursos_validos = [r for r in recursos if r["mes"] >= PRIMEIRO_MES]
    if not recursos_validos:
        raise RuntimeError("Nenhum recurso de consumo horário disponível")

    if mes_fixo:
        recurso = next((r for r in recursos_validos if r["mes"] == mes_fixo), None)
        if not recurso:
            raise RuntimeError(f"Mês {mes_fixo} não disponível no CKAN")
    else:
        recurso = recursos_validos[-1]  # mais recente — suficiente pois o fix do Tipo corrige a busca

    print(f"  Descobrindo agentes em {recurso['mes']}...")
    nomes: set[str] = set()

    def coletar(row: dict):
        nome = (row.get("NOME_EMPRESARIAL") or "").strip()
        if nome:
            nomes.add(nome)

    _stream_csv_gzip(recurso["url"], coletar)
    print(f"  {len(nomes)} agentes distintos encontrados no arquivo")
    return sorted(nomes), recurso["mes"]

# ─── Fase 2: Onboarding via Power BI ──────────────────────────────────────────

def _q_metadados_razao_social(razao_social: str) -> dict:
    """Q2 buscando por Razão Social (NOME_EMPRESARIAL do CKAN) em vez de NM_CSSE."""
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
                    {"Column": {"Expression": {"SourceRef": {"Source": "s"}}, "Property": "NM_CSSE"}},
                    {"Column": {"Expression": {"SourceRef": {"Source": "s"}}, "Property": "NM_RZOA_SOCI"}},
                    {"Column": {"Expression": {"SourceRef": {"Source": "s"}}, "Property": "SG_AGEN"}},
                    {"Column": {"Expression": {"SourceRef": {"Source": "s"}}, "Property": "CNPJ_Formatado"}},
                    {"Column": {"Expression": {"SourceRef": {"Source": "s"}}, "Property": "DS_STAT_AGEN"}},
                ],
                "Where": [
                    {"Condition": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "t"}},
                        "Property": "Tipo"}}], "Values": [[{"Literal": {"Value": "'Razão Social'"}}]]}}},
                    {"Condition": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "c"}},
                        "Property": "FiltroMesAno"}}], "Values": [[{"Literal": {"Value": "'(mais recente)'"}}]]}}},
                    {"Condition": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "t"}},
                        "Property": "Valor"}}], "Values": [[{"Literal": {"Value": f"'{razao_social}'"}}]]}}},
                ],
            },
            "Binding": {
                "Primary": {"Groupings": [{"Projections": [0, 1, 2, 3, 4]}]},
                "DataReduction": {"DataVolume": 3, "Primary": {"Window": {"Count": 10}}},
                "Version": 1,
            },
        }}]},
    }

def buscar_meta_powerbi(razao_social: str) -> dict | None:
    """Chama Power BI Q2 buscando por Razão Social (NOME_EMPRESARIAL do CKAN)."""
    body = {
        "version": "1.0.0",
        "modelId": POWERBI_MODEL_ID,
        "queries": [_q_metadados_razao_social(razao_social)],
        "cancelQueries": [],
    }
    try:
        resp = chamar_powerbi(body)
        resultado = (resp.get("results") or [{}])[0]
        meta = extrair_metadados(resultado)
        return meta if meta.get("classe") else None
    except Exception as e:
        print(f"    Power BI Q2 erro: {e}")
        return None

def onboardar_agente(agente: str, meta: dict, sem_powerbi: bool) -> list[dict]:
    """
    Busca todos os dados do agente no Power BI (histórico completo) e CKAN.
    Retorna linhas de dados para ccee_dados.csv.
    """
    razao   = meta.get("razao_social") or agente
    sigla   = meta.get("sigla") or ""
    historico_linhas = []

    # Power BI: histórico financeiro completo
    if not sem_powerbi:
        print(f"    Power BI — histórico financeiro...")
        resultado = buscar_agente(agente, None)
        if resultado["status"] == "ok":
            historico_linhas = resultado["historico"]
            salvar_csv(OUTPUT_DIR / "ccee_dados.csv", historico_linhas, CAMPOS_DADOS, modo="a")
            print(f"    {len(historico_linhas)} meses salvos em ccee_dados.csv")
        else:
            print(f"    Power BI histórico: {resultado.get('motivo', 'sem dados')}")

    # CKAN: cargas
    try:
        print(f"    CKAN cargas...")
        cargas = buscar_cargas(razao, sigla)
        for r in cargas:
            r["agente"] = agente
        salvar_csv(OUTPUT_DIR / "ccee_cargas.csv", cargas, CAMPOS_CARGAS, modo="a")
        print(f"    {len(cargas)} registros de carga")
    except Exception as e:
        print(f"    Cargas erro: {e}")

    # CKAN: usinas
    try:
        print(f"    CKAN usinas...")
        usinas = buscar_usinas(razao)
        for r in usinas:
            r["agente"] = agente
        salvar_csv(OUTPUT_DIR / "ccee_usinas.csv", usinas, CAMPOS_USINAS, modo="a")
        print(f"    {len(usinas)} registros de usina")
    except Exception as e:
        print(f"    Usinas erro: {e}")

    # CKAN: contabilização
    try:
        print(f"    CKAN contabilização...")
        contab = buscar_contabilizacao(razao)
        for r in contab:
            r["agente"] = agente
        salvar_csv(OUTPUT_DIR / "ccee_contabilizacao.csv", contab, CAMPOS_CONTAB, modo="a")
        print(f"    {len(contab)} registros de contabilização")
    except Exception as e:
        print(f"    Contabilização erro: {e}")

    return historico_linhas

# ─── Fase 3: Consumo horário + geração ────────────────────────────────────────

def processar_consumo_mes(
    mes: str,
    agentes_ativos: dict,      # {nome: meta}
    mod_calculada: set,        # {"nome|mes"} já processados
) -> dict[str, list[dict]]:
    """
    Baixa consumo horário do mês UMA VEZ para todos os agentes pendentes.
    Retorna {nome: [rows]} para cálculo de modulação.
    """
    pendentes = {
        nome: remover_acentos((meta.get("razao_social") or nome).upper())
        for nome, meta in agentes_ativos.items()
        if f"{nome}|{mes}" not in mod_calculada
    }
    if not pendentes:
        return {}

    print(f"  Consumo horário {mes} — {len(pendentes)} agentes pendentes")
    try:
        dados = buscar_consumo_horario(mes, pendentes)
    except Exception as e:
        print(f"    Erro: {e}")
        return {}

    # Salva consumo
    todas_linhas = []
    for nome, rows in dados.items():
        for r in rows:
            r["agente"] = nome
        todas_linhas.extend(rows)

    if todas_linhas:
        salvar_csv(OUTPUT_DIR / "ccee_consumo_horario.csv", todas_linhas, CAMPOS_CONSUMO_H, modo="a")
        print(f"    {len(todas_linhas)} períodos salvos")

    return dados

def processar_geracao_mes(
    mes: str,
    agentes_com_usinas: dict,  # {nome: [sigla_usina, ...]}
) -> dict[str, list[dict]]:
    """Baixa geração horária do mês para agentes com usinas."""
    if not agentes_com_usinas:
        return {}

    print(f"  Geração horária {mes} — {len(agentes_com_usinas)} agentes")
    try:
        dados = buscar_geracao_horaria(mes, agentes_com_usinas)
    except Exception as e:
        print(f"    Erro: {e}")
        return {}

    todas_linhas = []
    for nome, rows in dados.items():
        for r in rows:
            r["agente"] = nome
        todas_linhas.extend(rows)

    if todas_linhas:
        salvar_csv(OUTPUT_DIR / "ccee_geracao_horaria.csv", todas_linhas, CAMPOS_GERACAO_H, modo="a")
        print(f"    {len(todas_linhas)} períodos de geração salvos")

    return dados

# ─── Fase 4: Modulação ────────────────────────────────────────────────────────

_pld_cache: dict[str, dict] = {}

def calcular_e_salvar_modulacao(
    mes: str,
    consumo_por_agente: dict[str, list[dict]],
) -> list[dict]:
    """Calcula modulação para todos os agentes que têm consumo no mês."""
    global _pld_cache

    if not consumo_por_agente:
        return []

    if mes not in _pld_cache:
        try:
            _pld_cache[mes] = buscar_pld_mapa(mes)
        except Exception as e:
            print(f"    PLD {mes} indisponível: {e}")
            return []

    pld_mapa = _pld_cache[mes]
    linhas_mod = []

    for agente, consumo_rows in consumo_por_agente.items():
        if not consumo_rows:
            continue
        resultado = calcular_modulacao(consumo_rows, pld_mapa)
        for sub, dados in resultado.items():
            linhas_mod.append({
                "agente":               agente,
                "mes_referencia":       mes,
                "submercado":           sub,
                "consumo_total_mwh":    dados["consumo_total_mwh"],
                "n_horas":              dados["n_horas"],
                "soma_curva_rs":        dados["soma_curva_rs"],
                "soma_flat_rs":         dados["soma_flat_rs"],
                "custo_modulacao_rs_mwh": dados["custo_modulacao_rs_mwh"],
            })
            print(f"    {agente} {mes} {sub}: {dados['consumo_total_mwh']} MWh | {dados['custo_modulacao_rs_mwh']} R$/MWh")

    if linhas_mod:
        salvar_csv(OUTPUT_DIR / "ccee_modulacao.csv", linhas_mod, CAMPOS_MODULACAO, modo="a")

    return linhas_mod

# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Pipeline completo CCEE — descobre agentes, busca dados, calcula modulação")
    parser.add_argument("--mes",           default=None,  help="Mês específico YYYY-MM")
    parser.add_argument("--primeiro-mes",  default=PRIMEIRO_MES, help="Ignora meses anteriores (padrão: 2025-01)")
    parser.add_argument("--sem-powerbi",   action="store_true", help="Pula onboarding Power BI de novos agentes")
    args = parser.parse_args()

    primeiro_mes = args.primeiro_mes

    print("\n" + "=" * 60)
    print("PIPELINE COMPLETO — CCEE Monitor (Python)")
    print("=" * 60)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # ── Carrega estado atual ───────────────────────────────────────────────────
    agentes_csv   = OUTPUT_DIR / "ccee_agentes.csv"
    modulacao_csv = OUTPUT_DIR / "ccee_modulacao.csv"

    agentes_conhecidos: dict[str, dict] = ler_csv(agentes_csv, "agente")
    mod_calculada: set[str] = set()
    if modulacao_csv.exists():
        with open(modulacao_csv, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f, delimiter=";"):
                mod_calculada.add(f"{r['agente']}|{r['mes_referencia']}")

    print(f"\nEstado: {len(agentes_conhecidos)} agentes conhecidos | {len(mod_calculada)} combinações agente+mês já calculadas")

    # ── [1/4] Descoberta ──────────────────────────────────────────────────────
    print("\n[1/4] Descobrindo agentes no CKAN...")
    nomes_ckan, mes_descoberta = descobrir_agentes_no_ckan(args.mes)

    nomes_novos = [n for n in nomes_ckan if n not in agentes_conhecidos]
    print(f"  {len(nomes_ckan)} total | {len(agentes_conhecidos)} já conhecidos | {len(nomes_novos)} novos")

    # ── [2/4] Onboarding de novos ─────────────────────────────────────────────
    nao_encontrados = []

    if nomes_novos and not args.sem_powerbi:
        print(f"\n[2/4] Onboarding de {len(nomes_novos)} novos agentes...")
        for i, nome in enumerate(nomes_novos):
            print(f"\n  [{i+1}/{len(nomes_novos)}] {nome}")

            meta = buscar_meta_powerbi(nome)
            if not meta:
                print(f"    ⚠  não encontrado no Power BI")
                nao_encontrados.append({"agente": nome, "motivo": "sem metadados no Power BI", "timestamp": ts()})
                continue

            if meta.get("classe") in CLASSES_SKIP:
                print(f"    ⏭  {meta['classe']} — pulado")
                continue

            # Usa SG_AGEN (sigla) como chave — igual ao que a API usa (NM_CSSE)
            agente_key = meta.get("sigla") or nome
            print(f"    ✅  {meta.get('classe', '?')} | agente: {agente_key}")
            meta["razao_social"] = meta.get("razao_social") or nome
            agentes_conhecidos[agente_key] = meta
            salvar_agentes_csv(agentes_conhecidos)

            onboardar_agente(agente_key, meta, args.sem_powerbi)

            if i < len(nomes_novos) - 1:
                time.sleep(DELAY_S)
    elif nomes_novos:
        print(f"\n[2/4] {len(nomes_novos)} novos ignorados (--sem-powerbi)")
    else:
        print("\n[2/4] Nenhum agente novo — pulando")

    if nao_encontrados:
        salvar_csv(OUTPUT_DIR / "nao_encontrados.csv", nao_encontrados, CAMPOS_NAO_ENCONTRADOS, modo="a")

    # Agentes ativos (exclui classes sem consumo)
    agentes_ativos = {
        nome: meta for nome, meta in agentes_conhecidos.items()
        if meta.get("classe") not in CLASSES_SKIP
    }

    # Usinas por agente (para geração horária)
    usinas_csv = OUTPUT_DIR / "ccee_usinas.csv"
    agentes_com_usinas: dict[str, list[str]] = {}
    if usinas_csv.exists():
        with open(usinas_csv, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f, delimiter=";"):
                agente = r.get("agente", "")
                usina  = (r.get("sigla_parcela_usina") or "").strip().upper()
                if agente and usina:
                    agentes_com_usinas.setdefault(agente, []).append(usina)

    # Meses a processar
    meses_ckan = [m for m in meses_disponiveis_consumo() if m >= primeiro_mes]
    if args.mes:
        meses_processar = [args.mes] if args.mes in meses_ckan else []
    else:
        meses_processar = [
            mes for mes in meses_ckan
            if any(f"{nome}|{mes}" not in mod_calculada for nome in agentes_ativos)
        ]

    if not meses_processar:
        print("\n✅ Nenhum mês pendente.")
    else:
        print(f"\n[3/4] Baixando consumo horário — {len(meses_processar)} meses")
        print(f"[4/4] Calculando modulação")

        for mes in meses_processar:
            print(f"\n{'─' * 60}")
            print(f"  📅 {mes}")

            # Consumo
            consumo_por_agente = processar_consumo_mes(mes, agentes_ativos, mod_calculada)

            # Geração (agentes que têm usinas e dados de consumo)
            agentes_ger_mes = {
                nome: sigs for nome, sigs in agentes_com_usinas.items()
                if nome in agentes_ativos
            }
            processar_geracao_mes(mes, agentes_ger_mes)

            # Modulação
            calcular_e_salvar_modulacao(mes, consumo_por_agente)

            # Marca como calculado
            for nome in consumo_por_agente:
                mod_calculada.add(f"{nome}|{mes}")

    # Salva estado final de agentes
    if agentes_conhecidos:
        salvar_agentes_csv(agentes_conhecidos)

    print("\n" + "=" * 60)
    print("✅ Pipeline concluído.")
    print(f"   Agentes: {len(agentes_ativos)} ativos")
    print(f"   CSVs em: {OUTPUT_DIR.resolve()}")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
