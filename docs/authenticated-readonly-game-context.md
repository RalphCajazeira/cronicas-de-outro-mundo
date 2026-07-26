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

`loadAuthenticatedCharacterView` carrega sob demanda uma seção detalhada do
personagem já selecionado. O input fechado aceita:

```json
{
  "view": "SUMMARY | SHEET | INVENTORY | EQUIPMENT | ABILITIES",
  "campaignSelectionRef": "sel_...",
  "characterSelectionRef": "sel_...",
  "cursor": "cur_..."
}
```

O cursor existe somente em `INVENTORY` e `ABILITIES`, representa páginas de no
máximo 20 registros e é vinculado ao User, Actor, view e offset. Ele nunca é
prova de autorização: toda chamada resolve novamente User, Player, membership e
controle e a consulta Prisma repete a autorização dentro de uma transação
`REPEATABLE READ`.

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
controle e ator. `CONTROL` satisfaz leitura; `VIEW` não é promovido a controle.
As views detalhadas admitem `OWNER`, `GM` e `PLAYER`, mas não `OBSERVER`; role e
permission não são publicados.

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

As projeções detalhadas são cinco DTOs allowlisted:

- `CharacterSummaryView`: identidade pública, nível, status, campanha/mundo,
  HP/Mana/SP, contagem de efeitos e continuidade pública;
- `CharacterSheetView`: atributos armazenados e efetivos, recursos, progressão,
  atributos secundários, ruleset e efeitos públicos;
- `InventoryView`: moeda persistida, peso, até 20 itens por página, quantidade,
  categoria, estado e slots equipados;
- `EquipmentView`: os dez slots oficiais, item, requisitos, bônus e ação
  pública, sem controles de equipar;
- `AbilitiesView`: skill, spell e talent em `LEARNING`, `KNOWN` ou `MASTERED`,
  com perfil público validado, custo, alvo, efeitos e bônus.

Perícias, proficiências, profissões, fadiga, sono, qualidade, durabilidade e
cargas por instância não existem no schema atual. A resposta marca esses campos
como `NOT_PERSISTED_IN_CURRENT_VERSION`; não os infere.

Não existe `MasterContext` no contrato MCP. A consulta e os DTOs não publicam:

- metadata livre;
- appearance, personality, notes ou metadata;
- GameEvent ou payload narrativo;
- conteúdo bloqueado ou ainda não possuído;
- objetivos secretos, armadilhas ou rolagens;
- resultados futuros;
- flags administrativas;
- issuer, subject, email, claims ou tokens;
- UUIDs, state versions, hashes ou referências internas.

O resumo de continuidade atual declara explicitamente que não existe checkpoint
narrativo público persistido. Não infere local, decisão, encontro ou sessão. A
fase não cria `GameSession`.

## Recurso UI

O recurso autenticado v2 é:

```text
ui://game/authenticated-home/v3.html
```

Ele usa um bundle separado da fixture e mostra:

- autenticado sem Player;
- autenticado sem campanha;
- lista de campanhas;
- seleção de campanha/personagem somente por leitura;
- abas Resumo, Ficha, Inventário, Equipamento e Habilidades;
- carregamento lazy, retry idêntico, paginação e detalhe local;
- marcadores explícitos para dados ainda não persistidos;
- erro genérico de autorização;
- reconexão.

Em staging, o banner é exatamente `STAGING — CONTA SINTÉTICA`. Não há botões de
ataque, item, equipamento, criação, gameplay ou persistência. O cache, a aba e
o detalhe selecionado existem somente na instância do widget. Remontagem relê o
contexto oficial. O input narrativo e `sendFollowUpMessage` permanecem fora do
escopo.

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
- Actor `Test Adventurer`, nível 3, com identidade pública sintética;
- CampaignMembership `PLAYER/ACTIVE`;
- ActorControl `CONTROL`.
- nove atributos, três recursos e snapshot mecânico `core-v1.3`;
- sete definições/versionamentos sintéticos allowlisted;
- três itens de inventário, incluindo armadura equipada, consumível e item
  narrativo;
- skill, spell e talent/passive vinculados ao Actor;
- um efeito público temporário.

O registry oficial materializa ou reutiliza de modo determinístico o ruleset e
os registries compatíveis `core-v1.3`. Dry-run executa a transação completa e
força rollback.
Reexecução não duplica entidades. Grant revogado, código sintético usado fora
do grafo esperado ou fixture divergente falha
fechado em vez de reativar ou adotar dados. O pós-check exige um único grafo,
os counts exatos do manifesto, códigos de conteúdo na allowlist, ausência de
encontro, NPC e GameEvent, e uma ficha mecânica cujo hash continua válido.
O manifesto versionado é estrito e não contém subject, email, IDs, token,
credencial ou conexão.

Não há seed geral e não há migration na Fase 2D.

## Rollout

Após merge em `develop`, o pipeline deve classificar migrations como `none`,
executar `migrate deploy` como no-op, implantar o SHA exato e validar version,
health, readiness, `/mcp` e o resource server OAuth. Somente um push em
`develop` cujo intervalo completo adicione ou altere o manifesto aciona, depois
do release normal, o job protegido no Environment `staging-high-risk`. O job
é admitido automaticamente apenas para `develop`, repete a prova do SHA live,
executa dry-run, apply transacional e postflight. Não há required reviewer nem
wait timer; a autorização vem da task e os controles automáticos permanecem
fail-closed. Pushes comuns sem manifesto não acessam esse Environment.

O smoke MCP autenticado real continua posterior ao job e usa o fluxo OAuth
interativo da conta sintética. Access token, refresh token e credencial Auth não
são armazenados no GitHub Actions.

O App privado `Crônicas de Outro Mundo — OAuth Staging` deve continuar apontando
para `/mcp-auth`. Apps Local e Staging público, Actions/OpenAPI e a fixture
pública não são alterados.
