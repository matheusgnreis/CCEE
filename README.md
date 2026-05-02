# CCEE Monitor

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

### Banco de dados
Criar instância Postgres e executar o schema:
```bash
psql $DATABASE_URL -f db/schema.sql
```

### Coletor
```bash
npm run collector
```

## Scripts de dados

### Processar todos os agentes (consumo + modulação + contabilização)
```bash
node scripts/rodar-modulacao-batch.js
```

### Backfill de dados por perfil (rodar uma vez após migração)
```bash
node scripts/backfill-perfil.js
node scripts/rodar-modulacao-batch.js
```

## Variáveis de ambiente

```
DATABASE_URL=postgres://...
API_URL=http://localhost:3001
NEXT_PUBLIC_API_URL=http://localhost:3001
```
