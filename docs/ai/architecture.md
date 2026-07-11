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
- `modules/gpt` reúne os casos de uso da Action v1 sem substituir os endpoints de leitura anteriores.
- escritas usam `IdempotencyRecord`: constraint única, hash de operação/payload e resposta persistida na mesma transação Prisma.
- `/health/ready` executa consulta curta com timeout e resposta binária segura; `/openapi.json` substitui o servidor por `PUBLIC_BASE_URL`.

## Arquitetura de testes

```text
unitário: regra/schema/service isolado
HTTP: Supertest -> app em memória -> repository injetado
integração: Supertest -> app -> repository real -> Prisma -> game_gpt_test local
```

`server.ts` permanece fora de todas as suítes. A preparação de integração valida o destino antes de recriar exclusivamente `game_gpt_test`, aplica migrations com `migrate deploy`, executa o seed e propaga o exit code. Testes rápidos não carregam Prisma real; integração fica restrita a comportamento dependente de PostgreSQL.

## Limites de responsabilidade

O backend valida entrada, chave interna, regra de domínio e persistência. O GPT futuramente chama a API Node e cuida da interação narrativa dentro dos contratos. O frontend futuro cuida da UX e também chama a API; nunca recebe service role, URL privilegiada ou acesso direto a tabelas/RPCs.

## Segurança temporária

`GET /health` é público. `/api/v1` exige `x-rpg-key`, comparada sem logging. Essa é autenticação interna temporária entre GPT/admin e backend, não autenticação pública definitiva.

## Banco hospedado e deploy preparado

O fluxo futuro é GitHub → Render (Node nativo) → Supabase PostgreSQL. Runtime usa `DATABASE_URL`; migrations usam `DIRECT_URL`. Em Supabase deve existir usuário específico para Prisma, com senha forte, e Supavisor Session mode pode ser usado no runtime quando adequado. Secrets pertencem somente ao Render.

A migration incremental habilita RLS nas tabelas da plataforma Node sem policies para clientes Supabase e revoga privilégios de `anon`/`authenticated` somente quando esses papéis existem. Proprietário e migration role permanecem responsáveis por acesso e migrations. Objetos legados e Data API não são alterados.

O papel PostgreSQL específico do Prisma deve aplicar as migrations via `DIRECT_URL`, permanecer proprietário das tabelas Node e ser o mesmo papel usado por `DATABASE_URL`. Sem `FORCE ROW LEVEL SECURITY`, o proprietário opera intencionalmente sem policies; outro papel será bloqueado mesmo que receba grants comuns. Rollback deve preferir código anterior e migration corretiva: remover `IdempotencyRecord` perderia o histórico de idempotência, e desabilitar RLS reduziria a segurança.

## Pendente antes de deploy

Escolher branch/plano/região, criar credencial PostgreSQL específica, cadastrar secrets, validar backup/rollback e aplicar migrations remotamente em etapa controlada. Para futura exposição pública além do GPT/admin, definir autenticação pública, autorização, CORS explícito, rate limit, auditoria, retenção de logs e observabilidade. Não usar CORS `*`. Nenhuma migration ou seed roda no startup.

## Fases futuras

Frontend, escrita, combate, inventário físico, comércio e demais sistemas narrativos/mecânicos permanecem fora do escopo atual.
