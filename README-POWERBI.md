# CCEE Monitor — Guia de Replicação em Power BI

Este guia descreve como replicar o CCEE Monitor (sistema web Node.js + PostgreSQL + React) inteiramente dentro do **Power BI Desktop**, usando arquivos CSV como fonte de dados.

---

## Sumário

1. [Visão geral da conversão](#1-visão-geral-da-conversão)
2. [Pré-requisitos](#2-pré-requisitos)
3. [Exportar dados do PostgreSQL para CSV](#3-exportar-dados-do-postgresql-para-csv)
4. [Estrutura dos arquivos CSV](#4-estrutura-dos-arquivos-csv)
5. [Configurar o modelo no Power BI Desktop](#5-configurar-o-modelo-no-power-bi-desktop)
6. [Power Query — transformações](#6-power-query--transformações)
7. [Medidas DAX — cálculos equivalentes](#7-medidas-dax--cálculos-equivalentes)
8. [Visuais — reproduzindo o dashboard](#8-visuais--reproduzindo-o-dashboard)
9. [Atualização de dados](#9-atualização-de-dados)
10. [Limitações conhecidas](#10-limitações-conhecidas)

---

## 1. Visão geral da conversão

| Componente original | Equivalente Power BI |
|---|---|
| PostgreSQL (banco relacional) | Arquivos CSV + modelo Power BI |
| Node.js / Express (API) | Power Query (M) + Python opcional |
| React + Recharts (frontend) | Relatório Power BI Desktop |
| Cálculos JS (`calcMcpRsMwh`, etc.) | Medidas DAX |
| Filtros e drill-down de mês/agente | Segmentações de dados (Slicers) |
| Cards de métricas | Visual "Cartão" ou "Cartão de múltiplas linhas" |
| Gráficos históricos (line chart) | Visual "Gráfico de linhas" |
| Curva horária (area chart) | Visual "Gráfico de área" |
| Tabela de cargas / usinas | Visual "Tabela" |

---

## 2. Pré-requisitos

- **Power BI Desktop** (gratuito) — [download](https://powerbi.microsoft.com/pt-br/desktop/)
- **Python 3.10+** (opcional, para scripts de exportação e atualização automática)
  - Bibliotecas: `psycopg2`, `pandas` → `pip install psycopg2-binary pandas`
- Acesso ao banco PostgreSQL do projeto (string de conexão `DATABASE_URL`)
- Ou: arquivos CSV já exportados (seção 3)

---

## 3. Exportar dados do PostgreSQL para CSV

### Opção A — Script Python (recomendado)

Crie um arquivo `exportar_csv.py` na raiz do projeto:

```python
import os
import pandas as pd
import psycopg2
from sqlalchemy import create_engine

DATABASE_URL = os.environ["DATABASE_URL"]
engine = create_engine(DATABASE_URL.replace("postgres://", "postgresql://"))

TABELAS = [
    "ccee_agentes",
    "ccee_dados",
    "ccee_cargas",
    "ccee_usinas",
    "ccee_modulacao",
    "ccee_modulacao_geracao",
    "ccee_contabilizacao",
    "ccee_consumo_horario",   # grande (~136 MB) — omita se não precisar das curvas horárias
    "ccee_geracao_horaria",   # grande (~112 MB) — idem
]

os.makedirs("csv_export", exist_ok=True)

for tabela in TABELAS:
    print(f"Exportando {tabela}...")
    df = pd.read_sql(f"SELECT * FROM {tabela}", engine)
    df.to_csv(f"csv_export/{tabela}.csv", index=False, sep=";", decimal=",")
    print(f"  {len(df)} linhas → csv_export/{tabela}.csv")

print("Concluído.")
```

Execute:
```bash
set DATABASE_URL=sua_string_de_conexao
python exportar_csv.py
```

### Opção B — psql direto

```sql
\COPY ccee_agentes      TO 'csv_export/ccee_agentes.csv'      CSV HEADER DELIMITER ';';
\COPY ccee_dados        TO 'csv_export/ccee_dados.csv'        CSV HEADER DELIMITER ';';
\COPY ccee_cargas       TO 'csv_export/ccee_cargas.csv'       CSV HEADER DELIMITER ';';
\COPY ccee_usinas       TO 'csv_export/ccee_usinas.csv'       CSV HEADER DELIMITER ';';
\COPY ccee_modulacao    TO 'csv_export/ccee_modulacao.csv'    CSV HEADER DELIMITER ';';
\COPY ccee_contabilizacao TO 'csv_export/ccee_contabilizacao.csv' CSV HEADER DELIMITER ';';
```

---

## 4. Estrutura dos arquivos CSV

### `ccee_agentes.csv`
| Coluna | Tipo | Descrição |
|---|---|---|
| agente | texto | Identificador único (chave primária) |
| razao_social | texto | Razão social completa |
| sigla | texto | Sigla do agente |
| cnpj | texto | CNPJ formatado |
| classe | texto | Consumidor Livre, Gerador, Comercializador, etc. |
| situacao | texto | Aderido, Desligado, etc. |
| capital_social | número | Capital social em R$ |

### `ccee_dados.csv`
| Coluna | Tipo | Descrição |
|---|---|---|
| agente | texto | FK → ccee_agentes |
| mes | texto | Formato `YYYY-MM` |
| consumo | número | Consumo em MWm |
| compra | número | Compra em MWm |
| mcp | número | Custo MCP total em R$ |
| resultado | número | Resultado com ajustes em R$ |
| resultado_mcp | número | Resultado final em R$ |
| balanco_energetico | número | Balanço energético em MWm |
| geracao | número | Geração em MWm (nulo para consumidores) |
| venda | número | Venda em MWm |
| consumo_geracao | número | Consumo da geração em MWm |
| mcp_rs_mwh | número | Custo MCP por MWh em R$/MWh (calculado) |
| mre_mais | número | MRE+ em MWm |
| mre_menos | número | MRE- em MWm |

### `ccee_cargas.csv`
Parcelas de carga por agente/mês. Colunas principais:
`agente`, `mes_referencia`, `sigla_parcela_carga`, `cidade`, `estado_uf`, `ramo_atividade`, `submercado`, `consumo_acl`, `consumo_total`

### `ccee_modulacao.csv`
Resultado da modulação horária por submercado:
`agente`, `mes_referencia`, `submercado`, `consumo_total_mwh`, `n_horas`, `soma_curva_rs`, `soma_flat_rs`, `custo_modulacao_rs_mwh`

### `ccee_consumo_horario.csv` *(opcional — arquivo grande)*
`agente`, `mes_referencia`, `periodo` (1–744), `submercado`, `consumo_mwh`

---

## 5. Configurar o modelo no Power BI Desktop

### 5.1 Importar os CSVs

1. Abrir **Power BI Desktop**
2. **Início → Obter dados → Texto/CSV**
3. Importar cada arquivo da pasta `csv_export/`
4. Na janela de pré-visualização, clicar em **Transformar dados** (não "Carregar")

### 5.2 Relacionamentos entre tabelas

No **Editor de Modelo** (ícone de diagrama na barra lateral), criar os relacionamentos:

| De | Para | Tipo |
|---|---|---|
| `ccee_dados[agente]` | `ccee_agentes[agente]` | Muitos para um |
| `ccee_cargas[agente]` | `ccee_agentes[agente]` | Muitos para um |
| `ccee_cargas[mes_referencia]` | `ccee_dados[mes]` | Muitos para muitos* |
| `ccee_modulacao[agente]` | `ccee_agentes[agente]` | Muitos para um |
| `ccee_usinas[agente]` | `ccee_agentes[agente]` | Muitos para um |

> *Para evitar ambiguidade, use uma tabela de calendário como ponte (seção 6.1).

### 5.3 Tabela de calendário (obrigatória)

Criar via DAX em **Modelagem → Nova tabela**:

```dax
Calendario =
ADDCOLUMNS(
    CALENDAR(DATE(2024,1,1), DATE(2027,12,31)),
    "Ano",          YEAR([Date]),
    "Mes",          MONTH([Date]),
    "MesAno",       FORMAT([Date], "YYYY-MM"),
    "MesNome",      FORMAT([Date], "MMM/YY"),
    "Trimestre",    "T" & QUARTER([Date]) & "/" & YEAR([Date]),
    "Ordem",        YEAR([Date]) * 100 + MONTH([Date])
)
```

Relacionar:
- `Calendario[MesAno]` → `ccee_dados[mes]` (muitos para um)
- `Calendario[MesAno]` → `ccee_modulacao[mes_referencia]` (muitos para um)
- `Calendario[MesAno]` → `ccee_cargas[mes_referencia]` (muitos para um)

---

## 6. Power Query — transformações

No **Editor do Power Query (M)**, aplicar as seguintes transformações após importar os CSVs:

### 6.1 `ccee_dados` — tipos e coluna de data

```m
let
    Fonte = Csv.Document(File.Contents("csv_export\ccee_dados.csv"),
                [Delimiter=";", Columns=15, Encoding=65001, QuoteStyle=QuoteStyle.None]),
    Cabecalho = Table.PromoteHeaders(Fonte),
    Tipos = Table.TransformColumnTypes(Cabecalho, {
        {"agente",             type text},
        {"mes",                type text},
        {"consumo",            type number},
        {"compra",             type number},
        {"mcp",                type number},
        {"resultado",          type number},
        {"resultado_mcp",      type number},
        {"balanco_energetico", type number},
        {"geracao",            type number},
        {"venda",              type number},
        {"consumo_geracao",    type number},
        {"mcp_rs_mwh",         type number},
        {"mre_mais",           type number},
        {"mre_menos",          type number}
    }),
    -- Colunas auxiliares de data
    ComAno = Table.AddColumn(Tipos, "Ano",  each Number.From(Text.Start([mes], 4))),
    ComMes = Table.AddColumn(ComAno, "NumMes", each Number.From(Text.End([mes], 2))),
    -- Horas do mês (para cálculo de MWh)
    ComHoras = Table.AddColumn(ComMes, "HorasDoMes", each
        Date.Day(Date.EndOfMonth(#date([Ano], [NumMes], 1))) * 24
    )
in
    ComHoras
```

### 6.2 `ccee_agentes` — tipos

```m
let
    Fonte    = Csv.Document(File.Contents("csv_export\ccee_agentes.csv"),
                [Delimiter=";", Encoding=65001]),
    Cabecalho = Table.PromoteHeaders(Fonte),
    Tipos    = Table.TransformColumnTypes(Cabecalho, {
        {"agente",        type text},
        {"razao_social",  type text},
        {"sigla",         type text},
        {"cnpj",          type text},
        {"classe",        type text},
        {"situacao",      type text},
        {"capital_social",type number}
    })
in
    Tipos
```

### 6.3 `ccee_modulacao` — tipos

```m
let
    Fonte     = Csv.Document(File.Contents("csv_export\ccee_modulacao.csv"),
                 [Delimiter=";", Encoding=65001]),
    Cabecalho = Table.PromoteHeaders(Fonte),
    Tipos     = Table.TransformColumnTypes(Cabecalho, {
        {"agente",                 type text},
        {"mes_referencia",         type text},
        {"submercado",             type text},
        {"consumo_total_mwh",      type number},
        {"n_horas",                type number},
        {"soma_curva_rs",          type number},
        {"soma_flat_rs",           type number},
        {"custo_modulacao_rs_mwh", type number}
    })
in
    Tipos
```

### 6.4 `ccee_consumo_horario` — pivotamento para curva horária *(opcional)*

```m
let
    Fonte     = Csv.Document(File.Contents("csv_export\ccee_consumo_horario.csv"),
                 [Delimiter=";", Encoding=65001]),
    Cabecalho = Table.PromoteHeaders(Fonte),
    Tipos     = Table.TransformColumnTypes(Cabecalho, {
        {"agente",         type text},
        {"mes_referencia", type text},
        {"periodo",        Int64.Type},
        {"submercado",     type text},
        {"consumo_mwh",    type number}
    }),
    -- Adiciona hora do dia (1–24) e dia do mês
    ComDia  = Table.AddColumn(Tipos,  "Dia",  each Number.IntegerDivide([periodo]-1, 24) + 1),
    ComHora = Table.AddColumn(ComDia, "Hora", each Number.Mod([periodo]-1, 24) + 1)
in
    ComHora
```

---

## 7. Medidas DAX — cálculos equivalentes

Criar as medidas abaixo em **Modelagem → Nova medida** (vincular à tabela `ccee_dados`):

### 7.1 Métricas básicas do mês selecionado

```dax
[Consumo MWm] =
SUM(ccee_dados[consumo])

[Compra MWm] =
SUM(ccee_dados[compra])

[MCP Total R$] =
SUM(ccee_dados[mcp])

[Resultado R$] =
SUM(ccee_dados[resultado])

[Resultado Final R$] =
SUM(ccee_dados[resultado_mcp])

[Balanço Energético MWm] =
SUM(ccee_dados[balanco_energetico])

[Geração MWm] =
SUM(ccee_dados[geracao])

[MRE+ MWm] =
SUM(ccee_dados[mre_mais])

[MRE- MWm] =
SUM(ccee_dados[mre_menos])
```

### 7.2 Custo MCP por MWh (equivalente ao `calcMcpRsMwh` do Node.js)

```dax
[Custo MCP R$/MWh] =
VAR TotalMCP     = SUM(ccee_dados[mcp])
VAR TotalConsumo = SUM(ccee_dados[consumo])
VAR TotalBalanco = SUM(ccee_dados[balanco_energetico])

-- Horas do mês (via tabela Calendario ou cálculo direto)
VAR MesAtual = MAX(ccee_dados[mes])
VAR Ano      = VALUE(LEFT(MesAtual, 4))
VAR NumMes   = VALUE(RIGHT(MesAtual, 2))
VAR HorasMes = DAY(EOMONTH(DATE(Ano, NumMes, 1), 0)) * 24

VAR Divisor  =
    IF(TotalConsumo > 0,
        TotalConsumo * HorasMes,                         -- usa consumo
        IF(TotalBalanco <> 0, TotalBalanco * HorasMes, BLANK()) -- fallback balanço
    )

RETURN
    IF(NOT ISBLANK(Divisor), DIVIDE(TotalMCP, Divisor))
```

### 7.3 Label dinâmico Ganho/Custo MCP

```dax
[Label Custo MCP] =
VAR v = [Custo MCP R$/MWh]
RETURN
    IF(ISBLANK(v), "MCP R$/MWh",
        IF(v >= 0, "Ganho MCP", "Custo MCP"))
```

### 7.4 Custo de modulação consolidado

```dax
[Custo Modulação R$/MWh] =
AVERAGEX(
    ccee_modulacao,
    ccee_modulacao[custo_modulacao_rs_mwh]
)

[Ganho Modulação R$] =
SUMX(ccee_modulacao,
    ccee_modulacao[soma_curva_rs] - ccee_modulacao[soma_flat_rs]
)
```

### 7.5 Comparativo MWh (sazonalização)

```dax
[Consumo MWh] =
SUMX(
    ccee_dados,
    VAR Ano      = VALUE(LEFT(ccee_dados[mes], 4))
    VAR NumMes   = VALUE(RIGHT(ccee_dados[mes], 2))
    VAR HorasMes = DAY(EOMONTH(DATE(Ano, NumMes, 1), 0)) * 24
    RETURN ccee_dados[consumo] * HorasMes
)

[Contrato Flat MWh] =
[Consumo MWh]  -- substitua pela medida de contrato quando disponível
```

### 7.6 Variação mês a mês

```dax
[MCP Mês Anterior R$] =
CALCULATE(
    [MCP Total R$],
    PREVIOUSMONTH(Calendario[Date])
)

[Variação MCP %] =
DIVIDE([MCP Total R$] - [MCP Mês Anterior R$], ABS([MCP Mês Anterior R$]))
```

---

## 8. Visuais — reproduzindo o dashboard

### 8.1 Layout geral da página

Criar **3 páginas** no relatório:

| Página | Equivalente |
|---|---|
| **Resumo** | Dashboard principal (`/inteligencia/[agente]`) |
| **Cargas** | Tabela de parcelas de carga |
| **Modulação** | Resultado de modulação horária |

### 8.2 Segmentações (Slicers)

Adicionar no topo de cada página:

- **Slicer de agente**: campo `ccee_agentes[agente]` — estilo "Lista suspensa"
- **Slicer de mês**: campo `Calendario[MesAno]` — estilo "Lista suspensa" ou "Entre" para intervalo
- **Slicer de classe**: campo `ccee_agentes[classe]` — estilo "Lista"

### 8.3 Cards de métricas (equivalente ao metrics-grid)

Adicionar **Cartão** para cada medida (organizar em grade 3×3):

| Card | Medida | Formato |
|---|---|---|
| Consumo | `[Consumo MWm]` | `#,##0.0 "MWm"` |
| Compra | `[Compra MWm]` | `#,##0.0 "MWm"` |
| MCP | `[MCP Total R$]` | `R$ #,##0` |
| Resultado | `[Resultado R$]` | `R$ #,##0` |
| Resultado Final | `[Resultado Final R$]` | `R$ #,##0` |
| Balanço | `[Balanço Energético MWm]` | `#,##0.0 "MWm"` |
| Custo MCP | `[Custo MCP R$/MWh]` | `#,##0.0000 "R$/MWh"` |
| MRE+ | `[MRE+ MWm]` | `#,##0.0 "MWm"` |
| MRE- | `[MRE- MWm]` | `#,##0.0 "MWm"` |

> **Formatação condicional nos cards**: em Formatar visual → Cor da fonte → Formatação condicional → usar regra: se valor < 0 → vermelho; se valor > 0 e campo = custo → laranja.

### 8.4 Gráfico histórico — linha do tempo (equivalente ao LineChart)

**Visual**: Gráfico de linhas

| Campo | Configuração |
|---|---|
| Eixo X | `Calendario[MesAno]` (ordenar por `Calendario[Ordem]`) |
| Valores | `[Consumo MWm]`, `[Compra MWm]` |
| Legenda | automática |

Criar páginas separadas ou abas de visual para cada grupo do original:

- **Consumo e Compra**: `[Consumo MWm]` + `[Compra MWm]`
- **MCP**: `[MCP Total R$]`
- **Custo MCP por MWh**: `[Custo MCP R$/MWh]`
- **Balanço Energético**: `[Balanço Energético MWm]`
- **Resultado**: `[Resultado R$]` + `[Resultado Final R$]`

> Dica: use o visual **"Gráfico de linhas e colunas empilhadas"** para combinar R$ e MWm no mesmo gráfico com dois eixos Y.

### 8.5 Curva de carga horária (equivalente ao AreaChart)

**Visual**: Gráfico de área

| Campo | Configuração |
|---|---|
| Eixo X | `ccee_consumo_horario[periodo]` (1–744) |
| Valores | `SUM(ccee_consumo_horario[consumo_mwh])` |
| Legenda | `ccee_consumo_horario[submercado]` |

Adicionar slicer de `mes_referencia` específico para esse visual.

### 8.6 Tabela de parcelas de carga

**Visual**: Tabela

Colunas:
`sigla_parcela_carga`, `nome_empresarial`, `cidade`, `estado_uf`, `submercado`, `ramo_atividade`, `consumo_acl`, `consumo_total`

Adicionar **Total** na linha de rodapé (configuração nativa do visual Tabela).

### 8.7 Tabela de modulação

**Visual**: Tabela ou Matriz

| Linha | `mes_referencia` |
| Coluna | `submercado` |
| Valores | `[custo_modulacao_rs_mwh]` |

---

## 9. Atualização de dados

### Opção A — Atualização manual (mais simples)

1. Executar `python exportar_csv.py` para gerar CSVs atualizados
2. No Power BI Desktop: **Início → Atualizar**

### Opção B — Atualização automática com Power BI Service

1. Publicar o relatório no **Power BI Service** (conta Pro ou Premium)
2. Configurar **Gateway de dados local** apontando para a pasta dos CSVs
3. Agendar atualização diária no Service

### Opção C — Script Python agendado (Windows Task Scheduler)

Criar `atualizar.bat`:

```bat
@echo off
set DATABASE_URL=sua_string_aqui
python exportar_csv.py
echo Dados atualizados em %date% %time% >> log_atualizacao.txt
```

Agendar no **Agendador de Tarefas do Windows** para rodar diariamente.

---

## 10. Limitações conhecidas

| Recurso original | Limitação no Power BI |
|---|---|
| Dashboard em tempo real (polling 5s) | Power BI atualiza no mínimo a cada hora (Service) ou manualmente |
| Múltiplos agentes simultâneos | Usar slicer — um agente por vez na seleção |
| Download automático CCEE (Node.js) | Requer script Python externo ou Power Query com credenciais |
| Modulação calculada automaticamente | Precisa exportar `ccee_modulacao` já calculada do sistema original |
| Curva horária interativa (hover por hora) | Tooltip básico no Power BI; não tem o detalhamento do React |
| Links clicáveis entre páginas | Usar botões com ação "Navegação de página" |

---

## Arquivos necessários (resumo)

```
csv_export/
├── ccee_agentes.csv          (~57 linhas)
├── ccee_dados.csv            (~1.267 linhas)
├── ccee_cargas.csv           (~13.933 linhas)
├── ccee_usinas.csv
├── ccee_modulacao.csv        (~900 linhas)
├── ccee_modulacao_geracao.csv
├── ccee_contabilizacao.csv
├── ccee_consumo_horario.csv  (opcional — 136 MB)
└── ccee_geracao_horaria.csv  (opcional — 112 MB)
```

---

*Gerado a partir do projeto [CCEE Monitor](https://github.com/matheusgnreis/CCEE) — maio/2026*
