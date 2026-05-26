# Power BI — Tema e Gráficos CCEE Monitor

Os arquivos ficam em `powerbi/`.

---

## Tema visual (`tema-ccee-monitor.json`)

Replica a paleta de cores, fontes e estilos do CCEE Monitor dentro do Power BI.

### Como aplicar

1. Abra o relatório no Power BI Desktop
2. Menu `Exibição → Temas → Procurar temas`
3. Selecione `powerbi/tema-ccee-monitor.json`

O tema define automaticamente:

| Elemento | Estilo |
|---|---|
| Fundo da página | `#f8fafc` (mesmo do app) |
| Cards e visuais | Branco, sem borda, sem sombra |
| Tabelas | Header cinza sutil, linhas alternadas, grid horizontal |
| Gráficos | Eixos discretos, grid sutil, sem grid vertical |
| Fonte | Segoe UI em todo o relatório |
| Cores de dados | Azul `#2563eb`, verde `#16a34a`, laranja `#ea580c`... |
| KPI positivo/negativo | Verde `#16a34a` / vermelho `#dc2626` |

---

## Gráfico de curva de carga (`grafico-curva-carga.json`)

Template Vega-Lite para o visual **Deneb** — gráfico de área suave com múltiplos perfis, preenchimento com gradiente e linha de referência tracejada em 100%.

### Pré-requisito: instalar o Deneb

1. Power BI Desktop → `Inserir → Mais visuais → AppSource`
2. Buscar **Deneb** → Adicionar (gratuito)

### Como usar o template

1. Adicione o visual Deneb na página
2. Arraste os campos para o visual:

| Placeholder no JSON | Coluna esperada | Tipo |
|---|---|---|
| `__hora__` | Hora do dia (ex: `01`, `02`... `24`) | Ordinal |
| `__valor__` | Valor em pu entre 0 e 1 | Numérico |
| `__perfil__` | Nome do perfil ou agente | Texto |

3. Clique em **Editar** no visual Deneb
4. Substitua o conteúdo pelo JSON de `powerbi/grafico-curva-carga.json`
5. Troque os placeholders pelos nomes reais das suas colunas:
   - `__hora__` → nome da coluna de hora
   - `__valor__` → nome da coluna de valor
   - `__perfil__` → nome da coluna de perfil

### O que o template inclui

- Curvas suaves (`interpolate: monotone`)
- Área preenchida com opacidade sutil (0.08)
- Linha tracejada de referência em 100%
- Tooltip com perfil, hora e valor formatado em %
- Legenda horizontal no topo com cores da paleta CCEE Monitor
- Eixo Y em formato percentual, eixo X com sufixo `h`
- Fundo branco, grid discreto — compatível com o tema aplicado

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
