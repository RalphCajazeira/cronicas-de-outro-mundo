# Contexto do projeto — Crônicas de Outro Mundo

## Classificação e objetivo

Projeto de RPG narrativo reiniciado como nova versão, com o sistema anterior arquivado. O objetivo atual é oferecer uma API segura e reproduzível para estado de mundos, campanhas, atores e conteúdo mecânico, consumida futuramente pelo GPT e por um frontend.

## Decisões aprovadas

- npm, Node.js, TypeScript, Express, Zod, PostgreSQL e Prisma.
- `backend/` é a camada principal; `frontend/` só será criado em fase própria.
- Prisma Migrate é a única autoridade do novo schema.
- Supabase é inicialmente apenas provedor PostgreSQL hospedado.
- Frontend e GPT nunca acessam Prisma, tabelas ou credenciais privilegiadas diretamente.
- O sistema antigo não será migrado automaticamente.

## Implementação atual

- API GPT v1 com criação estruturada e transacional de novo jogo, carga de estado, leitura e persistência de atores, conteúdo, progressão e eventos. `startGame` cria ou valida Player/World explicitamente, sempre cria Campaign nova e persiste configurações versionadas, protagonista, conteúdos, vínculos e `campaign-started`; a resposta traz prontidão mecânica explícita e o encontro exige uma ação inicial completa e utilizável.
- Descoberta somente leitura de mundos/campanhas e refs explícitas em todas as operações escopadas, sem defaults de save ou inferência de “última campanha”.
- Chave interna temporária `x-rpg-key` em `/api/v1`.
- OpenAPI 3.1 ativo em `gpt/openapi.json` e `/openapi.json`; artefatos atuais do GPT separados do legado.
- Idempotência transacional persistida no PostgreSQL, readiness segura e migration incremental de RLS/revogações.
- `Ruleset(core)` e `RulesetVersion(core-v1/RC1.1)` persistem manifesto canônico e hash SHA-256; todo World recebe um default obrigatório e toda Campaign copia um vínculo imutável na criação.
- A ficha mecânica de Actor é autoritativa no backend: nove atributos normalizados, HP/Mana/SP atuais e snapshot derivado recomputável pelo `core-v1`; clientes nunca enviam máximos ou derivados.
- O núcleo `core-v1` valida fichas canônicas de 13 tipos e sua configuração possui publicação própria `core-v1-content-v1`. `ContentDefinition` guarda identidade, `ContentVersion` guarda snapshots imutáveis e `ActorContent` fixa a versão concedida. `startGame`, `upsertContent`, `getContent`, `loadGame` e `manageActorContent` usam essa fronteira versionada.
- O `core-v1-inventory-v1` possui publicação imutável própria e agora sustenta inventário físico persistido por instâncias ou stacks fixados em uma `ContentVersion`, equipamento atômico por slots, peso/carga RC1.1 e modificadores equipados aplicados ao snapshot. `ActorContent` permanece apenas progressão/conhecimento.
- `manageActorInventory` é a única operação pública de inventário; escritas são idempotentes, usam `expectedInventoryStateVersion`, lock do Actor e recomputação mecânica na mesma transação. `startGame` reutiliza a mesma orquestração para inventário inicial.
- O módulo `core-v1-effects-v1` mantém o cálculo puro e agora possui persistência autoritativa versionada por `EffectRulesVersion`. `resolveActorEffect` consulta efeitos ou executa conteúdo/consumível em transação única, com locks ordenados, tokens otimistas, rolls criptográficos gerados no backend, recursos versionados, efeitos ativos, inventário e auditoria idempotente.
- Referências `apply_status`/`remove_status` são resolvidas na publicação e fixadas por `ContentEffectBinding` a uma `ContentVersion` exata; novas versões do status não alteram fontes já publicadas.
- `Campaign.engineTick` é o relógio mecânico persistido. `Actor.effectsStateVersion` participa do snapshot e efeitos ativos aplicam modificadores na recomposição. Fora de um encerramento confirmado, HP zero não altera status; a Fase 1M-A marca somente participantes persistidos `ACTIVE` com HP zero como `DEFEATED`, e cura oficial de 0 para valor positivo reativa somente `DEFEATED`.
- O núcleo puro `core-v1-encounter-v1` compõe participantes, relações, zonas, iniciativa, action slots, targeting, timeline, reações/cooldowns, casting/channel, movimento, combos, action plans e resolução independente de efeitos por alvo. A Fase 1L-B acrescenta o adaptador interno transacional/idempotente, snapshots validados, drift, rolls lazy e mutações atômicas. A Fase 1L-C expõe somente a facade segura `POST /api/v1/encounters/manage`, uma GPT Action multiplexada, com escopo explícito, idempotência, versão otimista, DTO reduzido e auditoria allowlisted.
- A Fase 1M-A encerra ou cancela encontros em uma única transação com outcome derivado pelo backend, status `DEFEATED`, limpeza exclusivamente dos efeitos `ENCOUNTER` originados no encontro, recomposição, um evento terminal e um ledger append-only. XP, level-up, ouro e loot continuam adiados.
- `loadGame` valida o único encontro não terminal e projeta se ele pode continuar/cancelar ou se há drift de autoridade recuperável. Múltiplos ativos e corrupção estrutural falham fechados. Escritas externas em ator, conteúdo vinculado, inventário ou efeitos de participantes ativos são bloqueadas sob lock de Campaign; `manageEncounter(abandon)` pode fechar somente drift confirmado como `FAILED`, sem processar ações ou recompensas.
- A resolução por beat amplia `manageEncounter` sem migration: a cena é carregada uma vez e `resolve_beat` internaliza ação composta limitada, NPCs, reações, checkpoint e conclusão. Política parcial é explícita, componentes nunca são omitidos, mais de três componentes ou quatro NPCs elegíveis rejeitam antes da escrita. O fluxo granular permanece como fallback; o backend e o GPT Builder de staging já executam esta versão.
- Auditoria HTTP estruturada com `x-request-id`, resumos seguros de requisição/resposta e caminhos de validação, sem headers ou payloads sensíveis.
- Blueprint Render de staging nativo Node, Free em `virginia`, branch `develop`, sem Docker, sem pre-deploy e sem deploy automático.
- Staging ativo no Render `cronicas-de-outro-mundo-staging-api`, projeto `Game-GPT`, workspace `Ralph’s workspace`, em Virginia e no commit `9371d9ce1ddbd59fb031177cdc2b4b8cb679fbfa`.
- PostgreSQL de staging no Supabase `cronicas-de-outro-mundo-staging-virginia`, ref `udqwzvhlwwfnngiipacj`, Free em `us-east-1`, com a role dedicada `cronicas_staging_app`, dez migrations e nenhum seed. O runtime usa Supavisor Session na porta 5432 com TLS completo; a conexão direta fica restrita ao gate local de migrations.
- O staging anterior `cronicas-de-outro-mundo-staging`, ref `cqxabsnuvngtkpbrgson`, em `sa-east-1`, permanece vazio, pausado, desconectado do Render e não foi deletado.
- Benchmark remoto Render Virginia → Supabase North Virginia: `startGame` mínimo 1,19/1,33/1,68 s e 215 queries; pacote completo 2,22/2,27/2,73 s e 459 queries; `loadGame` 0,32/0,55/0,87 s e 35 queries. Os três gates passaram sem elevar timeout, com readiness pronta, replay idempotente e smoke direto autoritativo.
- O GPT Builder `Crônicas de Outro Mundo — Staging` foi publicado com Instructions, os nove arquivos de Knowledge e o OpenAPI versionados, mantendo 20 Actions únicas. O smoke em conversa nova confirmou Criação Rápida, estado salvo, conteúdos mecânicos e narrativo, encontro, erros acionáveis e ataque autoritativo; a limpeza posterior deixou o banco funcional vazio.

## Decisões pendentes

- Autenticação pública, identidade e autorização por usuário.
- Política de CORS, rate limit e retenção/exportação de logs para exposição além do GPT/admin.

## Fases futuras

Frontend React, operação explícita de upgrade de conteúdo do ator, XP/level-up na Fase 1M-B, ouro/drop/claim de loot na Fase 1M-C, comércio, lojas, facções, relações, memórias detalhadas, viagens, clima e snapshots narrativos.

## Segurança

Não há credenciais de usuário no modelo `Player`. Nenhum secret deve ser versionado ou registrado. Banco remoto não é alterado automaticamente, migrations não rodam no startup e o backend é a única fronteira autorizada para acesso privilegiado.
