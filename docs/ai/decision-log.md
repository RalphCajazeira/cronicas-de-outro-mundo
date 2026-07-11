# Decision Log

## 2026-07-11 — Reinicialização da plataforma Node

Contexto:
- A arquitetura anterior dependia de GPT Actions, Edge Functions, RPCs e migrations históricas incompletas.

Decisão:
- Arquivar a v1 em `legacy/supabase-gpt-v1/` e iniciar runtime Node.js + TypeScript.
- Usar Express, Zod, PostgreSQL, Prisma Client 7 com `@prisma/adapter-pg` e npm.
- Fazer do Prisma Migrate a única autoridade do novo schema.
- Tratar Supabase apenas como PostgreSQL hospedado e manter acesso privilegiado exclusivo no backend.

Impacto:
- backend: nova API modular, inicialmente somente leitura;
- frontend: fase futura, sempre consumidor da API;
- banco: schema novo não incorpora migrations legadas automaticamente;
- deploy: autenticação, CORS, rate limit e auditoria ainda devem ser decididos;
- testes: Vitest e Supertest sem banco real nos testes HTTP.

Status: implementada

## 2026-07-11 — API GPT v1 e idempotência transacional

Decisão:
- preservar as leituras atuais e adicionar carga de estado, escrita de atores/conteúdo, progressão e eventos sob `/api/v1`;
- exigir `idempotencyKey` nas escritas e persistir chave, hash e resposta na mesma transação Prisma;
- retornar a resposta persistida para repetição idêntica e `409` para reutilização incompatível;
- manter combate avançado, inventário físico e autenticação pública fora desta fase.

Status: implementada localmente, ainda sem commit/deploy

## 2026-07-11 — Contrato GPT ativo e preparação de produção

Decisão:
- tornar `gpt/openapi.json` o contrato OpenAPI 3.1 ativo e servi-lo com `PUBLIC_BASE_URL`;
- manter o GPT legado apenas como referência;
- preparar Render Node nativo com readiness e migration pré-deploy, sem migration/seed no startup;
- habilitar RLS sem policies e revogar condicionalmente `anon`/`authenticated` nas tabelas Node;
- usar futuramente usuário PostgreSQL específico, `DATABASE_URL` no runtime e `DIRECT_URL` em migrations, com secrets somente no Render.

Status: preparado localmente; decisões e execução remotas pendentes

## 2026-07-11 — Dependências atuais com compatibilidade segura

Decisão:
- Usar as versões estáveis atuais compatíveis entre si.
- Manter TypeScript 6.0.3 enquanto `typescript-eslint` estável não suportar TypeScript 7.
- Aplicar overrides transitivos seguros para vulnerabilidades do toolchain Prisma sem downgrade ou `--force`.

Status: implementada

## 2026-07-11 — Chave interna temporária

Decisão:
- Proteger `/api/v1` com `x-rpg-key`; manter `/health` público.
- Não representar essa chave como autenticação pública definitiva.

Status: implementada

## 2026-07-11 — Escopo inicial do domínio

Decisão:
- Modelar Player, World, Campaign, Actor, ContentDefinition, ActorContent e GameEvent.
- Adiar combate, inventário físico, comércio, frontend e demais sistemas detalhados.
- Não alterar banco remoto nesta etapa.

Status: implementada

## 2026-07-11 — Estratégia automatizada de testes do backend

Decisão:
- manter unitários e HTTP com Supertest como suíte rápida, sem banco e sem porta;
- reservar integração para repositories, Prisma, migrations, seed, constraints, índices e relações;
- recriar exclusivamente o PostgreSQL local `game_gpt_test` após validações de segurança;
- usar scripts npm como fluxo normal de validação e testes manuais somente para investigação focal.

Status: implementada
