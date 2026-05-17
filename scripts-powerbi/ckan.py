"""
ckan.py
=======
Funções de busca nos dados abertos da CCEE (CKAN API).
Cobre: cargas, usinas, contabilização, consumo horário (GZIP), geração horária (GZIP).
Sem dependências externas — stdlib Python 3.10+ apenas.
"""

import csv
import functools
import gzip
import io
import json
import math
import re
import time
import unicodedata
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path

# ─── Constantes ───────────────────────────────────────────────────────────────

CKAN_BASE   = "https://dadosabertos.ccee.org.br/api/3/action"
CKAN_SEARCH = f"{CKAN_BASE}/datastore_search"
CKAN_PKG    = f"{CKAN_BASE}/package_show"
CKAN_RES    = f"{CKAN_BASE}/resource_show"
USER_AGENT  = "Mozilla/5.0 (compatible; CCEEMonitor-Python/1.0)"
PAGE_SIZE   = 1000
TIMEOUT_API = 20    # segundos — chamadas CKAN paginadas
TIMEOUT_DL  = 900   # segundos — download de arquivo GZIP grande

# Seeds: apenas UM resource_id por tipo (qualquer ano serve).
# O resto dos anos é descoberto automaticamente via CKAN.
SEED_CARGAS = "b854f7bc-94a3-423a-96b7-2d4756ec77d1"  # cargas 2024
SEED_USINAS = "5c64e360-0252-4849-9dbb-8a61cb2af8f0"  # usinas 2024
SEED_CONTAB = "d47f9660-28d6-4542-9dbc-9648e13b3c67"  # contab 2024

DATASET_CONSUMO_HORARIO = "consumo_horario_perfil_agente"
DATASET_GERACAO_HORARIA = "geracao_horaria_usina"

SUB_MAP = {
    "SUDESTE": "SE", "SUDESTE/CENTRO-OESTE": "SE", "SECO": "SE",
    "SUL": "S", "NORDESTE": "NE", "NORTE": "N",
    "SE": "SE", "S": "S", "NE": "NE", "N": "N",
}

# ─── Helpers ──────────────────────────────────────────────────────────────────

def remover_acentos(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s)
                   if unicodedata.category(c) != "Mn")

def normalizar_mes(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    if len(s) == 6 and s.isdigit():
        return f"{s[:4]}-{s[4:]}"
    if len(s) == 7 and s[4] in "-/":
        return s.replace("/", "-")
    return s

def normalizar_registro(r: dict) -> dict:
    out = {}
    for k, v in r.items():
        if k == "_id":
            continue
        chave = k.lower()
        out[chave] = v
    if "mes_referencia" in out:
        out["mes_referencia"] = normalizar_mes(out["mes_referencia"])
    return out

def _get(url: str, timeout: int = TIMEOUT_API) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

# ─── Descoberta dinâmica de datasets por ano ──────────────────────────────────

@functools.lru_cache(maxsize=None)
def _datasets_por_ano(seed_resource_id: str) -> dict[int, str]:
    """
    A partir de um resource_id seed, descobre o package no CKAN e retorna
    {ano: resource_id} para todos os anos disponíveis.
    Cache em memória — só chama o CKAN uma vez por execução por tipo.
    """
    # 1. Descobre o package_id do resource seed
    data = _get(f"{CKAN_RES}?id={seed_resource_id}")
    if not data.get("success"):
        raise RuntimeError(f"CKAN resource_show falhou para seed {seed_resource_id}")
    package_id = data["result"]["package_id"]

    # 2. Lista todos os resources do package
    pkg = _get(f"{CKAN_PKG}?id={package_id}")
    if not pkg.get("success"):
        raise RuntimeError(f"CKAN package_show falhou para {package_id}")

    datasets: dict[int, str] = {}
    for res in pkg["result"].get("resources", []):
        texto = res.get("name", "") + " " + (res.get("description") or "")
        m = re.search(r"\b(20\d{2})\b", texto)
        if m:
            datasets[int(m.group(1))] = res["id"]

    if not datasets:
        raise RuntimeError(f"Nenhum ano encontrado no package {package_id}")

    anos = sorted(datasets)
    print(f"    [CKAN] {len(datasets)} anos descobertos: {anos[0]}–{anos[-1]}")
    return datasets

# ─── CKAN paginado ────────────────────────────────────────────────────────────

def _fetch_pagina(dataset_id: str, filtros: dict, offset: int = 0) -> dict:
    params = urllib.parse.urlencode({
        "resource_id": dataset_id,
        "limit":       PAGE_SIZE,
        "offset":      offset,
        "filters":     json.dumps(filtros),
    })
    data = _get(f"{CKAN_SEARCH}?{params}")
    if not data.get("success"):
        raise RuntimeError(f"CKAN erro: {data.get('error')}")
    return data["result"]

def fetch_todas_paginas(dataset_id: str, filtros: dict) -> list[dict]:
    primeira = _fetch_pagina(dataset_id, filtros, 0)
    total    = primeira["total"]
    registros = list(primeira["records"])
    paginas_extras = math.ceil((total - PAGE_SIZE) / PAGE_SIZE) if total > PAGE_SIZE else 0
    for i in range(paginas_extras):
        time.sleep(0.3)
        pagina = _fetch_pagina(dataset_id, filtros, PAGE_SIZE * (i + 1))
        registros.extend(pagina["records"])
    return registros

def _buscar_por_anos(datasets: dict, filtros: dict, label: str) -> list[dict]:
    resultado = []
    entradas  = sorted(datasets.items())
    for i, (ano, did) in enumerate(entradas):
        print(f"    {ano}...", end=" ", flush=True)
        try:
            regs = fetch_todas_paginas(did, filtros)
            resultado.extend(normalizar_registro(r) for r in regs)
            print(f"{len(regs)} registros")
        except Exception as e:
            print(f"erro — {e}")
        if i < len(entradas) - 1:
            time.sleep(1.2)
    return resultado

# ─── Cargas ───────────────────────────────────────────────────────────────────

def buscar_cargas(nome_empresarial: str | None, sigla: str | None = None) -> list[dict]:
    """
    Busca parcelas de carga. Prioriza NOME_EMPRESARIAL (razão social),
    cai para SIGLA_PERFIL_AGENTE se nome não fornecido.
    """
    if nome_empresarial:
        campo  = "NOME_EMPRESARIAL"
        valor  = nome_empresarial.strip().upper()
    elif sigla:
        campo  = "SIGLA_PERFIL_AGENTE"
        valor  = sigla.strip().upper()
    else:
        return []

    print(f"  Cargas ({campo}={valor}):")
    registros = _buscar_por_anos(_datasets_por_ano(SEED_CARGAS), {campo: valor}, "cargas")
    registros.sort(key=lambda r: (r.get("mes_referencia", ""), r.get("sigla_parcela_carga", "")))
    return registros

# ─── Usinas ───────────────────────────────────────────────────────────────────

def buscar_usinas(nome_empresarial: str) -> list[dict]:
    """Busca parcelas de usina (geração) por NOME_EMPRESARIAL."""
    valor = nome_empresarial.strip().upper()
    print(f"  Usinas (NOME_EMPRESARIAL={valor}):")
    registros = _buscar_por_anos(_datasets_por_ano(SEED_USINAS), {"NOME_EMPRESARIAL": valor}, "usinas")
    registros.sort(key=lambda r: (r.get("mes_referencia", ""), r.get("sigla_ativo", "")))
    return registros

# ─── Contabilização ───────────────────────────────────────────────────────────

CAMPOS_NUM_CONTAB = [
    "valor_tm_mcp", "compensacao_mre", "valor_encargo", "valor_ajuste_exposicao",
    "valor_ajuste_alivio_ret", "efeito_contrat_disp", "efeito_contrat_cota_gf",
    "efeito_contrat_nuclear", "ajuste_recontab", "ajuste_mcsd_ex",
    "resultado_financeiro_er", "efeito_ccearq", "efeito_contrat_itaipu",
    "efeito_repasse_risco_hidro", "efeito_desloc_pld_cmo", "resultado_final",
]

def buscar_contabilizacao(nome_empresarial: str) -> list[dict]:
    """Busca contabilização de montante por NOME_EMPRESARIAL."""
    valor = nome_empresarial.strip().upper()
    print(f"  Contabilização (NOME_EMPRESARIAL={valor}):")
    registros = _buscar_por_anos(_datasets_por_ano(SEED_CONTAB), {"NOME_EMPRESARIAL": valor}, "contab")

    for r in registros:
        for campo in CAMPOS_NUM_CONTAB:
            v = r.get(campo)
            if v is not None and v != "":
                try:
                    r[campo] = float(str(v).replace(",", "."))
                except ValueError:
                    r[campo] = None

    registros.sort(key=lambda r: (r.get("mes_referencia", ""), r.get("sigla_perfil_agente", "")))
    return registros

# ─── Download streaming GZIP ──────────────────────────────────────────────────

def _listar_recursos_ckan(dataset_slug: str) -> list[dict]:
    """Retorna lista de {mes, url} do dataset CKAN ordenada por mês."""
    data = _get(f"{CKAN_PKG}?id={dataset_slug}")
    if not data.get("success"):
        raise RuntimeError(f"CKAN erro ao listar {dataset_slug}")
    recursos = []
    for r in data["result"].get("resources", []):
        full = r["name"] + " " + (r.get("description") or "")
        import re
        m = re.search(r"(\d{4})[_\-\/\s](\d{2})(?!\d)", full) or re.search(r"(\d{4})(\d{2})$", r["name"])
        if m:
            recursos.append({"mes": f"{m.group(1)}-{m.group(2)}", "url": r["url"]})
    return sorted(recursos, key=lambda x: x["mes"])

class _PrependStream(io.RawIOBase):
    """Recoloca bytes já lidos no início do stream (para detecção de magic bytes)."""
    def __init__(self, prefix: bytes, source):
        self._head   = io.BytesIO(prefix)
        self._source = source

    def readinto(self, b):
        data = self._head.read(len(b))
        if not data:
            data = self._source.read(len(b))
        if not data:
            return 0
        b[:len(data)] = data
        return len(data)

    def readable(self):
        return True


def _stream_csv_gzip(url: str, processar_linha) -> int:
    """
    Streaming direto HTTP → descompressão GZIP on-the-fly → parse linha a linha.
    Nenhum arquivo temporário é gravado em disco.
    """
    print(f"    {url}")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_DL) as resp:
        # Lê 2 bytes para detectar magic GZIP (0x1F 0x8B)
        peek    = resp.read(2)
        is_gzip = peek == b"\x1f\x8b"
        print(f"    Formato: {'GZIP' if is_gzip else 'plain CSV'}", flush=True)

        # Reconstrói stream com os 2 bytes de volta
        raw = io.BufferedReader(_PrependStream(peek, resp), buffer_size=131072)

        f = (io.TextIOWrapper(gzip.GzipFile(fileobj=raw), encoding="utf-8", errors="replace")
             if is_gzip else
             io.TextIOWrapper(raw, encoding="utf-8", errors="replace"))

        headers = None
        sep     = None
        total   = 0

        for raw_line in f:
            line = raw_line.rstrip("\r\n")
            if not line:
                continue
            if headers is None:
                sep     = ";" if ";" in line else ","
                headers = [h.strip('"').strip() for h in line.split(sep)]
                continue
            vals = [v.strip('"').strip() for v in line.split(sep)]
            row  = {headers[i]: (vals[i] if i < len(vals) else "") for i in range(len(headers))}
            processar_linha(row)
            total += 1
            if total % 500_000 == 0:
                print(f"    {total:,} linhas...", flush=True)

    print(f"    {total:,} linhas processadas")
    return total

# ─── Consumo horário ──────────────────────────────────────────────────────────

def meses_disponiveis_consumo() -> list[str]:
    return [r["mes"] for r in _listar_recursos_ckan(DATASET_CONSUMO_HORARIO)]

def buscar_consumo_horario(
    mes: str,
    agentes_filtro: dict[str, str],  # {sigla_perfil: razao_social_upper}
) -> dict[str, list[dict]]:
    """
    Baixa o CSV de consumo horário do mês UMA VEZ e filtra para todos os agentes.

    agentes_filtro: {sigla_perfil_agente: razao_social_upper_sem_acento}
    Retorna: {sigla: [ {sigla_perfil_agente, mes_referencia, periodo, submercado, consumo_mwh} ]}
    """
    recursos = _listar_recursos_ckan(DATASET_CONSUMO_HORARIO)
    recurso  = next((r for r in recursos if r["mes"] == mes), None)
    if not recurso:
        raise RuntimeError(f"Consumo horário: mês {mes} não disponível. Disponíveis: {[r['mes'] for r in recursos]}")

    print(f"  Consumo horário {mes} — {len(agentes_filtro)} agente(s)")

    # Normaliza razões sociais para comparação
    nomes_norm = {k: remover_acentos(v) for k, v in agentes_filtro.items()}

    agregados: dict[str, dict] = {}  # key → {sigla_perfil_agente, periodo, submercado, consumo_mwh}
    resultados: dict[str, list] = {s: [] for s in agentes_filtro}

    def processar(row: dict):
        sigla_csv  = (row.get("SIGLA_PERFIL_AGENTE") or "").strip().upper()
        nome_csv   = remover_acentos((row.get("NOME_EMPRESARIAL") or "").strip().upper())

        # Encontra qual agente corresponde
        agente_match = None
        for sigla_fil, razao_norm in nomes_norm.items():
            if razao_norm and nome_csv == razao_norm:
                agente_match = sigla_fil
                break
            if not razao_norm and sigla_csv == sigla_fil:
                agente_match = sigla_fil
                break
        if agente_match is None:
            return

        hora_dia = int(row.get("PERIODO_COMERCIALIZACAO") or 0)
        data_str = (row.get("DATA") or "").strip()
        dia_mes  = 1
        if len(data_str) == 10 and data_str[4] == "-":       # YYYY-MM-DD
            dia_mes = int(data_str[8:])
        elif len(data_str) == 10 and data_str[2] == "/":     # DD/MM/YYYY
            dia_mes = int(data_str[:2])
        periodo = (dia_mes - 1) * 24 + hora_dia + 1

        sub_bruto  = (row.get("SUBMERCADO") or "").strip().upper()
        submercado = SUB_MAP.get(sub_bruto, sub_bruto)
        consumo    = float((row.get("CONSUMO_CARGA_ACL") or "0").replace(",", ".") or 0)

        if not periodo or not submercado:
            return

        key = f"{agente_match}|{periodo}|{submercado}"
        if key not in agregados:
            agregados[key] = {
                "agente":             agente_match,
                "mes_referencia":     mes,
                "periodo":            periodo,
                "submercado":         submercado,
                "consumo_mwh":        0.0,
            }
        agregados[key]["consumo_mwh"] += consumo

    _stream_csv_gzip(recurso["url"], processar)

    # Separa por agente
    for key, row in sorted(agregados.items(), key=lambda x: x[1]["periodo"]):
        resultados[row["agente"]].append(row)

    for sigla, rows in resultados.items():
        print(f"    {sigla}: {len(rows)} períodos")

    return resultados

# ─── Geração horária ──────────────────────────────────────────────────────────

def meses_disponiveis_geracao() -> list[str]:
    return [r["mes"] for r in _listar_recursos_ckan(DATASET_GERACAO_HORARIA)]

def buscar_geracao_horaria(
    mes: str,
    agentes_usinas: dict[str, list[str]],  # {sigla_agente: [sigla_usina, ...]}
) -> dict[str, list[dict]]:
    """
    Baixa o CSV de geração horária do mês UMA VEZ e filtra pelas usinas de cada agente.

    agentes_usinas: {sigla_agente: [sigla_parcela_usina, ...]}
    Retorna: {sigla_agente: [{agente, mes_referencia, sigla_usina, periodo, submercado, geracao_mwmed}]}
    """
    if not agentes_usinas:
        return {}

    recursos = _listar_recursos_ckan(DATASET_GERACAO_HORARIA)
    recurso  = next((r for r in recursos if r["mes"] == mes), None)
    if not recurso:
        raise RuntimeError(f"Geração horária: mês {mes} não disponível.")

    # Mapeia cada sigla de usina → agente dono
    usina_para_agente: dict[str, str] = {}
    for agente, usinas in agentes_usinas.items():
        for u in usinas:
            usina_para_agente[u.strip().upper()] = agente

    total_usinas = len(usina_para_agente)
    print(f"  Geração horária {mes} — {len(agentes_usinas)} agente(s), {total_usinas} usina(s)")

    agregados: dict[str, dict] = {}
    resultados: dict[str, list] = {a: [] for a in agentes_usinas}

    def processar(row: dict):
        sigla_usina = (row.get("SIGLA_PARCELA_USINA") or "").strip().upper()
        agente_m    = usina_para_agente.get(sigla_usina)
        if not agente_m:
            return

        hora_dia = int(row.get("PERIODO_COMERCIALIZACAO") or 0)
        data_str = (row.get("DATA") or "").strip()
        dia_mes  = 1
        if len(data_str) == 10 and data_str[4] == "-":
            dia_mes = int(data_str[8:])
        elif len(data_str) == 10 and data_str[2] == "/":
            dia_mes = int(data_str[:2])
        periodo = (dia_mes - 1) * 24 + hora_dia + 1

        sub_bruto  = (row.get("SUBMERCADO") or "").strip().upper()
        submercado = SUB_MAP.get(sub_bruto, sub_bruto)
        geracao    = float((row.get("GERACAO_CENTRO_GRAVIDADE") or "0").replace(",", ".") or 0)

        if not periodo or not submercado:
            return

        key = f"{agente_m}|{sigla_usina}|{periodo}|{submercado}"
        if key not in agregados:
            agregados[key] = {
                "agente":         agente_m,
                "mes_referencia": mes,
                "sigla_usina":    sigla_usina,
                "periodo":        periodo,
                "submercado":     submercado,
                "geracao_mwmed":  0.0,
            }
        agregados[key]["geracao_mwmed"] += geracao

    _stream_csv_gzip(recurso["url"], processar)

    for row in sorted(agregados.values(), key=lambda r: r["periodo"]):
        resultados[row["agente"]].append(row)

    for agente, rows in resultados.items():
        print(f"    {agente}: {len(rows)} períodos")

    return resultados
