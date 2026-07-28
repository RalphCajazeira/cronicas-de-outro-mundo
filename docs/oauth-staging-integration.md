# OAuth 2.1 de staging — UI, audience e identidade

Este documento descreve a integração exclusiva de staging entre ChatGPT, Supabase Auth e o MCP autenticado. Ele não autoriza produção, DCR, dados reais, gameplay, backfill ou remoção de schema.

## Fluxo canônico

```text
ChatGPT
  → Supabase OAuth 2.1 Authorization Code + PKCE S256
  → /oauth/login e /oauth/consent no Render
  → access token ES256 com aud exata
  → /mcp-auth
  → issuer/JWKS/audience/scopes/client allowlist
  → ExternalIdentity(issuer, subject)
  → User ACTIVE
  → getAuthenticatedBootstrap
  → loadAuthenticatedGameContext
```

O endpoint público `/mcp` continua separado. O backend não recebe, persiste nem encaminha refresh token, authorization code ou credenciais da conta sintética.

A Fase 2D adiciona somente leitura real por Player, CampaignMembership e
ActorControl, com widget próprio. O contrato, fixture e proteção contra IDOR
estão em `authenticated-readonly-game-context.md`.

## SPA OAuth

O pacote `oauth-ui/` é uma SPA TypeScript sem framework, construída com esbuild pelo build raiz e servida pelo backend.

- `/oauth/login`: somente `signInWithPassword`; não oferece signup.
- `/oauth/consent?authorization_id=...`: verifica sessão, consulta os detalhes oficiais, mostra client/redirect/scopes e permite approve ou deny.
- Sessão: adapter explícito do Supabase em `sessionStorage`, limitado à aba.
- Redirect: somente o `redirect_url` devolvido pelo SDK; após decisão, origin e path precisam corresponder ao `redirect_uri` aprovado.
- Renderização: APIs DOM e `textContent`; dados externos nunca são inseridos com `innerHTML`.
- Headers: CSP sem terceiros, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `nosniff`, `DENY`, COOP/CORP e Permissions Policy restrita.
- Assets: locais, sem CDN, analytics ou source map público.

A configuração pública contém somente URL do projeto Supabase, publishable key, ambiente `staging` e base path `/oauth`. Service role, URL do banco, client secret, token e credenciais sintéticas são proibidos.

## Policy de resource audience

`OAuthClientResourcePolicy` é uma tabela genérica sem usuário, token, secret ou dados do jogo:

- `clientId` único e comparado por igualdade exata;
- `audience` HTTPS;
- `enabled`;
- timestamps.

A tabela usa RLS, não tem policy pública e revoga `PUBLIC`, `anon`, `authenticated` e `service_role`. O único acesso necessário ao hook ocorre por uma função `SECURITY DEFINER` criada e pertencente à role deliberada de migration/runtime da plataforma Node. A função fixa `search_path`, não usa SQL dinâmico e só recebe `EXECUTE` para `supabase_auth_admin`.

`public.custom_access_token_hook(event jsonb)`:

- preserva todas as claims e a audience padrão quando `claims.client_id` não existe;
- busca uma policy ativa por `clientId` exato;
- falha fechado para client ausente, desabilitado, malformado ou desconhecido;
- substitui somente `aud` pelo valor exato da policy;
- aplica a mesma regra em emissão inicial e refresh.

A migration `20260726150000_oauth_client_resource_policy` é intencionalmente `high` por função, RLS, grants e SQL procedural. O classifier não deve ser relaxado.

## Provisioning controlado

Os scripts exigem exatamente `--dry-run` ou `--apply`:

```powershell
npm run staging:oauth:policy --prefix backend -- --dry-run
npm run staging:oauth:identity --prefix backend -- --dry-run
```

`upsert-oauth-client-policy.ts` lê `STAGING_OAUTH_CLIENT_ID` e `OAUTH_RESOURCE_URI`, aceita somente os recursos HTTPS exatos `/mcp-auth` e `/extension/session`. Cada client é upsertado por ID, portanto a policy pública da extensão não altera nem substitui a policy do App MCP.

`provision-synthetic-identity.ts` lê `OAUTH_ISSUER`, `STAGING_SYNTHETIC_AUTH_SUBJECT` e `STAGING_SYNTHETIC_EMAIL`. Ele aceita somente issuer Supabase canônico, subject UUID e domínio reservado `example.test`; em uma transação cria no máximo um `User` ACTIVE e uma `ExternalIdentity`. Não cria Player, World, Campaign, membership, ActorControl ou AuditEvent narrativo.

Senha e e-mail da conta Auth ficam somente em arquivo local ignorado sob `backend/.secrets/` ou mecanismo equivalente. Eles não pertencem ao Render, GitHub Actions, Git ou documentação.

## Rollout da migration high

Após merge commit em `develop`:

1. confirmar o bloqueio automático `high`, antes do banco e do Render;
2. fazer checkout do SHA mergeado exato;
3. executar o preflight allowlisted de staging;
4. executar somente `prisma migrate deploy`;
5. executar o postflight;
6. verificar migration, checksum, tabela, função, owner, grants, RLS e ausência de policy pública;
7. implantar o mesmo SHA exato no Render;
8. validar health/version, health, readiness, `/mcp`, UI e smokes.

Não executar SQL paralelo ou `db push`.

## Ordem da ativação

1. Publicar a UI com o resource server ainda desabilitado e confirmar `/mcp-auth` em `404`.
2. Confirmar zero usuários/clients/consents/sessões reais.
3. Habilitar OAuth Server, manter DCR desligado, definir Site URL de staging e Authorization Path `/oauth/consent`.
4. Observar o callback exato do ChatGPT antes de criar o client.
5. Criar um client público, `token_endpoint_auth_method=none`, callback HTTPS exato e PKCE S256.
6. Aplicar uma policy ativa com audience exata de `/mcp-auth`.
7. Criar uma conta Auth sintética confirmada e provisionar sua identidade interna.
8. Ativar somente `public.custom_access_token_hook`.
9. Provar login comum com audience padrão e OAuth com audience exata.
10. Configurar o resource server no Render de forma coordenada e fazer um único deploy do SHA exato.
11. Criar o App ChatGPT privado separado e validar conexão, refresh, revogação e reconexão.

DCR permanece desabilitado. Um callback loopback temporário pode ser adicionado somente para teste controlado de Authorization Code + PKCE + refresh e deve ser removido antes da entrega.

## Rollback

1. desabilitar/remover o App OAuth privado;
2. desabilitar `OAUTH_RESOURCE_SERVER_ENABLED` no Render;
3. revogar grants/consents/sessões do client;
4. desabilitar o Custom Access Token Hook;
5. desabilitar o OAuth Server se nenhum outro fluxo o usar;
6. desabilitar a policy do client por script controlado;
7. preservar a migration e a tabela.

Remoção de schema, usuário ou dados exige nova autorização explícita.
