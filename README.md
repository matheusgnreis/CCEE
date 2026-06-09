# CCEE Monitor

Pipeline de coleta, processamento e visualização de dados de consumo, contabilização e modulação de agentes CCEE.

---

## Rodar local

```bash
npm install
```

### API (Express)
```bash
npm run api
```

### Frontend (Next.js)
```bash
npm run web
```

---

## Setup do banco de dados

### Criar tabelas (banco novo)

```bash
node scripts/criar-banco.js
```

Cria todas as tabelas se não existirem. Seguro rodar múltiplas vezes.

### Recriar do zero (apaga tudo)

```bash
node scripts/criar-banco.js --drop
```

> ⚠ **Destrói todos os dados.** Use para deploy em produção com banco novo ou para reiniciar completamente.

---

## Pipeline principal: `rodar-tudo.js`

Roda o pipeline completo:
1. Streama o arquivo de consumo horário da CKAN → descobre todos os agentes
2. Novos agentes → busca metadata no Power BI → insere em `ccee_agentes`
3. Novos agentes → busca cargas, usinas, contabilização na CKAN → salva no banco
4. Todos os agentes → processa consumo horário, calcula modulação, calcula curva típica

### Uso básico

```bash
node scripts/rodar-tudo.js
```

Processa o **mês mais recente** disponível na CKAN para **todos os agentes**.

---

### Flags disponíveis

#### `--mes YYYY-MM` — processar um mês específico

```bash
node scripts/rodar-tudo.js --mes 2025-03
```

Por padrão usa o mês mais recente disponível no arquivo CKAN.

---

#### `--apenas-agentes "A,B"` — filtrar agentes

```bash
node scripts/rodar-tudo.js --apenas-agentes "MONSANTO"
node scripts/rodar-tudo.js --apenas-agentes "MONSANTO,MONSANTO SEMENTES"
```

Processa **somente** os agentes listados (separados por vírgula). Útil para re-rodar agentes com problema ou testar um agente específico.

---

#### `--apenas-uf UF` — filtrar por estado

```bash
node scripts/rodar-tudo.js --apenas-uf MG
node scripts/rodar-tudo.js --apenas-uf SP,RJ,MG
```

Processa somente agentes que têm pelo menos uma carga no(s) estado(s) informado(s). Aceita múltiplos estados separados por vírgula.

---

#### `--sem-powerbi` — pular onboarding de novos agentes

```bash
node scripts/rodar-tudo.js --sem-powerbi
```

Não busca metadata de novos agentes no Power BI. Útil quando novos agentes não são esperados, ou quando o token Power BI está expirado.

---

#### `--sem-contab` — pular busca de contabilização

```bash
node scripts/rodar-tudo.js --sem-contab
```

Pula a busca de dados de contabilização da CKAN para novos agentes.

---

#### `--sem-perfil` — pular consumo/contrato mensal por perfil

```bash
node scripts/rodar-tudo.js --sem-perfil
```

Pula a busca de consumo mensal por perfil e contratos por perfil.

---

#### `--so-modulacao` — só recalcular modulação (pula fases 2.5/2.6/2.7)

```bash
node scripts/rodar-tudo.js --so-modulacao
node scripts/rodar-tudo.js --so-modulacao --mes 2025-06
```

Pula Power BI, contabilização e perfil. Vai direto para o streaming de consumo e recálculo de modulação. Implica `--sem-powerbi`, `--sem-contab` e `--sem-perfil`.

Útil para recalcular modulação sem re-onboardar agentes (ex: após atualização da lógica de cálculo).

---

#### `--todos-meses` — streama todos os meses disponíveis

```bash
node scripts/rodar-tudo.js --todos-meses
```

Streama todos os arquivos mensais disponíveis na CKAN, em vez de só o mais recente. Útil para carga histórica completa.

---

#### `--salvar-horario` — manter consumo horário no banco após processar

```bash
node scripts/rodar-tudo.js --salvar-horario
```

Por padrão, o pipeline **descarta** `ccee_consumo_horario` e `ccee_consumo_horario_perfil` após calcular modulação e curva típica (economiza espaço em banco limitado).

Com `--salvar-horario`, os dados horários são **mantidos** no banco. Use quando o banco tiver espaço suficiente e você quiser consultar o histórico horário completo.

---

### Combinando flags

```bash
# Re-rodar só os Monsantos para março/2025
node scripts/rodar-tudo.js --apenas-agentes "MONSANTO,MONSANTO SEMENTES" --mes 2025-03

# Carga inicial de MG — primeiro os Monsantos, depois o restante
node scripts/rodar-tudo.js --apenas-agentes "MONSANTO,MONSANTO SEMENTES" --apenas-uf MG
node scripts/rodar-tudo.js --apenas-uf MG

# Carga histórica completa preservando consumo horário
node scripts/rodar-tudo.js --todos-meses --salvar-horario

# Só recalcular modulação de um mês sem re-onboardar nenhum agente
node scripts/rodar-tudo.js --so-modulacao --mes 2025-05
```

---

## Re-rodar agentes específicos: `reset-agentes.js`

Deleta todos os dados de um ou mais agentes do banco e permite re-processá-los do zero. **Não afeta outros agentes.**

```bash
node scripts/reset-agentes.js MONSANTO
node scripts/reset-agentes.js MONSANTO "MONSANTO SEMENTES"
```

Após o reset, rode:

```bash
node scripts/rodar-tudo.js --apenas-agentes "MONSANTO,MONSANTO SEMENTES"
```

### Só criar tabelas (sem deletar dados)

```bash
node scripts/reset-agentes.js --criar-tabela-uc
```

Cria `ccee_consumo_horario_uc` e `ccee_agente_perfis` se não existirem. Útil se você adicionou uma nova tabela a um banco já existente.

---

## Sequência recomendada: deploy em produção (banco novo)

```bash
# 1. Recriar banco do zero
node scripts/criar-banco.js --drop

# 2. Rodar pipeline completo com todos os meses
#    (processo longo — rodar na madrugada)
node scripts/rodar-tudo.js --todos-meses
```

---

## Sequência recomendada: re-processar agentes com problema

```bash
# 1. Resetar os dados do(s) agente(s)
node scripts/reset-agentes.js "MONSANTO SEMENTES"

# 2. Re-rodar só aquele agente
node scripts/rodar-tudo.js --apenas-agentes "MONSANTO SEMENTES"
```

---

## Estrutura de tabelas principais

| Tabela | Conteúdo |
|---|---|
| `ccee_agentes` | Cadastro de agentes (nome, classe, UF) |
| `ccee_agente_perfis` | Mapeamento agente → cod_agente_ccee → cod_perf_agente |
| `ccee_cargas` | Unidades consumidoras (UCs) por agente |
| `ccee_contabilizacao` | Dados de contabilização mensal |
| `ccee_consumo_horario` | Consumo horário agregado por agente *(descartado por padrão após processar)* |
| `ccee_consumo_horario_perfil` | Consumo horário por perfil CCEE *(descartado por padrão após processar)* |
| `ccee_consumo_horario_uc` | Consumo horário por unidade consumidora |
| `ccee_consumo_mensal_perfil` | Consumo mensal agregado por perfil |
| `ccee_contrato_mensal_perfil` | Contratos mensais por perfil |
| `ccee_modulacao` | Custo de modulação calculado por agente/mês |
| `ccee_modulacao_uc` | Custo de modulação por unidade consumidora/mês |
| `ccee_curva_tipica` | Curva típica de consumo por agente |
| `ccee_curva_tipica_perfil` | Curva típica por perfil CCEE (com cod_agente_ccee e cod_perf_agente) |

---

## Variáveis de ambiente (`.env`)

```env
DATABASE_URL=postgres://user:pass@host:5432/dbname
POWERBI_RESOURCE_KEY=...
POWERBI_MODEL_ID=...
API_URL=http://localhost:3001
NEXT_PUBLIC_API_URL=http://localhost:3001
```
