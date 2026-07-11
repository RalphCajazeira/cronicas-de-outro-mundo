# Arquitetura ativa

## Decisão aprovada

O projeto foi reiniciado. A versão baseada em GPT Actions, Supabase Edge Functions, RPCs e OpenAPI manual está em `legacy/supabase-gpt-v1/` somente como referência. O runtime principal é uma API Express + TypeScript modular em `backend/`, com Zod nos limites e PostgreSQL via Prisma Client 7 e o adapter oficial `@prisma/adapter-pg`.

Prisma Migrate é a única autoridade das novas migrations. O histórico Supabase legado não participa do novo schema. Supabase pode fornecer o PostgreSQL, sem ser camada de aplicação.

No runtime, `DATABASE_URL` é obrigatória. A CLI usa `DIRECT_URL` quando definida e recorre conscientemente a `DATABASE_URL` apenas quando ambas apontam para uma conexão direta adequada ao desenvolvimento local; ambientes com pooler devem sempre fornecer `DIRECT_URL`.

## Implementação atual

```text
HTTP -> routes/controller -> service -> repository -> Prisma -> PostgreSQL
```

- `app.ts` compõe o Express sem abrir porta; `server.ts` inicializa o processo.
- `config/` valida ambiente sem expor valores.
- `shared/http` concentra autenticação e erros; `shared/database` concentra um único Prisma Client e o pool do driver `pg`, limitado a cinco conexões, com timeouts explícitos.
- `server.ts` encerra o servidor HTTP e desconecta Prisma em `SIGINT`/`SIGTERM`; testes HTTP injetam repositories e não abrem pool real.
- módulos começam rasos; `characters` reutiliza atores e restringe `actorType`.
- respostas são DTOs normalizados, nunca objetos Prisma brutos.

## Limites de responsabilidade

O backend valida entrada, chave interna, regra de domínio e persistência. O GPT futuramente chama a API Node e cuida da interação narrativa dentro dos contratos. O frontend futuro cuida da UX e também chama a API; nunca recebe service role, URL privilegiada ou acesso direto a tabelas/RPCs.

## Segurança temporária

`GET /health` é público. `/api/v1` exige `x-rpg-key`, comparada sem logging. Essa é autenticação interna temporária entre GPT/admin e backend, não autenticação pública definitiva.

## Pendente antes de deploy

Definir autenticação pública, autorização, CORS explícito, rate limit, auditoria, retenção de logs, gestão de secrets e observabilidade. Não usar CORS `*`. Nenhuma migration roda automaticamente no startup.

## Fases futuras

Frontend, escrita, combate, inventário físico, comércio e demais sistemas narrativos/mecânicos permanecem fora do escopo atual.
