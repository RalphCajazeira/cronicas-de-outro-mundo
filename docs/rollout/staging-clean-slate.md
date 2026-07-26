# Clean-slate allowlisted de staging

Este procedimento é a limpeza operacional para o staging Virginia descartável.
Ele não altera migrations, não faz backfill e não substitui `prisma migrate deploy`.

O pipeline descrito em `staging-ci-cd-pipeline.md` é a fonte canônica para
migrations comuns. Este clean-slate é uma exceção destrutiva e continua exigindo
task e autorização próprias; ele nunca é chamado pelos workflows.

## Escopo e proteção

O comando `npm run db:clean-slate --prefix backend` somente aceita:

- `--environment=local`: `localhost`/`127.0.0.1`, database `game_gpt_test`;
- `--environment=staging`: host direto do projeto Virginia e database `postgres`.

Ele exige `--execute` e confirmação explícita. Sem isso, apenas imprime um plano
sanitizado. O alvo é uma allowlist das 33 tabelas funcionais, 30 enums e 24
funções criadas pelas treze migrations. Triggers das tabelas allowlisted são
removidos antes das funções; tabelas, `_prisma_migrations` e enums vêm depois,
tudo em uma transação. Não usa `DROP DATABASE`, `DROP SCHEMA` ou descoberta por
prefixo. `auth`, `storage`, `realtime`, `extensions` e objetos fora da allowlist
não são tocados.

`prisma migrate reset` não é suficiente neste projeto: ele pode remover tabelas
sem remover funções independentes de `public`, o que causa colisões em migrations
históricas como `ruleset_version_block_update`.

## Validação local

Com as variáveis do banco de teste protegido:

```powershell
npm run test:integration --prefix backend
```

O gate aplica todas as migrations commitadas, executa dois ciclos completos de clean-slate e
`prisma migrate deploy`, e verifica que não restam tabelas, enums, funções nem
histórico Prisma da aplicação entre os ciclos.

## Staging Virginia

Não use esta seção para aplicar migration comum por rotina. O fluxo abaixo serve
somente para recuperação clean-slate explicitamente autorizada. Depois da
recuperação, o pipeline volta a ser a autoridade dos releases normais.

1. Confirme o projeto `cronicas-de-outro-mundo-staging-virginia`, ref
   `udqwzvhlwwfnngiipacj`, região `us-east-1`; não use produção nem o staging
   legado.
2. Carregue `DIRECT_URL` somente no runner seguro e conceda temporariamente o
   privilégio de migration já aprovado para `cronicas_staging_app`.
3. Execute:

```powershell
npm run db:clean-slate --prefix backend -- --environment=staging --execute --confirm=staging-clean-slate
npm run prisma:migrate:deploy --prefix backend
```

4. Verifique `npx prisma migrate status`, os 13 registros concluídos e o catálogo
da aplicação. Revogue o privilégio temporário imediatamente.

O reset completo remove `_prisma_migrations`; portanto, não execute `migrate
resolve` depois dele. Aplique todas as migrations desde zero.
