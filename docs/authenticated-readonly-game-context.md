# Contexto real autenticado somente leitura — Fase 2D

## Limite da fase

A Fase 2D mantém `/mcp` e sua fixture pública intactos e amplia somente
`/mcp-auth`. O endpoint autenticado continua exigindo OAuth 2.1, PKCE, JWT ES256,
issuer, audience e client exatos. Nenhuma tool desta fase executa ação mecânica,
escrita narrativa, seleção persistente, avanço de tempo ou criação de conteúdo.

```text
Bearer validado
→ (issuer, subject)
→ ExternalIdentity
→ User ACTIVE
→ Player explicitamente vinculado
→ CampaignMembership ACTIVE
→ ActorControl VIEW ou CONTROL
→ projeções públicas allowlisted
→ widget autenticado somente leitura
```

## Ambiente de produto e runtime

`APP_ENV` representa o ambiente do produto e aceita somente:

- `local`;
- `test`;
- `staging`;
- `production`.

`NODE_ENV` continua representando o modo do runtime Node. Em qualquer runtime
com `NODE_ENV=production`, `APP_ENV` é obrigatório. O Blueprint do Render usa:

```text
APP_ENV=staging
NODE_ENV=production
```

Assim, o bootstrap autenticado retorna `environment: "staging"` e
`runtimeMode: "production"` sem apresentar staging como produção. A OAuth UI
existente também exige `APP_ENV=staging`.

## Tool autenticada

`getAuthenticatedBootstrap` permanece disponível com o contrato:

```json
{
  "authenticated": true,
  "userStatus": "ACTIVE",
  "environment": "staging",
  "runtimeMode": "production"
}
```

`loadAuthenticatedGameContext` concentra listagem, seleção efêmera e carga do
contexto. O input é fechado e aceita somente:

```json
{
  "campaignSelectionRef": "sel_...",
  "characterSelectionRef": "sel_..."
}
```

Ambos os campos são opcionais. Uma única campanha ou personagem autorizado é
selecionado automaticamente. Com múltiplas opções, a mesma tool recebe a
referência escolhida. As referências são hashes estáveis, vinculados ao User e
ao UUID interno; UUID, slug interno e IDs de banco não são publicados.

Uma referência desconhecida, revogada, alheia ou usada fora da campanha
selecionada retorna o mesmo estado `AUTHORIZATION_ERROR`. A resposta não revela
se o recurso existe, seu nome, owner ou personagem.

## Consulta autorizada

A consulta parte de `User.id`, nunca de `Player`, `Campaign` ou `Actor`
fornecido pelo cliente. O Prisma filtra antes da projeção:

- User ativo, sem marcadores de suspensão ou exclusão;
- Player ligado por `Player.userId`;
- memberships `ACTIVE`, sem `revokedAt`, nos roles fechados existentes;
- controles sem `revokedAt`, com `VIEW` ou `CONTROL`;
- atores do tipo `CHARACTER`;
- no máximo 20 campanhas e 100 controles, com sentinela de integridade.

O service confirma novamente a coerência de `userId`, campaign, membership,
controle e ator. `CONTROL` satisfaz leitura; `VIEW` não é promovido a controle;
um `OBSERVER` nunca recebe capacidade mutável. A projeção não publica role ou
permission porque a UI desta fase não precisa desses detalhes.

## Projeções públicas

`NarrativeContext` contém somente:

- nome público da campanha;
- nome público do personagem selecionado, quando houver;
- localização pública nullable;
- resumo público de continuidade;
- decisão pública pendente nullable;
- HP, Mana e SP resumidos quando já materializados;
- classificação narrativa.

`WidgetContext` contém somente:

- banner do ambiente;
- nome público do jogador;
- campanhas e personagens autorizados;
- seleção efêmera;
- recursos básicos;
- estado da tela, navegação e CTA;
- `canMutate: false` e `readOnly: true`.

Não existe `MasterContext` no contrato MCP. A consulta e os DTOs não selecionam
nem aceitam:

- metadata livre;
- descrição, appearance ou personality;
- GameEvent ou payload narrativo;
- inventário e conteúdo;
- objetivos secretos, armadilhas ou rolagens;
- resultados futuros;
- flags administrativas;
- issuer, subject, email, claims ou tokens;
- UUIDs, state versions, hashes ou referências internas.

O resumo de continuidade atual declara explicitamente que não existe checkpoint
narrativo público persistido. Não infere local, decisão, encontro ou sessão. A
fase não cria `GameSession`.

## Recurso UI

O recurso autenticado é:

```text
ui://game/authenticated-home/v1.html
```

Ele usa um bundle separado da fixture e mostra:

- autenticado sem Player;
- autenticado sem campanha;
- lista de campanhas;
- seleção de campanha/personagem somente por leitura;
- contexto selecionado;
- erro genérico de autorização;
- reconexão.

Em staging, o banner é exatamente `STAGING — CONTA SINTÉTICA`. Não há botões de
ataque, item, equipamento, criação, gameplay ou persistência. O input narrativo
e `sendFollowUpMessage` foram deixados para task separada para não misturar
leitura autenticada com um novo canal de intenção.

## Auditoria

O audit HTTP existente registra requestId, traceId, duração, tool, decisão e
reason code. User e seleção aparecem somente como fingerprints curtos. Tokens,
subject, email, payload estruturado, narrativa e dados de campanha não entram
no log.

`AuditEvent` persistente não é gravado em renderizações read-only desta fase,
evitando volume e escrita a cada remontagem. Uma futura política de auditoria
persistente deve definir retenção antes de ser ativada.

## Fixture sintética

O script versionado é:

```powershell
npm run staging:oauth:readonly-fixture -- --manifest backend/provisioning/staging/authenticated-readonly-fixture.v1.json --dry-run
npm run staging:oauth:readonly-fixture -- --manifest backend/provisioning/staging/authenticated-readonly-fixture.v1.json --apply
npm run staging:oauth:readonly-fixture -- --manifest backend/provisioning/staging/authenticated-readonly-fixture.v1.json --postflight
```

Ele exige:

- `APP_ENV=staging`;
- `STAGING_SUPABASE_PROJECT_REF=udqwzvhlwwfnngiipacj`;
- `DATABASE_URL` na role, database, schema, porta e TLS allowlisted;
- `OAUTH_ISSUER`;
- `STAGING_OAUTH_SYNTHETIC_SUBJECT`.

O User é localizado somente pela tupla exata de `ExternalIdentity`; email não
participa. O script cria ou reutiliza exatamente:

- Player `OAuth Staging Tester`;
- World `OAuth Test World`;
- Campaign `OAuth Readonly Test`;
- Actor `Test Adventurer`;
- CampaignMembership `PLAYER/ACTIVE`;
- ActorControl `CONTROL`.

O ruleset publicado `core-v1.3` é apenas reutilizado; o script falha se ele não
existir e nunca o cria. Dry-run executa a transação completa e força rollback.
Reexecução não duplica entidades. Grant revogado, código sintético usado fora
do grafo esperado ou fixture divergente falha
fechado em vez de reativar ou adotar dados. O pós-check exige um único grafo,
sem encontro, inventário, conteúdo de ator, conteúdo do World, NPC ou GameEvent.
O manifesto versionado é estrito e não contém subject, email, IDs, token,
credencial ou conexão.

Não há seed geral e não há migration na Fase 2D.

## Rollout

Após merge em `develop`, o pipeline deve classificar migrations como `none`,
executar `migrate deploy` como no-op, implantar o SHA exato e validar version,
health, readiness, `/mcp` e o resource server OAuth. Somente um push em
`develop` cujo intervalo completo adicione ou altere o manifesto aciona, depois
do release normal, o job protegido no Environment `staging-high-risk`. O job
aguarda aprovação, repete a prova do SHA live, executa dry-run, apply
transacional e postflight. Pushes comuns sem manifesto não aguardam esse gate.

O smoke MCP autenticado real continua posterior ao job e usa o fluxo OAuth
interativo da conta sintética. Access token, refresh token e credencial Auth não
são armazenados no GitHub Actions.

O App privado `Crônicas de Outro Mundo — OAuth Staging` deve continuar apontando
para `/mcp-auth`. Apps Local e Staging público, Actions/OpenAPI e a fixture
pública não são alterados.
