# CCEE Monitor — Power BI via Python

Guia para buscar dados de agentes CCEE via API, salvar em CSV e visualizar no Power BI Desktop.  
Não requer banco de dados — tudo fica em arquivos locais.

---

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Pré-requisitos](#2-pré-requisitos)
3. [Configuração inicial](#3-configuração-inicial)
4. [Como usar os scripts Python](#4-como-usar-os-scripts-python)
5. [Estrutura dos arquivos CSV gerados](#5-estrutura-dos-arquivos-csv-gerados)
6. [Configurar o modelo no Power BI Desktop](#6-configurar-o-modelo-no-power-bi-desktop)
7. [Power Query — transformações](#7-power-query--transformações)
8. [Medidas DAX — cálculos equivalentes](#8-medidas-dax--cálculos-equivalentes)
9. [Visuais — reproduzindo o dashboard](#9-visuais--reproduzindo-o-dashboard)
10. [Atualização agendada](#10-atualização-agendada)
11. [Tema visual CCEE Monitor](#11-tema-visual-ccee-monitor)
12. [Gráfico de curva de carga (Deneb)](#12-gráfico-de-curva-de-carga-deneb)
13. [Scripts disponíveis](#13-scripts-disponíveis)

---

## 1. Visão geral

```
agentes.txt          → lista de agentes desejados
       ↓
buscar_dados.py      → chama a API para cada agente
       ↓
csv_export/
├── ccee_dados.csv          ← série histórica mensal
├── ccee_cargas.csv         ← parcelas de carga
├── ccee_modulacao.csv      ← resultado de modulação horária
└── nao_encontrados.csv     ← agentes não encontrados (para reprocessar)
       ↓
Power BI Desktop     → importa os CSVs e monta o relatório
```

**Fluxo de agente não encontrado:**
```
nao_encontrados.csv
       ↓
reprocessar_nao_encontrados.py   ← tenta novamente
       ↓
se encontrado → move para ccee_dados.csv
se ainda falha → permanece em nao_encontrados.csv
```

---

## 2. Pré-requisitos

- **Python 3.10+** — [download](https://www.python.org/downloads/)
  - Sem dependências externas — usa apenas bibliotecas padrão (`json`, `csv`, `urllib`, `calendar`)
- **Power BI Desktop** (gratuito) — [download](https://powerbi.microsoft.com/pt-br/desktop/)

> Os scripts chamam diretamente o Power BI da CCEE e não dependem de nenhum servidor ou API intermediária.

---

## 3. Configuração inicial

### 3.1 Clonar / baixar os scripts

```bash
# Se tiver acesso ao repositório:
git clone https://github.com/matheusgnreis/CCEE.git
cd CCEE/scripts-powerbi

# Ou apenas baixar a pasta scripts-powerbi/
```

### 3.2 Descobrir agentes automaticamente (recomendado)

Em vez de manter `agentes.txt` manualmente, use o script de descoberta:

```bash
# Descobre todos os agentes da CCEE, filtra Comercializadores e gera agentes.txt
python descobrir_agentes.py

# Também salva agentes_info.csv com classe, CNPJ, situação de cada um
python descobrir_agentes.py --salvar-info

# Saída em arquivo diferente
python descobrir_agentes.py --saida minha_lista.txt
```

O script:
1. Consulta a **contabilização CKAN** para listar todos os agentes do mercado
2. Para cada agente, chama o **Power BI** (só a query de metadados) para obter a classe
3. **Exclui automaticamente Comercializadores**
4. Gera `agentes.txt` pronto para uso no `buscar_dados.py`

> Tempo estimado: ~2,5s por agente (rate limit Power BI). Para ~200 agentes ≈ 8 minutos.

### 3.3 Montar a lista de agentes manualmente (alternativa)

Editar `agentes.txt` — um agente por linha, exatamente como aparece na CCEE:

```text
# Linhas com # são ignoradas
AXIA NORDESTE
AXIA SUDESTE
CEMIG GERA CAMARGOS CONV
REVAL SERRAS APE
```

> **Dica:** O nome do agente é case-insensitive na API — ela normaliza automaticamente.

---

## 4. Como usar os scripts Python

### 4.1 Busca principal

```bash
# Busca Power BI + cargas + usinas + contabilização (mês mais recente)
python buscar_dados.py

# Inclui também consumo horário e geração horária (arquivos ~400MB por mês)
python buscar_dados.py --horario

# Mês específico
python buscar_dados.py --mes 2026-03

# Só Power BI, sem CKAN (mais rápido)
python buscar_dados.py --sem-ckan

# Acumular nos CSVs existentes sem sobrescrever
python buscar_dados.py --modo a
```

**CSVs gerados:**

| Arquivo | Fonte | Conteúdo |
|---|---|---|
| `ccee_dados.csv` | Power BI | Série histórica mensal por agente |
| `ccee_cargas.csv` | CKAN | Parcelas de carga |
| `ccee_usinas.csv` | CKAN | Unidades geradoras |
| `ccee_contabilizacao.csv` | CKAN | Contabilização de montante |
| `ccee_consumo_horario.csv` | CKAN GZIP | Consumo horário (só com `--horario`) |
| `ccee_geracao_horaria.csv` | CKAN GZIP | Geração horária (só com `--horario`) |
| `nao_encontrados.csv` | — | Agentes não encontrados para reprocessar |

**Saída no terminal:**
```
[2026-05-08 10:00:00] 4 agentes | API: https://ccee-api.onrender.com
[  1/4] AXIA NORDESTE...     ✅  23 meses | 0 cargas | mês=2026-03
[  2/4] AXIA SUDESTE...      ✅  23 meses | 0 cargas | mês=2026-03
[  3/4] NOME ERRADO...       ⚠  não encontrado — HTTP 404
[  4/4] REVAL SERRAS APE...  ✅  18 meses | 5 cargas | mês=2026-03

Salvando arquivos...
  ccee_dados.csv     → 64 linhas
  ccee_cargas.csv    → 10 linhas
  nao_encontrados.csv → 1 novo registro
```

### 4.2 Pipeline completo (recomendado para exportar tudo)

```bash
cd scripts-powerbi

# Descobre agentes + baixa todos os dados + calcula modulação
python rodar_tudo.py

# Mês específico
python rodar_tudo.py --mes 2025-06

# Pula onboarding Power BI (só consumo + modulação dos agentes já conhecidos)
python rodar_tudo.py --sem-powerbi

# Ignora meses anteriores a uma data
python rodar_tudo.py --primeiro-mes 2025-03
```

O `rodar_tudo.py` faz tudo em sequência:
1. Streama o CKAN para descobrir todos os agentes do mercado
2. Para os novos: busca metadados no Power BI e baixa dados históricos + cargas + usinas + contabilização
3. Baixa consumo horário e geração horária de todos os meses pendentes
4. Calcula e salva a modulação

### 4.3 Reprocessar não encontrados

Após verificar os nomes corretos em `nao_encontrados.csv`:

```bash
# Editar nao_encontrados.csv com o nome corrigido, depois:
python reprocessar_nao_encontrados.py
```

O script tenta novamente cada agente do arquivo. Os encontrados são movidos para `ccee_dados.csv`; os que permanecem falhando ficam no arquivo.

### 4.4 Atualização em loop (agendada localmente)

```bash
# Roda agora + repete a cada 24 horas
python agendar.py

# A cada 6 horas
python agendar.py --intervalo 6

# Roda uma única vez e sai
python agendar.py --intervalo 0
```

---

## 5. Estrutura dos arquivos CSV gerados

### `ccee_dados.csv` — série histórica mensal

| Coluna | Tipo | Descrição |
|---|---|---|
| agente | texto | Nome do agente |
| mes | texto | `YYYY-MM` |
| consumo | número | Consumo em MWm |
| compra | número | Compra em MWm |
| mcp | número | Custo MCP total em R$ |
| resultado | número | Resultado com ajustes em R$ |
| resultado_mcp | número | Resultado final em R$ |
| balanco_energetico | número | Balanço energético em MWm |
| geracao | número | Geração em MWm (vazio para consumidores) |
| venda | número | Venda em MWm |
| consumo_geracao | número | Consumo da geração em MWm |
| mcp_rs_mwh | número | Custo MCP por MWh em R$/MWh |
| mre_mais | número | MRE+ em MWm |
| mre_menos | número | MRE- em MWm |
| razao_social | texto | Razão social |
| sigla | texto | Sigla |
| cnpj | texto | CNPJ |
| classe | texto | Consumidor Livre, Gerador, etc. |
| situacao | texto | Aderido, Desligado, etc. |
| capital_social | número | Capital social em R$ |

### `ccee_cargas.csv` — parcelas de carga

`agente`, `mes_referencia`, `sigla_parcela_carga`, `nome_empresarial`, `cidade`, `estado_uf`, `ramo_atividade`, `submercado`, `consumo_acl`, `consumo_total`, `capacidade_carga`

### `ccee_modulacao.csv` — modulação horária

`agente`, `mes_referencia`, `submercado`, `consumo_total_mwh`, `n_horas`, `soma_curva_rs`, `soma_flat_rs`, `custo_modulacao_rs_mwh`

### `nao_encontrados.csv` — para reprocessar

| Coluna | Descrição |
|---|---|
| agente | Nome buscado |
| motivo | Motivo da falha (HTTP 404, histórico vazio, etc.) |
| timestamp | Quando ocorreu |
| ultima_tentativa | Última vez que tentou reprocessar |

---

## 6. Configurar o modelo no Power BI Desktop

### 6.1 Importar os CSVs

1. **Início → Obter dados → Texto/CSV**
2. Selecionar `ccee_dados.csv` → **Transformar dados**
3. Repetir para `ccee_cargas.csv` e `ccee_modulacao.csv`

### 6.2 Tabela de calendário

Em **Modelagem → Nova tabela**:

```dax
Calendario =
ADDCOLUMNS(
    CALENDAR(DATE(2024,1,1), DATE(2027,12,31)),
    "Ano",      YEAR([Date]),
    "Mes",      MONTH([Date]),
    "MesAno",   FORMAT([Date], "YYYY-MM"),
    "MesNome",  FORMAT([Date], "MMM/YY"),
    "Ordem",    YEAR([Date]) * 100 + MONTH([Date])
)
```

### 6.3 Relacionamentos

| De | Para | Cardinalidade |
|---|---|---|
| `Calendario[MesAno]` | `ccee_dados[mes]` | 1 para muitos |
| `Calendario[MesAno]` | `ccee_cargas[mes_referencia]` | 1 para muitos |
| `Calendario[MesAno]` | `ccee_modulacao[mes_referencia]` | 1 para muitos |

---

## 7. Power Query — transformações

No **Editor do Power Query**, aplicar após importar:

### `ccee_dados`

```m
let
    Fonte     = Csv.Document(File.Contents("csv_export\ccee_dados.csv"),
                    [Delimiter=";", Encoding=65001]),
    Cabecalho = Table.PromoteHeaders(Fonte),
    Tipos     = Table.TransformColumnTypes(Cabecalho, {
        {"mes",                type text},
        {"consumo",            type number},
        {"compra",             type number},
        {"mcp",                type number},
        {"resultado",          type number},
        {"resultado_mcp",      type number},
        {"balanco_energetico", type number},
        {"geracao",            type number},
        {"venda",              type number},
        {"mcp_rs_mwh",         type number},
        {"mre_mais",           type number},
        {"mre_menos",          type number},
        {"capital_social",     type number}
    })
in
    Tipos
```

### `ccee_cargas`

```m
let
    Fonte     = Csv.Document(File.Contents("csv_export\ccee_cargas.csv"),
                    [Delimiter=";", Encoding=65001]),
    Cabecalho = Table.PromoteHeaders(Fonte),
    Tipos     = Table.TransformColumnTypes(Cabecalho, {
        {"consumo_acl",      type number},
        {"consumo_total",    type number},
        {"capacidade_carga", type number}
    })
in
    Tipos
```

### `ccee_modulacao`

```m
let
    Fonte     = Csv.Document(File.Contents("csv_export\ccee_modulacao.csv"),
                    [Delimiter=";", Encoding=65001]),
    Cabecalho = Table.PromoteHeaders(Fonte),
    Tipos     = Table.TransformColumnTypes(Cabecalho, {
        {"consumo_total_mwh",      type number},
        {"n_horas",                Int64.Type},
        {"soma_curva_rs",          type number},
        {"soma_flat_rs",           type number},
        {"custo_modulacao_rs_mwh", type number}
    })
in
    Tipos
```

---

## 8. Medidas DAX — cálculos equivalentes

### Métricas básicas

```dax
[Consumo MWm]        = SUM(ccee_dados[consumo])
[Compra MWm]         = SUM(ccee_dados[compra])
[MCP Total R$]       = SUM(ccee_dados[mcp])
[Resultado R$]       = SUM(ccee_dados[resultado])
[Resultado Final R$] = SUM(ccee_dados[resultado_mcp])
[Balanço MWm]        = SUM(ccee_dados[balanco_energetico])
[Geração MWm]        = SUM(ccee_dados[geracao])
[MRE+ MWm]           = SUM(ccee_dados[mre_mais])
[MRE- MWm]           = SUM(ccee_dados[mre_menos])
```

### Custo MCP por MWh

```dax
[Custo MCP R$/MWh] =
VAR mcp      = SUM(ccee_dados[mcp])
VAR consumo  = SUM(ccee_dados[consumo])
VAR balanco  = SUM(ccee_dados[balanco_energetico])
VAR mes      = MAX(ccee_dados[mes])
VAR ano      = VALUE(LEFT(mes, 4))
VAR numMes   = VALUE(RIGHT(mes, 2))
VAR horas    = DAY(EOMONTH(DATE(ano, numMes, 1), 0)) * 24
VAR divisor  =
    IF(consumo > 0, consumo * horas,
        IF(balanco <> 0, balanco * horas, BLANK()))
RETURN DIVIDE(mcp, divisor)
```

### Label dinâmico (Ganho / Custo)

```dax
[Label MCP] =
VAR v = [Custo MCP R$/MWh]
RETURN IF(ISBLANK(v), "MCP R$/MWh", IF(v >= 0, "Ganho MCP", "Custo MCP"))
```

### Modulação

```dax
[Custo Modulação R$/MWh] =
AVERAGE(ccee_modulacao[custo_modulacao_rs_mwh])

[Ganho Modulação R$] =
SUMX(ccee_modulacao,
    ccee_modulacao[soma_curva_rs] - ccee_modulacao[soma_flat_rs])
```

### Variação mês a mês

```dax
[MCP Mês Anterior R$] =
CALCULATE([MCP Total R$], PREVIOUSMONTH(Calendario[Date]))

[Variação MCP %] =
DIVIDE([MCP Total R$] - [MCP Mês Anterior R$], ABS([MCP Mês Anterior R$]))
```

---

## 9. Visuais — reproduzindo o dashboard

### Página 1 — Resumo do agente

**Segmentações (topo):**
- `ccee_dados[agente]` — lista suspensa
- `Calendario[MesAno]` — lista suspensa (ordenar por `Ordem`)
- `ccee_dados[classe]` — lista

**Cards (grade 3×3):**

| Card | Medida | Formato |
|---|---|---|
| Consumo | `[Consumo MWm]` | `#,##0.0 "MWm"` |
| Compra | `[Compra MWm]` | `#,##0.0 "MWm"` |
| MCP | `[MCP Total R$]` | `"R$" #,##0` |
| Resultado | `[Resultado R$]` | `"R$" #,##0` |
| Resultado Final | `[Resultado Final R$]` | `"R$" #,##0` |
| Balanço | `[Balanço MWm]` | `#,##0.0 "MWm"` |
| Custo MCP | `[Custo MCP R$/MWh]` | `#,##0.0000 "R$/MWh"` |
| MRE+ | `[MRE+ MWm]` | `#,##0.0 "MWm"` |
| MRE- | `[MRE- MWm]` | `#,##0.0 "MWm"` |

> Formatação condicional: `[Custo MCP R$/MWh]` negativo → fonte laranja; positivo → fonte verde

**Gráficos de linha (histórico):**

| Título | Medidas no eixo Y |
|---|---|
| Consumo e Compra | `[Consumo MWm]` + `[Compra MWm]` |
| MCP | `[MCP Total R$]` |
| Custo MCP por MWh | `[Custo MCP R$/MWh]` |
| Balanço Energético | `[Balanço MWm]` |
| Resultado | `[Resultado R$]` + `[Resultado Final R$]` |
| MRE | `[MRE+ MWm]` + `[MRE- MWm]` |

Eixo X: `Calendario[MesNome]` (ordenar por `Calendario[Ordem]`)

### Página 2 — Cargas

**Tabela** com colunas:
`sigla_parcela_carga`, `nome_empresarial`, `cidade`, `estado_uf`, `submercado`, `ramo_atividade`, `consumo_acl`, `consumo_total`

Segmentações: `mes_referencia`, `estado_uf`, `submercado`

### Página 3 — Modulação

**Matriz:**
- Linhas: `mes_referencia`
- Colunas: `submercado`
- Valores: `[Custo Modulação R$/MWh]`, `[Ganho Modulação R$]`

---

## 10. Atualização agendada

### Opção A — Script em loop (mais simples)

```bash
# Deixa rodando em segundo plano, atualiza a cada 24h
python agendar.py --intervalo 24
```

### Opção B — Windows Task Scheduler

1. Criar `atualizar.bat` na pasta `scripts-powerbi\`:
```bat
@echo off
cd /d %~dp0
python buscar_dados.py --modo w
python reprocessar_nao_encontrados.py
echo Atualizado em %date% %time% >> log_atualizacao.txt
```

2. Abrir **Agendador de Tarefas** → Criar Tarefa Básica
3. Gatilho: diário no horário desejado
4. Ação: executar `atualizar.bat`

### Opção C — Power BI Service (atualização automática do relatório)

1. Publicar o `.pbix` no Power BI Service
2. Configurar **Gateway de dados local** apontando para a pasta `csv_export\`
3. Agendar atualização no Service (mínimo 1×/dia no plano gratuito, 8×/dia no Pro)

---

## 11. Tema visual CCEE Monitor

O arquivo `powerbi/tema-ccee-monitor.json` replica a paleta de cores, fontes e estilos do CCEE Monitor dentro do Power BI.

### Como aplicar

1. Abra o relatório no Power BI Desktop
2. Menu `Exibição → Temas → Procurar temas`
3. Selecione `powerbi/tema-ccee-monitor.json`

O tema define automaticamente:

| Elemento | Estilo |
|---|---|
| Fundo da página | `#f8fafc` (cinza-azulado claro) |
| Cards e visuais | Branco, sem borda, sem sombra |
| Tabelas | Header cinza sutil, linhas alternadas, grid horizontal |
| Gráficos | Eixos discretos, grid sutil, sem grid vertical |
| Fonte | Segoe UI em todo o relatório |
| Cores de dados | Azul `#2563eb`, verde `#16a34a`, laranja `#ea580c`... |
| KPI positivo/negativo | Verde `#16a34a` / vermelho `#dc2626` |

---

## 12. Gráfico de curva de carga (Deneb)

O arquivo `powerbi/grafico-curva-carga.json` é um template Vega-Lite para o visual **Deneb** — gráfico de área suave com múltiplos perfis, preenchimento com gradiente e linha de referência tracejada em 100%.

### Passo 1 — Instalar o Deneb

1. Power BI Desktop → `Inserir → Mais visuais → AppSource`
2. Buscar **Deneb** → clicar em **Adicionar** (gratuito)

### Passo 2 — Adicionar o visual e os dados

1. Clique no ícone do Deneb no painel de visuais para inserir na página
2. Com o visual selecionado, arraste os campos para ele no painel à direita:

| Campo no painel | O que colocar | Tipo esperado |
|---|---|---|
| Campo de hora | Hora do dia (`01`, `02`... `24`) | Ordinal / Texto |
| Campo de valor | Valor em pu entre 0 e 1 | Numérico |
| Campo de perfil | Nome do perfil ou agente | Texto |

### Passo 3 — Aplicar o template

1. Com o visual Deneb selecionado, clique em **Editar** (ícone de lápis no canto do visual)
2. No editor que abrir, apague todo o conteúdo da aba **Especificação**
3. Abra o arquivo `powerbi/grafico-curva-carga.json` em qualquer editor de texto (Bloco de Notas, VS Code, etc.)
4. Copie todo o conteúdo e cole na aba **Especificação** do Deneb
5. Localize as três ocorrências de placeholder e substitua pelos nomes reais das suas colunas:
   - `__hora__` → nome exato da coluna de hora (ex: `Hora`, `hora_dia`)
   - `__valor__` → nome exato da coluna de valor (ex: `Valor`, `pu`)
   - `__perfil__` → nome exato da coluna de perfil (ex: `Perfil`, `nome_perfil`)
6. Clique em **Aplicar**

### O que o template inclui

- Curvas suaves (`interpolate: monotone`) — igual à imagem de referência
- Área preenchida com opacidade sutil (8%) por baixo de cada linha
- Linha tracejada de referência em 100% com rótulo
- Tooltip ao passar o mouse: perfil, hora e valor formatado em %
- Legenda horizontal no topo com as cores da paleta CCEE Monitor
- Eixo Y em formato percentual (0%, 25%, 50%, 75%, 100%)
- Eixo X com sufixo `h` (01h, 03h, 05h...)
- Fundo branco, grid discreto — compatível com o tema da seção 11

### Paleta de cores (ordem das séries)

| # | Cor | Hex |
|---|---|---|
| 1 | Azul | `#2563eb` |
| 2 | Verde | `#16a34a` |
| 3 | Âmbar | `#d97706` |
| 4 | Vermelho | `#dc2626` |
| 5 | Roxo | `#7c3aed` |
| 6 | Ciano | `#0891b2` |
| 7 | Esmeralda | `#059669` |
| 8 | Rosa | `#e11d48` |

---

## 13. Scripts disponíveis

### Python (`scripts-powerbi/`)

| Script | Função |
|---|---|
| `rodar_tudo.py` | Pipeline completo — descobre agentes, baixa todos os dados, calcula modulação |
| `descobrir_agentes.py` | Descobre todos os agentes da CCEE via CKAN + Power BI, exclui Comercializadores, gera `agentes.txt` |
| `buscar_dados.py` | Busca principal — lê `agentes.txt`, salva CSVs |
| `reprocessar_nao_encontrados.py` | Tenta novamente os não encontrados |
| `agendar.py` | Loop de atualização automática |
| `ckan.py` | Módulo interno — cargas, usinas, contabilização, horário |
| `agentes.txt` | Lista de agentes (gerada por `descobrir_agentes.py` ou manual) |

### Node.js (`scripts/`)

| Script | Função |
|---|---|
| `rodar-tudo.js` | Pipeline completo Node.js — descobre, onboarda e processa todos os agentes |
| `descobrir-agentes.js` | Descobre agentes via banco + CKAN + Power BI e gera `agentes.txt` |
| `rodar-modulacao-batch.js` | Baixa consumo/geração (1 arquivo por mês) e calcula modulação para todos ou agentes específicos |

```bash
# Node.js — pipeline completo
node scripts/rodar-tudo.js

# Modulação de todos os agentes do banco
node scripts/rodar-modulacao-batch.js

# Modulação de agentes específicos (sem editar o arquivo)
node scripts/rodar-modulacao-batch.js --agentes "DOCE MINEIRO,PLASCAR,USIMINAS BH AP"

# Descobrir agentes
node scripts/descobrir-agentes.js
node scripts/descobrir-agentes.js --somente-banco
node scripts/descobrir-agentes.js --saida scripts-powerbi/agentes.txt
```

### Fluxo completo recomendado (Python)

```bash
# 1. Descobre todos os agentes (uma vez, ou quando entrar agente novo)
python scripts-powerbi/descobrir_agentes.py --salvar-info

# 2. Baixa todos os dados (financeiro + cargas + usinas + contabilização + modulação)
python scripts-powerbi/rodar_tudo.py

# 3. Reprocessa qualquer um que falhou
python scripts-powerbi/reprocessar_nao_encontrados.py

# 4. Abre csv_export/ no Power BI Desktop e atualiza
```

---

*Projeto [CCEE Monitor](https://github.com/matheusgnreis/CCEE) — maio/2026*
