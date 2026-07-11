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
