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

## Staging gratuito no Render

O staging usa o projeto Render `Game-GPT`, ambiente `Staging`, branch `develop`, região `virginia`, Web Service Node nativo no plano Free e auto-deploy desligado. O serviço não usa Docker. Como Web Services Free não suportam pre-deploy, migrations são um gate manual obrigatório antes de cada deploy; nunca devem ser movidas para build, start, inicialização da aplicação ou health check.

Gate manual, sempre a partir do commit que será implantado:

1. confirmar branch, commit e alvo Supabase staging;
2. iniciar o processo com `NODE_EXTRA_CA_CERTS` apontando para a CA oficial local e carregar `DATABASE_URL`/`DIRECT_URL` de staging;
3. executar `npm run prisma:validate --prefix backend`;
4. executar `npx prisma migrate status` no diretório `backend/`;
5. executar `npm run prisma:migrate:deploy --prefix backend`;
6. repetir `npx prisma migrate status` e exigir schema atualizado, sem migration pendente ou falha;
7. somente então iniciar manualmente o deploy do commit aprovado;
8. validar `/health`, `/health/ready`, `/openapi.json` e smoke tests protegidos somente de leitura.

O certificado local fica em `backend/.secrets/supabase-ca.crt`, diretório ignorado pelo Git. As URLs usam `sslmode=verify-full` com a CA oficial carregada antes do startup do Node, Prisma CLI ou npm. No Render, cadastrar manualmente um secret file chamado `supabase-ca.crt`; o runtime o monta em `/etc/secrets/supabase-ca.crt`, caminho configurado por `NODE_EXTRA_CA_CERTS`. O conteúdo do certificado, connection strings e chaves nunca pertencem ao Blueprint ou à documentação.

Variáveis do serviço: `NODE_ENV`, `HOST`, `NODE_EXTRA_CA_CERTS`, `DATABASE_URL`, `RPG_API_KEY` e `PUBLIC_BASE_URL`. `PORT` é fornecida pelo Render. `DIRECT_URL` é exclusiva do gate manual e não é necessária no build ou runtime remoto: `prisma generate` usa `DATABASE_URL` sem conectar ao banco.

Ordem do primeiro deploy: concluir o gate manual e abrir a criação manual do Web Service dentro de `Game-GPT`/`Staging`. Replicar exatamente o `render.yaml`, cadastrar `DATABASE_URL`, `RPG_API_KEY`, `PUBLIC_BASE_URL` e o secret file da CA antes de clicar em **Deploy web service**, confirmar Free/`develop`/`virginia`/auto-deploy off e só então criar e iniciar o deploy. A criação inicial é manual porque o Blueprint não declara o conteúdo do secret file; depois que o serviço e o YAML estiverem publicados e revisados, o Blueprint pode assumir a configuração pelo mesmo nome. Seed é proibido no Render.

Rollback operacional usa um dos dois deploys anteriores disponíveis no Free, sem reverter migrations destrutivamente. Se código anterior for incompatível com uma migration já aplicada, corrigir por nova migration compatível antes de qualquer rollback. Cold start, suspensão após inatividade, filesystem efêmero e limites de horas, banda, pipeline e logs permanecem limitações aceitas do staging Free.

A trava de custos é absoluta: não selecionar instância paga, upgrade, disco persistente ou recurso cobrado. Qualquer tela com cobrança deve ser abandonada antes da confirmação.

## Pendente antes de deploy

Cadastrar secrets e o secret file no Render, executar o gate manual a partir do commit aprovado, validar o preview do Blueprint publicado e realizar o primeiro deploy controlado. Para futura exposição pública além do GPT/admin, definir autenticação pública, autorização, CORS explícito, rate limit, auditoria, retenção de logs e observabilidade. Não usar CORS `*`. Nenhuma migration ou seed roda no startup.

## Fases futuras

Frontend, escrita, combate, inventário físico, comércio e demais sistemas narrativos/mecânicos permanecem fora do escopo atual.
