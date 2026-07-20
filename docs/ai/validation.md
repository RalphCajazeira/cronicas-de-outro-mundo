# Validação, Testes, Commit e Push

## Regra principal

Use comandos reais do projeto. Não invente scripts.

Antes de rodar um script, confira `package.json`, documentação ou instruções do projeto.

## ESLint

Para projetos JavaScript/TypeScript, ESLint é a validação preferida de qualidade de código quando já estiver configurado ou quando a adoção tiver sido autorizada.

Preferir:

```text
eslint.config.js ou eslint.config.mjs
```

Scripts recomendados quando aplicável:

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix"
  }
}
```

Em monorepo, cada pacote pode ter seu próprio `lint`, e a raiz pode orquestrar:

```json
{
  "scripts": {
    "lint": "npm run lint --prefix backend && npm run lint --prefix frontend"
  }
}
```

Em projeto legado, propor a adoção de ESLint em task própria, com regras recomendadas e baixo risco. Endurecer regras em etapas posteriores.

## Validações comuns

Quando existirem:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## Estratégia oficial de testes do backend

O backend possui três níveis complementares:

1. Unitário (`*.test.ts`): schemas, configuração, helpers, services, regras, transformações e erros isolados. Não usa PostgreSQL, Prisma real ou servidor.
2. HTTP (`*.test.ts`): Supertest chama o app Express em memória com repositories injetados ou mockados. Valida middleware, autenticação, parâmetros, status, contratos e erros seguros sem abrir porta.
3. Integração (`*.integration.test.ts`): usa services e repositories reais, Prisma e PostgreSQL local somente para migration, seed, queries, constraints, índices, relações e endpoints completos.

Comandos na raiz:

```bash
npm test
npm run test:unit
npm run test:integration
npm run test:all
```

No backend, `npm run test:watch` observa apenas a suíte rápida e nunca prepara ou reseta banco. `npm test` e `test:unit` executam unitários e HTTP mockado. `test:integration` valida o destino, recria somente `game_gpt_test`, aplica `prisma migrate deploy`, executa o seed e roda a configuração de integração. `test:all` combina as duas camadas.

O contrato ativo também possui testes de JSON/OpenAPI, `operationId`, limite de operações, correspondência com rotas Express, autenticação e idempotência. Para `manageEncounter`, validar ainda as sete variantes Zod, rejeição de campos cruzados, exemplos OpenAPI, limites sob 100 KB, DTO/replay sem dados internos, mapeamento exaustivo de erros, auditoria sentinel e uma integração HTTP mínima contra o adaptador PostgreSQL real. Integração cobre concorrência de chaves, rollback transacional, RLS e revogações condicionais.

### Banco exclusivo e proteções

- `game_gpt_dev` é desenvolvimento; `game_gpt_test` é integração automatizada.
- PostgreSQL local é obrigatório; Docker, Supabase remoto e outros hosts remotos são proibidos nesse fluxo.
- Variáveis opcionais do `.env` ignorado: `TEST_DATABASE_URL`, `TEST_DIRECT_URL` e `TEST_RPG_API_KEY`.
- O helper recusa `NODE_ENV=production`, host não local, nome diferente de `game_gpt_test`, bancos administrativos ou de desenvolvimento, marcadores de Supabase/Render e `TEST_DATABASE_URL` igual a `DATABASE_URL`.
- Erros são seguros e não exibem URL, credencial ou secret.
- A automação usa `prisma migrate deploy`; não usa `db push`, `migrate reset` ou `migrate dev`.

### Regra para features e correções

Toda feature ou correção deve incluir, conforme aplicável, teste unitário da regra, teste HTTP do contrato e teste de integração ao tocar repository, Prisma, migration, constraint ou relação. E2E é reservado a fluxos críticos de frontend. A task só está concluída após os testes correspondentes, lint, typecheck, testes, build e validações adicionais do escopo.

Validação manual de endpoints é exceção para investigar uma falha automatizada específica. O fluxo normal deve usar os scripts versionados.

## Projetos com backend/frontend

Quando existirem scripts por pasta:

```bash
npm run lint --prefix backend
npm run typecheck --prefix backend
npm run test --prefix backend
npm run build --prefix backend

npm run lint --prefix frontend
npm run typecheck --prefix frontend
npm run test --prefix frontend
npm run build --prefix frontend
```

## E2E

Playwright deve ser usado para fluxos críticos, não para tudo.

Antes de rodar E2E, verificar:

- banco de teste;
- fixtures;
- serviços necessários;
- variáveis de ambiente;
- custo de tempo;
- se o escopo da tarefa exige E2E.

### Validação específica da Fase 1M-A

Além dos gates gerais, validar em PostgreSQL local protegido: migration desde banco vazio e com legado, origem/ownership de efeitos, constraint diferida, append-only/RLS/revokes, finalização e cancelamento atômicos, replay, corrida, rollback, cura `DEFEATED → ACTIVE` e carga terminal após mutações posteriores. O contrato deve continuar com 20 operationIds; o DTO e audit não podem conter UUIDs, hashes, snapshots, rolls, effectRefs, recursos históricos, XP, ouro ou loot.

Não usar `db push`, reset, banco remoto, staging ou Preview para essa validação.

## Antes de commit

Nunca commit sem autorização explícita.

Antes de pedir autorização ou preparar commit:

```bash
git status --short
git diff --name-only
git diff --check
```

Depois de autorização:

```bash
git add -A
git status --short
git diff --cached --name-status
git diff --cached --check
git commit -m "mensagem"
```

Depois do commit:

```bash
git rev-parse --short HEAD
git branch --show-current
git show --name-status --format="" HEAD
git status --short
```

## Antes de push

Nunca push sem autorização explícita.

Confirmar:

```bash
git status --short
git branch --show-current
git log -1 --oneline
```

Só fazer push se branch e commit estiverem corretos e working tree estiver limpa.

## O que nunca deve entrar no commit

- `.env` real;
- secrets;
- dumps de banco;
- logs;
- screenshots;
- vídeos;
- uploads locais;
- arquivos temporários;
- artefatos de build não versionados pelo projeto;
- lockfile de outro package manager.
