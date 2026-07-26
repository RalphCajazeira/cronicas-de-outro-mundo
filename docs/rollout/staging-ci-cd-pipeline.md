# Pipeline canônico de staging

Este documento descreve o único fluxo rotineiro autorizado para validar, migrar e
implantar `develop` no staging de **Crônicas de Outro Mundo**. Produção, `main`,
OAuth, dados narrativos e identidades reais permanecem fora deste fluxo.

## Arquitetura

```text
pull request para develop
  -> Pull request CI (sem secrets)
  -> PostgreSQL local isolado
  -> Prisma, lint, typecheck, testes e build

push/merge em develop
  -> classificar todas as migrations no intervalo do push
  -> repetir validações sem secrets
  -> Environment staging
  -> preflight sanitizado do Supabase
  -> prisma migrate deploy
  -> migrate status + pós-verificação
  -> Deploy Hook do Render com ref=<github.sha>
  -> aguardar /health/version comprovar SHA, branch e Node
  -> /health + /health/ready
  -> smoke MCP da fixture pública
```

Os workflows são:

- `.github/workflows/ci.yml`: `pull_request` para `develop` e
  `workflow_dispatch`; não referencia Environment nem secrets;
- `.github/workflows/staging-release.yml`: `push` em `develop` e
  `workflow_dispatch`, com `contents: read`, timeout por job e concurrency
  `cronicas-staging-release` sem cancelamento de execução em andamento.

As Actions oficiais `actions/checkout` e `actions/setup-node` são fixadas em
commit SHA. O Node é fixado em `22.22.0`; `.node-version` é a fonte consumida
pelo CI e `NODE_VERSION` no Blueprint mantém o Render explícito e coerente. A
versão `22.23.1` considerada durante a preparação não existe no índice oficial
do Node; `22.22.0` é a release Node 22 mais recente comprovada.

## GitHub Environments

O Environment `staging` aceita somente a branch `develop`. Ele contém apenas
configuração de staging:

Secrets:

- `STAGING_MIGRATION_DATABASE_URL`;
- `STAGING_SUPABASE_CA_CERT`;
- `RENDER_STAGING_DEPLOY_HOOK_URL`.

Variables:

- `STAGING_SUPABASE_PROJECT_REF`;
- `STAGING_DATABASE_NAME`;
- `STAGING_DATABASE_ROLE`;
- `STAGING_DATABASE_SCHEMA`;
- `STAGING_BASE_URL`;
- `STAGING_RENDER_SERVICE_ID`;
- `STAGING_MCP_RESOURCE_URI`.

O certificado é escrito com permissão restrita em `runner.temp` e nunca enviado
como artifact. A URL de migration deve usar a role dedicada, porta 5432
(conexão direta ou Supavisor Session), database `postgres`, schema `public` e
`sslmode=verify-full`. Porta 6543, `pgbouncer=true`, TLS não verificado, outro
project ref, role, database ou schema falham antes da primeira query.

O Environment `staging-high-risk` é restrito a `develop`, exige Ralph como
reviewer e só é referenciado pelo job condicional de provisioning posterior ao
release normal. Ele contém exclusivamente:

Secrets:

- `STAGING_MIGRATION_DATABASE_URL`;
- `STAGING_SUPABASE_CA_CERT`;
- `STAGING_OAUTH_SYNTHETIC_SUBJECT`.

Variables:

- `STAGING_BASE_URL`;
- `STAGING_SUPABASE_PROJECT_REF`;
- `STAGING_OAUTH_ISSUER`.

Os secrets só ficam disponíveis depois da aprovação do Environment. O
provisioning não lê email, senha, token, client secret ou refresh token.

## Provisioning sintético protegido

O manifesto estrito e secret-free
`backend/provisioning/staging/authenticated-readonly-fixture.v1.json` representa
uma única operação versionada. Em `push` para `develop`, o detector compara todo
o intervalo `github.event.before..github.sha`. Base zerada usa a árvore vazia;
base inválida, não ancestral, remoção ou rename do manifesto falha fechado.
`workflow_dispatch` e `repository_dispatch` nunca habilitam o job protegido.

Quando o manifesto foi adicionado ou modificado e o job `release` passou, o job
`provision_authenticated_fixture`:

1. aguarda aprovação no `staging-high-risk`;
2. confirma novamente o SHA, branch, Node, health e readiness live;
3. confirma o histórico de 14 migrations e o alvo PostgreSQL allowlisted;
4. executa a mesma entrada em dry-run com rollback;
5. executa apply em uma transação serializable;
6. executa postflight read-only.

O script resolve somente a tupla exata `(issuer, subject)`, exige um único User
ACTIVE e uma única ExternalIdentity no staging sintético, não adota ou atualiza
Player existente e não faz update, delete ou backfill. Cria ou reutiliza somente
Player, World, Campaign, Actor, CampaignMembership `PLAYER/ACTIVE` e ActorControl
`CONTROL` com códigos e nomes sintéticos fixos. Reexecução retorna tudo como
reutilizado.

Cada fase escreve no `GITHUB_STEP_SUMMARY` somente operationId, SHA, duração e
contagens por tipo. IDs, subject, email, SQL, conexão e tokens não são impressos
nem enviados como artifact. A concurrency do workflow serializa releases e
impede dois provisionamentos simultâneos.

O smoke MCP autenticado direto é executado depois do job com OAuth interativo e
token somente em memória; não existe credencial Auth ou token no Actions.

## Classificação de migrations

`backend/scripts/classify-migrations.ts` recebe SHA base e SHA head, confirma que
ambos existem e que a base é ancestral do head, e inspeciona todo o intervalo.
No `push`, a base é `github.event.before`; se ela for zerada, o fallback seguro é
a árvore vazia, classificando todo o estado do repositório. No disparo manual, a
base completa é obrigatória e nunca é inferida.

Saída:

```json
{
  "changedMigrations": [],
  "risk": "none",
  "reasons": []
}
```

- `none`: nenhum arquivo de migration mudou; o release continua;
- `low`: somente statements reconhecidos e aditivos, como `CREATE TABLE`,
  `CREATE TYPE`, coluna nullable sem default/identity, FK/check e índice comum;
- `high`: qualquer operação destrutiva, DML/backfill, mudança de tipo/enum,
  `SET NOT NULL`, rename, ownership, grants/revokes, RLS/policy, SQL
  procedural/dinâmico, lock, índice unique, alteração do histórico ou statement
  desconhecido.

Comentários, strings, identifiers quoted, casing, whitespace e múltiplos
statements são analisados sem despejar SQL no log. Conteúdo não compreendido é
sempre `high`. Em `high`, o job falha antes de acessar o banco ou o Deploy Hook e
lista apenas arquivo e categoria segura. A análise ou execução de uma migration
high exige nova task e autorização específica de Ralph.

## Preflight, migration e pós-verificação

O preflight conecta somente depois de todas as validações sem secrets. Ele
confirma metadata do destino e lê exclusivamente `_prisma_migrations`.
Checksums SHA-256 de cada `migration.sql` aplicado precisam corresponder ao
commit, o histórico remoto precisa ser prefixo da cadeia local e não pode haver
registro incompleto, rolled back, duplicado ou desconhecido.

O único comando de escrita é:

```text
npm run prisma:migrate:deploy
```

Não há `db push`, `migrate resolve`, reset, seed, repair, backfill ou SQL manual.
Depois do comando, `prisma migrate status` e o script de pós-verificação exigem
quantidade idêntica, zero pendências e zero migrations incompletas. Um release
sem migration é um no-op válido e ainda executa todas as verificações.

Migrations comuns de staging passam a ser automáticas e não devem mais ser
aplicadas manualmente pelo Codex por rotina. Intervenção manual ocorre somente
por `high`, divergência, falha, destino ambíguo ou exceção explicitamente
autorizada.

## Deploy, health e MCP

O Deploy Hook é secret. O script preserva sua chave, adiciona `ref` com o SHA
completo do workflow e não imprime a URL. `200` registra o deploy ID sanitizado;
`202` registra fila e segue aguardando. Antes de chamar o hook, `/health/version`
é consultado para evitar novo deploy quando o SHA já está live.

O polling tem timeout de 30 minutos, tolera cold start e reduz logs. O release só
passa quando:

- `/health/version` retorna o SHA exato, branch `develop` e Node `v22.22.0`;
- `/health` retorna 200;
- `/health/ready` retorna 200.

Se um commit diferente do anterior esperado ficar live, o rollout para. O
endpoint de versão retorna somente `status`, `commit`, `branch` e `nodeVersion`.

O smoke público usa o cliente oficial MCP para initialize, `tools/list`,
`resources/list`, `resources/read`, fixture connect/load e encerramento da
sessão por `DELETE`. Em seguida, abre uma segunda sessão e comprova que ela volta
a `DISCONNECTED`. Quando o resource server OAuth está habilitado, ele confirma
o challenge e os documentos de metadata sem usar token; quando desabilitado,
confirma 404. A fixture é pública, isolada em memória, não cria identidade, não
persiste e não consulta dado narrativo real. O smoke real da
`loadAuthenticatedGameContext` ocorre separadamente, depois do provisioning,
com a conta sintética e o App OAuth privado.

## Disparo manual

`workflow_dispatch` exige `base_sha` completo do último release comprovado e só
libera o job com Environment quando `github.ref` é `refs/heads/develop`. Nunca
use uma base estimada.

O GitHub só recebe `workflow_dispatch` de um arquivo existente na branch
default. Como `main` não é alterada nesta fase, o disparo manual permanecerá
indisponível até o workflow também existir na branch default em uma mudança
separada e autorizada. O trigger automático por push em `develop` não tem essa
limitação e é o fluxo canônico atual.

## Falhas e rollback

- Falha antes da migration: banco e Render não sofrem efeito.
- Falha da migration: Render não é chamado; não há repair ou retry automático.
- Migration aditiva concluída e deploy falha: o schema permanece; a versão
  anterior continua live e a correção segue por branch/PR.
- Deploy live e smoke falha: registrar o incidente; redeploy do commit anterior
  somente após confirmar compatibilidade com o schema. Nunca reverter schema
  automaticamente.

Em retry, primeiro confirme workflow, histórico Prisma, deploys Render e
`/health/version`. Não dispare um segundo deploy para ocultar uma falha.

## Operação, rotação e desativação

Em incidente:

1. desabilite temporariamente o workflow **Staging release** no GitHub;
2. preserve logs sanitizados e identifique o último passo confirmado;
3. confirme que auto-deploy do Render continua off;
4. rotacione imediatamente qualquer URL/credencial possivelmente exposta;
5. substitua o secret no Environment sem registrá-lo em issue, PR ou artifact;
6. corrija por branch e PR normal para `develop`.

Para desativar permanentemente, desabilite o workflow e remova seus secrets
somente depois de confirmar que não há execução ativa. Não habilite auto-deploy
como substituto. A rotação do Deploy Hook é feita no Render; a rotação da role
de migration é feita no Supabase e exige atualização atômica do secret e teste
de preflight.
