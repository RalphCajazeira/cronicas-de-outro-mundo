# Fundação local do OAuth Resource Server — Fase 2C-A

## Estado e limites

Esta fase adiciona somente a fundação local de um MCP autenticado. Ela não
habilita OAuth no Supabase, não registra client, não cria usuário remoto, não
altera Render ou ChatGPT e não acessa campanhas. O endpoint público `/mcp`, a
fixture `loadGameContext`, `connectFixtureAccount`, o widget v3, REST,
Actions/OpenAPI e readiness legado permanecem separados.

```text
/mcp
→ prova pública efêmera existente
→ identidade e contexto fixture

/mcp-auth
→ Bearer obrigatório em toda requisição
→ JWT validado por JWKS
→ (issuer, subject)
→ ExternalIdentity
→ User ACTIVE
→ uma única tool read-only
```

Com `OAUTH_RESOURCE_SERVER_ENABLED=false`, `/mcp-auth` e seu metadata não são
registrados. Com OAuth habilitado, configuração incompleta ou insegura falha no
startup. O startup e `/health/ready` não baixam JWKS: indisponibilidade
temporária das chaves fecha somente o endpoint protegido, sem criar dependência
de rede permanente para o backend legado.

## Endpoints e metadata

- recurso protegido: `/mcp-auth`;
- metadata RFC 9728: `/.well-known/oauth-protected-resource/mcp-auth`;
- futuro URI de staging:
  `https://cronicas-de-outro-mundo-staging-api.onrender.com/mcp-auth`.

O URI real é configurado e deve ter exatamente o mesmo path do endpoint. O
metadata é validado pelo schema do SDK MCP 1.29.0 e contém somente:

```json
{
  "resource": "<OAUTH_RESOURCE_URI>",
  "authorization_servers": ["<OAUTH_AUTHORIZATION_SERVER>"],
  "scopes_supported": ["<escopos configurados>"],
  "bearer_methods_supported": ["header"]
}
```

O resource server não republica metadata do authorization server em seu próprio
host. `WWW-Authenticate` referencia o metadata acima por `resource_metadata`.
Token ausente, malformado ou inválido retorna `401`; scope insuficiente retorna
`403`. Identidade não vinculada ou User indisponível também retorna `403` com
mensagem pública única, enquanto a categoria precisa permanece somente no log
sanitizado.

## Configuração

| Variável | Finalidade |
|---|---|
| `OAUTH_RESOURCE_SERVER_ENABLED` | gate explícito independente de `NODE_ENV` |
| `OAUTH_ISSUER` | issuer exato aceito no JWT |
| `OAUTH_AUTHORIZATION_SERVER` | issuer anunciado no metadata; nesta fase deve ser igual ao issuer aceito |
| `OAUTH_JWKS_URI` | origem confiável e fixa das chaves |
| `OAUTH_RESOURCE_URI` | resource/audience canônico exato |
| `OAUTH_PROTECTED_MCP_PATH` | path local, padrão `/mcp-auth` |
| `OAUTH_REQUIRED_SCOPES` | lista separada por vírgulas exigida em todas as requisições |
| `OAUTH_ALLOWED_CLIENT_IDS` | allowlist opcional e exata de OAuth clients; vazia não substitui audience |
| `OAUTH_ALLOWED_ALGORITHMS` | allowlist assimétrica separada por vírgulas |
| `OAUTH_CLOCK_SKEW_SECONDS` | tolerância de relógio para claims temporais |
| `OAUTH_JWKS_TIMEOUT_MS` | timeout de download |
| `OAUTH_JWKS_COOLDOWN_MS` | intervalo mínimo de novo fetch após sucesso |
| `OAUTH_JWKS_CACHE_MAX_AGE_MS` | validade máxima do cache em memória |

Issuer, authorization server e JWKS exigem HTTPS. Somente testes com
`NODE_ENV=test` aceitam HTTP em `localhost` ou `127.0.0.1`. Fora de testes,
hosts locais, `.local`, `.internal` e IP literals são recusados, e a JWKS deve
usar exatamente o mesmo origin do issuer permitido. O resource aceita HTTP
loopback em ambiente não produtivo. URLs com credenciais, query ou fragment são
rejeitadas, e o origin do resource deve coincidir com `PUBLIC_BASE_URL` quando
ela estiver configurada. `.env.example` contém apenas nomes, campos vazios e
valores de controle não secretos.

## JWT, JWKS e scopes

`jose@6.2.4` é dependência direta porque o backend a importa. O SDK MCP já
dependia transitivamente da mesma versão, mas dependência transitiva não é
contrato suficiente para código da aplicação.

Cada request:

1. exige `Authorization: Bearer`;
2. recusa `none`, todos os `HS*` e qualquer algoritmo fora da allowlist;
3. resolve a chave pelo `kid` em JWKS fixada na configuração;
4. valida assinatura, `iss` exato, `aud` contendo o resource exato, `exp`,
   `nbf` quando presente e `iat` não futuro;
5. exige `sub` não vazio e sanitizável;
6. interpreta somente `scope` textual no formato OAuth e exige ao menos um dos
   scopes padrão atualmente emitidos pelo Supabase (`openid`, `email`, `profile`
   ou `phone`), conforme configuração;
7. lê `client_id` somente para uma allowlist opcional e exata;
8. deriva apenas `{ issuer, subject }`.

`aud` pode ser string ou array segundo JWT; o resource esperado deve estar
presente. `jku`, JWKS ou URI vindos do token nunca selecionam chaves. A instância
de `createRemoteJWKSet` mantém cache em memória e possui timeout, cooldown e
idade máxima configuráveis. O fetch não segue redirects (`redirect: manual`),
aceita somente a URI configurada e limita a resposta JWKS a 256 KiB. O token
recebido não é persistido, registrado, encaminhado ao Supabase nem usado em
serviço downstream.

Scopes OAuth não representam capacidades de campanha. Nesta fase são aceitos
somente os quatro scopes padrão comprovadamente suportados pelo Supabase;
`game.read`, `game.play`, `game.create` e equivalentes são proibidos. Futuras
capacidades de domínio serão derivadas internamente de User,
CampaignMembership, ActorControl e política. Custom scopes só poderão ser
habilitados após suporte oficial e emissão real comprovados.

Audience e client são controles complementares. O modo canônico exige
`aud=<URI exato de /mcp-auth>` por Custom Access Token Hook. Uma eventual prova
isolada com `aud=authenticated` exigiria decisão separada, allowlist estrita de
`client_id`, identidade sintética e zero dados reais; esse relaxamento não está
implementado na 2C-A e não é o estado final aceito.

O middleware Bearer oficial do SDK constrói `WWW-Authenticate`, valida os scopes
exigidos e associa `AuthInfo` ao Streamable HTTP. Imediatamente após resolver a
identidade, o backend remove `Authorization` dos headers normalizados e crus,
substitui token, client e scopes no `AuthInfo` por valores vazios e remove
principal/claims antes de entregar somente o vínculo interno ao transporte e à
tool. Headers ambíguos, credenciais múltiplas, token acima de 8 KiB, esquema
incorreto e Bearer malformado falham antes da criação de sessão. Token em query
string é explicitamente rejeitado com `401`, mesmo quando também existe Bearer
válido, e nunca alcança o transporte.

## Identidade, sessão e auditoria

O serviço da Fase 2B é reutilizado sem criação automática:

```text
(issuer, subject) exato
→ ExternalIdentity única
→ User
→ status ACTIVE
→ suspendedAt = null
→ deletedAt = null
```

Email e claims livres são ignorados. Identidade ausente, duplicada ou
inconsistente e User suspenso/deletado falham fechados. `lastAuthenticatedAt`
não é atualizado e nenhum `AuditEvent` persistente é criado.

Cada sessão MCP guarda somente um SHA-256 não reversível e versionado de
`"mcp-binding:v1" + NUL + issuer + NUL + subject + NUL + userId`. Toda
requisição revalida Bearer e identidade. Uma
troca de vínculo na mesma sessão retorna `403`, remove a sessão e fecha o
transporte. Sessões vizinhas usam objetos `McpServer` e transportes distintos.
DELETE remove o contexto e repetições são idempotentes.

O audit HTTP passou a gerar `requestId` e `traceId`. Para autenticação, registra
categoria, disposição sanitizada do issuer (`allowed`, `rejected`, `missing` ou
`not_evaluated`), resultado, fingerprint curto do subject quando disponível e
nome allowlisted da tool. Headers, bearer, JWT, claims, email, cookies, chaves,
JWKS e secrets não entram no registro.

## Tool de prova

`getAuthenticatedBootstrap` é a única tool de `/mcp-auth`. Ela é read-only,
idempotente, não destrutiva e fechada ao mundo externo. A resposta estruturada é:

```json
{
  "authenticated": true,
  "userStatus": "ACTIVE",
  "environment": "test",
  "runtimeMode": "test"
}
```

Não retorna issuer, subject, email, userId, Player, campanha, ator, membership,
role, narrativa, informação do Mestre, token ou claims. Não executa escrita nem
consulta campanha.

Na Fase 2D, `environment` passa a usar `APP_ENV` e `runtimeMode` explicita
`NODE_ENV`. O bootstrap permanece técnico e a nova
`loadAuthenticatedGameContext` usa projeções allowlisted documentadas em
`authenticated-readonly-game-context.md`.

## Avaliação pública do Supabase em 2026-07-26

Consulta somente leitura ao projeto staging:

| Endpoint | Status | Evidência |
|---|---:|---|
| `/auth/v1/.well-known/openid-configuration` | 200 | issuer `/auth/v1`, authorize/token/userinfo/JWKS, `authorization_code` + `refresh_token`, response `code`, PKCE `S256` e `plain`, scopes `openid profile email phone` |
| `/.well-known/oauth-authorization-server/auth/v1` | 404 | path canônico atual; `feature_disabled`: OAuth server desabilitado |
| `/auth/v1/.well-known/oauth-authorization-server` | 404 | variante não canônica também devolve `feature_disabled` |
| `/auth/v1/.well-known/jwks.json` | 200 | uma chave pública EC P-256 para `ES256` |
| `/.well-known/openid-configuration` e `/.well-known/jwks.json` | 404 | paths inválidos; OIDC/JWKS permanecem sob `/auth/v1` |

OIDC anuncia algoritmos de ID token `RS256`, `HS256` e `ES256`, mas a JWKS
atual publica somente chave assimétrica ES256. O documento OIDC não anunciou
registration endpoint nem revocation endpoint. A ausência do metadata OAuth e o
erro `feature_disabled` são a evidência decisiva de que OAuth Server não está
habilitado; OIDC básico e JWKS existentes não provam o contrário.

As fontes oficiais atuais colocam o discovery OAuth habilitado em
`/.well-known/oauth-authorization-server/auth/v1`, exigem Authorization Code
com PKCE e recomendam chave assimétrica. O default documentado de access token
usa `aud=authenticated`; portanto o rollout deve configurar e comprovar
`aud=<URI canônico de /mcp-auth>` por Custom Access Token Hook antes de qualquer
login real. A documentação oficial também informa que scopes OIDC controlam
dados de identidade, não acesso ao banco; o scope mínimo aceito pelo MCP deve
ser compatível com o conjunto efetivamente emitido pelo Supabase.

Referências:

- <https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>
- <https://supabase.com/docs/guides/auth/oauth-server>
- <https://supabase.com/docs/guides/auth/oauth-server/getting-started>
- <https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication>
- <https://supabase.com/docs/guides/auth/oauth-server/oauth-flows>
- <https://supabase.com/docs/guides/auth/oauth-server/token-security>

## Authorization UI mínima da Fase 2C-B

A superfície proposta é técnica, same-origin e sem gameplay:

- `GET /oauth/login`: rota estática da SPA para login mínimo;
- `GET /oauth/consent?authorization_id=...`: rota estática da SPA que valida
  sessão, preserva o ID, carrega client, redirect URI e scopes e mostra
  aprovar/negar;
- aprovar/negar é um evento local da SPA que chama diretamente os métodos
  oficiais do Supabase; não existe endpoint Express de decisão;
- sucesso ou negação redireciona somente para a `redirect_url` devolvida pela
  API oficial do Supabase, nunca para input livre.

Decisão para a 2C-B: **Opção A, SPA TypeScript mínima e isolada**. Os métodos
oficiais `getAuthorizationDetails`, `approveAuthorization` e
`denyAuthorization` pertencem ao `supabase-js` e foram desenhados para essa
superfície frontend. Deve-se reutilizar apenas o padrão de build TypeScript já
existente no widget, em um entrypoint/pacote separado, sem importar DTOs,
estado, estilos ou recursos de gameplay. `@supabase/supabase-js` será avaliado
como dependência direta somente na task futura. A opção SSR com
`@supabase/ssr`, cookies no Express e refresh server-side adiciona complexidade
sem necessidade para o primeiro consentimento e não é a recomendada.

A sessão Supabase fica no browser usando somente a chave publicável, com storage
customizado em `sessionStorage` limitado à aba para preservar o login durante
redirects; não há cookie do Express, e nenhum `service_role`, client secret ou
refresh token entra no backend do jogo. A exposição do refresh token a
JavaScript torna XSS o principal risco residual; se a revisão da 2C-B exigir
cookie `HttpOnly`, a decisão deve mudar explicitamente para a opção SSR e
`@supabase/ssr`. O `authorization_id` permanece no URL apenas durante o fluxo e
deve ser validado pelo Supabase, preservado no redirect de login e removido de
logs/referrers. A decisão exige proteção contra login CSRF,
confirmação explícita, clickjacking e XSS; `state` e PKCE pertencem ao
client/Supabase e não são substituídos pela UI. CSP mínima:
`default-src 'none'`, scripts e estilos self-hosted, `connect-src` somente
Supabase autorizado, `form-action 'self'`, `frame-ancestors 'none'`,
`base-uri 'none'`, `referrer-policy: no-referrer`. Riscos: redirect aberto,
session fixation, CSRF, XSS, consentimento confuso, scopes incompatíveis,
exposição do authorization ID e dependência do beta do Supabase.

## Plano operacional exato da Fase 2C-B — não executar nesta fase

1. **Revalidar custo e capacidades.** Ler preços/limites atuais e confirmar
   discovery, DCR, PKCE, revogação, custom audience e scopes. Somente leitura;
   reversível. Se qualquer gate essencial falhar, parar.
2. **Autorizar habilitação do OAuth Server no Supabase staging.** Efeito externo
   explícito; reversível desligando o recurso, mas pode invalidar clients/fluxos.
3. **Confirmar a chave JWT assimétrica.** A JWKS atual publica ES256; confirmar
   chave ativa, rotação e impacto. Migração/rotação exige autorização e plano de
   coexistência; revogar chave antiga pode ser irreversível para tokens ativos.
4. **Configurar Site URL e Authorization Path.** Propor
   `/oauth/consent`; alteração externa reversível. Não salvar antes de a UI
   mínima estar implantada.
5. **Implementar e publicar login/consentimento mínimo.** Task própria, revisão
   de CSP, cookie, CSRF, redirect e redaction; deploy Render autorizado e
   reversível por rollback da versão.
6. **Registrar primeiro um client separado e explícito.** Para o primeiro teste,
   preferir client pré-registrado, redirect URI exata e allowlist de
   `client_id`, reduzindo variáveis do beta. Habilitar DCR somente depois que o
   fluxo pré-registrado passar e a interoperabilidade do ChatGPT exigir; cada
   registro/habilitação exige autorização externa e clients podem ser revogados.
7. **Configurar Custom Access Token Hook.** Emitir `aud` exatamente igual ao URI
   de staging de `/mcp-auth`, condicionado ao client OAuth aprovado. Alteração
   remota sensível; rollback é desabilitar/reverter o hook, considerando tokens
   já emitidos.
8. **Fechar scopes.** Usar somente `openid`, `email`, `profile` e `phone`;
   selecionar o mínimo realmente emitido (preferência inicial `openid`) e manter
   toda autorização de domínio no backend. Não anunciar custom scope até suporte
   e emissão comprovados.
9. **Criar uma única identidade sintética de staging.** Criar usuário Supabase,
   `User` e `ExternalIdentity` correspondentes, sem Player, membership,
   ActorControl ou campanha. Efeito externo autorizado e removível; registrar
   cleanup sem copiar secrets.
10. **Configurar Render staging.** Definir os `OAUTH_*` com issuer, JWKS, resource,
    scope e ES256; não remover proof mode nem alterar `/mcp`. Efeito externo e
    reversível por rollback de env/deploy.
11. **Criar App ChatGPT separado.** Apontar somente para `/mcp-auth`; não alterar
    o App fixture. Efeito externo autorizado e removível.
12. **Executar login real.** Validar discovery, DCR/client, consentimento,
    challenge, token, tool mínima e nenhum dado de campanha. Exige autorização e
    usuário sintético.
13. **Testar refresh, revogação e reconexão.** Confirmar rotação do refresh pelo
    client, `401` após revogação, nova sessão MCP e ausência de token no backend.
    Nunca persistir refresh token no resource server.
14. **Confirmar custo e encerrar.** Registrar consumo, remover client/usuário
    temporário se autorizado, preservar logs sanitizados e confirmar zero acesso
    a campanhas reais.

### Gate Supabase versus Auth0

Continuar com Supabase somente se ele comprovar, no estado habilitado:

- OAuth metadata e DCR/client compatíveis com ChatGPT;
- PKCE S256;
- access token assimétrico verificável por JWKS;
- audience/resource canônico exato;
- scope solicitado e emitido de forma consistente;
- revogação/refresh testáveis;
- Authorization UI segura e custo aprovado.

Para rollout ou acesso a dados, se audience/resource ou interoperabilidade não
puderem ser garantidos, não aceitar `aud=authenticated`, não relaxar issuer,
não aceitar HS256 e não usar token passthrough. Um spike temporário com
`aud=authenticated` só pode existir por autorização separada, `client_id`
estrito, identidade sintética e zero dados de campanha, e deve ser removido ao
fim da prova. Se o modo canônico continuar inviável, parar o rollout e abrir
decisão arquitetural separada para Auth0 ou outro authorization server. Essa
troca não pertence à 2C-B sem nova autorização de produto, custo, dados e
operação.

## Rollback

Rollback local: remover o mount condicional de `/mcp-auth`, metadata, módulos e
variáveis `OAUTH_*`, mantendo intactos `/mcp`, REST, widget e schema da Fase 2B.
Não há migration para reverter. No futuro staging, desabilitar primeiro o App
autenticado e o endpoint/config Render, depois client/hook/UI e por último OAuth
Server, preservando evidências e respeitando tokens já emitidos. Nunca remover
tabelas de identidade como rollback operacional.
