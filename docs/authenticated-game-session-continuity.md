# Seleção persistente e continuidade autenticada — Fase 2E

## Decisão de domínio

Não existia entidade semanticamente compatível com a seleção do jogador.
`mcp-session-id` identifica apenas o transporte efêmero; `Encounter` representa
uma sessão mecânica; `GameEvent` é ledger; `IdempotencyRecord` evita repetição;
e o widget v3 mantinha seleção somente em memória.

A Fase 2E cria `GameSession` como preferência persistente de
campanha/personagem. Existe no máximo uma linha por `userId + campaignId`; um
User pode possuir linhas em várias campanhas e a mais recentemente ativa é
usada por “Continuar”.

O lifecycle mínimo é `ACTIVE | CLOSED`. Uma sessão fechada pode ser reativada
pela operação de seleção. `stateVersion` pertence exclusivamente à sessão e não
altera versões de Campaign, Actor ou Encounter.

## Segurança e autorização

Toda seleção parte do `userId` derivado do Bearer validado. As referências
`sel_…` existentes são hashes opacos vinculados ao User e aos IDs internos. O
backend sempre relê e revalida User `ACTIVE`, Player vinculado, membership
ativa, `ActorControl` `VIEW` ou `CONTROL`, Actor `CHARACTER` ativo na Campaign e
Campaign não arquivada.

Referência inválida, alheia, revogada ou cruzada retorna a mesma negação
genérica. UUID bruto não é aceito. O widget apresenta acesso como “Somente
consulta” ou “Jogável”, sem expor o enum interno.

## Persistência e concorrência

`selectAuthenticatedGameContext` aceita:

```json
{
  "campaignSelectionRef": "sel_...",
  "characterSelectionRef": "sel_...",
  "idempotencyKey": "chave-estavel",
  "baseSessionVersion": 0
}
```

A operação usa transação `SERIALIZABLE`, claim no `IdempotencyRecord`, versão
otimista própria e `AuditEvent` na mesma transação. O namespace inclui User,
tool, Campaign e chave. Replay exato devolve o mesmo resultado sem duplicar
sessão ou evento. Versão obsoleta devolve `CONFLICT`/`RELOAD_REQUIRED`;
serialização ou deadlock devolve `SAFE_RETRY`.

O audit liga User, Campaign, Actor e `GameSession`, registra request/trace,
versões anterior/posterior, resultado, origem widget e somente um fingerprint
da chave. Token, email, subject, narrativa e payload estruturado não entram.

## Continuidade read-only

`loadAuthenticatedGameContext` continua sem escrita e não atualiza
`lastActiveAt`. Sem input, restaura a sessão ativa mais recente. Se membership,
controle, ator ou campanha deixarem de ser utilizáveis, retorna `UNAVAILABLE`,
remove a seleção da projeção e desabilita “Continuar”, sem apagar a sessão.

“Continuar” apenas recarrega seleção, contexto público e views read-only. Não
avança tempo, não envia intent, não resolve narrativa e não altera estado
mecânico.

## MCP e widget

O recurso atual é `ui://game/authenticated-home/v4.html`; v3 permanece
registrado apenas para compatibilidade de cache. As tools atuais são:

- `getAuthenticatedBootstrap`;
- `loadAuthenticatedGameContext`;
- `loadAuthenticatedCharacterView`;
- `selectAuthenticatedGameContext`.

Somente a última é mutável e app-only. Suas annotations são
`readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true` e
`openWorldHint: false`.

O widget mantém destaque, aba, loading e erro apenas em memória. A seleção só é
oficial após a resposta de sucesso. Remontagem, nova conversa, restart do
backend e nova sessão MCP reconstroem a seleção pelo PostgreSQL, sem
`localStorage`.

## Migration e rollout

A migration `20260726234500_authenticated_game_session_continuity` é aditiva:
enum, tabela, FKs, constraints, índices, vínculo opcional em `AuditEvent`, RLS
sem policies e revogação de `PUBLIC`, `anon`, `authenticated` e `service_role`.
Não contém DML, backfill, drop ou alteração de Campaign/Actor.

O classifier deve marcá-la `high`. O manifesto
`backend/provisioning/staging/authenticated-game-session-migration.v1.json`
autoriza somente caminho e checksum exatos desta task; qualquer outra migration
high continua bloqueada.
