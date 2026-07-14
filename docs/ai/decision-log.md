# Decision Log

## 2026-07-13 — Fase 1K de orquestração pura de encontros

Decisões:

- adotar a identidade interna `core-v1-encounter-v1`, schema 1, sem publicar ou alterar manifestos/hashes das Fases 1C, 1E, 1G ou 1I;
- compor a event queue, ticks, prioridades, action slots, iniciativa, targeting, inventário/equipamento e resolução de efeitos existentes em um `CoreV1EncounterState` imutável e ordenado;
- exigir relações autoritativas e contexto espacial fechado para area/cleave/chain, sem inferência por tipo de ator, grid, coordenadas ou expressão livre;
- manter rolls fora das intenções e injetá-los por `EncounterRollProvider`; manter outcomes de reação sem fórmula publicada atrás de `ReactionOutcomeResolver`;
- processar eventos do mesmo tick sequencialmente, revalidar após cada evento, aplicar custo/self effects uma vez e resolver cada alvo de forma independente;
- limitar participantes, targets, eventos, lotes, combos, planos e avanço de ticks como proteção operacional, sem tratá-los como novo balanceamento;
- deixar Prisma, migrations, persistência de combate, HTTP/OpenAPI, tokens, RNG persistido, XP, loot, deploy e GPT ao vivo para fases próprias; a Fase 1L será o adaptador autoritativo futuro.

Status: implementada e validada na Fase 1K; revisão e integração rastreadas pelo PR correspondente

## 2026-07-13 — Fase 1I de resolução pura de efeitos, recursos e estados ativos

Decisão:
- criar `core-v1-effects-v1`, schema 1, como identidade interna pura sem modificar RC1/RC1.1 ou hashes publicados;
- reutilizar custos, precisão, crítico, dano, mitigação, ticks, conteúdo canônico e operações puras de inventário existentes;
- modelar projeções defensivas de recursos/atores, rolls injetados, relatórios de custo/dano/restauração e eventos conceituais allowlisted;
- representar estados ativos versionados com duração por ticks/actions/scopes, stacking completo, expiração explícita e coleta determinística de modificadores;
- executar sequências sobre cópias, com custo único e falha atômica, e planejar uso de consumível de alvo único com consumo posterior ao sucesso;
- manter periodicidade, upkeep executado, timeline, RNG gerado, `Actor.status`, persistência, Prisma, HTTP/OpenAPI, deploy e GPT ao vivo fora do escopo.

Impacto:
- serviços autoritativos futuros podem reproduzir a mesma resolução a partir de projeções e rolls persistíveis, sem duplicar fórmulas;
- o GPT continua enviando intenção e conteúdo proposto, nunca hit, crítico, dano final, recursos ou estados como autoridade;
- a Fase 1J deverá integrar persistência/transações e a composição multi-target sem alterar retroativamente esta identidade.

Status: implementada e validada na Fase 1I; revisão e integração rastreadas pelo PR correspondente

## 2026-07-13 — Fase 1H de inventário e equipamento persistentes

Decisão:
- separar definitivamente `ActorContent` (conhecimento/progressão) de posse física, removendo `equipped` e `quantity` sem copiar dados;
- publicar `InventoryRulesVersion(core-v1-inventory-v1)` como manifesto imutável com hash e fixar `inventorySpec` a cada `ContentVersion` física;
- persistir instâncias/stacks em `InventoryEntry` e derivar equipamento apenas de `ActorEquipmentSlot`, inclusive para itens multisslot;
- centralizar todas as mutações em uma orquestração com lock do Actor, versão otimista, idempotência e recomputação mecânica atômica;
- aplicar peso, encumbrance e modificadores de equipamento na ficha autoritativa, com hash sem IDs/timestamps;
- usar migration clean-slate, constraints/triggers/RLS e nenhum backfill, delete, truncate ou acesso remoto;
- manter consumo/aplicação de efeitos, combate, durabilidade, lojas, deploy e atualização do GPT ao vivo fora do escopo.

Impacto:
- `manageActorInventory` passa a ser a única fronteira pública para posse/equipamento e `startGame` reutiliza o mesmo service;
- clientes devem enviar `expectedInventoryStateVersion` em toda escrita e resolver conflitos recarregando o inventário;
- conteúdo físico exige spec versionado e a resposta pública usa apenas refs estáveis, slots derivados e resumos de carga.

Status: implementada e validada na Fase 1H; revisão e integração rastreadas pelo PR correspondente

## 2026-07-13 — Fase 1G de inventário, carga e equipamento puros

Decisão:
- criar a identidade `core-v1-inventory-v1`, schema 1, separada do manifesto numérico RC1.1 e da publicação `core-v1-content-v1`;
- manter `ActorContent` como vínculo conceitual e representar posse física futura por instâncias únicas ou stacks homogêneos fixados em uma versão pública exata;
- manter peso, stacking e declarações físicas complementares em `CoreV1InventorySpec`, sem inferência por descrição e sem alterar retroativamente o perfil publicado da Fase 1E;
- limitar operações a 256 entradas, stacks a 999 unidades e loadouts a 32 instâncias, rejeitando duplicidade, protótipos inesperados, arrays esparsos, mutação e overflow;
- reutilizar capacidade derivada e thresholds RC1.1 de carga, com comparação inteira segura para 70%, 100% e 125%;
- modelar catálogo fixo de slots, armas de uma/duas mãos e versáteis, multisslot atômico, planejamento sem substituição silenciosa e requisitos avaliados sobre projeções públicas;
- coletar modificadores passivos equipados com origem tipada, sem aplicá-los ou recomputar o snapshot;
- manter Prisma, migrations, `ItemInstance`, repositories, HTTP, OpenAPI, comércio, loot, uso de consumível, efeitos, combate, banco remoto, deploy e GPT ao vivo fora do escopo;
- reservar persistência, transações e recomputação autoritativa para a Fase 1H.

Impacto:
- regras futuras de inventário e equipamento passam a ter comportamento reproduzível e testável antes da escolha do modelo persistido;
- publicar conteúdo v2 não transforma nem funde automaticamente entradas v1;
- o contrato ativo ainda não oferece operação de inventário ao GPT ou frontend.

Status: implementada e validada na Fase 1G; revisão e integração rastreadas pelo PR correspondente

## 2026-07-13 — Fase 1E de conteúdo mecânico canônico puro

Decisão:
- criar uma fronteira interna `core-v1` para validar, sem infraestrutura, os 13 tipos canônicos de conteúdo mecânico e os perfis narrativos permitidos;
- exigir identidade `schemaVersion: 1`/`rulesetCode: core-v1`, tier 1–10, raridade configurável, capacidade mecânica reconhecida e objetos runtime fechados;
- manter elementos em catálogo versionado, canais físico/mágico separados, imunidades explícitas e componentes de dano dentro do envelope e do limite de seis componentes;
- reutilizar integralmente custos RC1, targeting/multi-target RC1.1, perfis temporais, reações, papéis/orçamentos NPC e inteiros seguros existentes;
- modelar defesa, activation, duration sem rodadas, efeitos discriminados, stacking, modificadores, requisitos e creature templates sem aplicar resultado mecânico;
- retornar erros estruturados e retryable para entrada esperadamente inválida, preservando determinismo, ausência de mutação e cópias defensivas da configuração;
- manter manifesto persistido, Prisma, migrations, HTTP, OpenAPI, banco, inventário, equipamento, combate, deploy e GPT ao vivo inalterados;
- reservar persistência e integração do contrato para a Fase 1F.

Impacto:
- o GPT pode propor fichas completas, mas o núcleo do backend define a validade canônica e rejeita conteúdo incompleto ou fora do tier;
- consumíveis passam a ter representação mecânica numérica validável, sem cura/gasto aplicado;
- nenhuma definição é persistida ou publicada por endpoint nesta fase.

Status: implementada e validada na Fase 1E; revisão e integração rastreadas pelo PR correspondente

## 2026-07-13 — Fase 1D de persistência autoritativa da ficha de atores

Decisão:
- retirar de `Actor` os campos livres `health`, `maxHealth`, `mana`, `maxMana`, `attributes`, `resistances` e `affinities`;
- persistir exatamente nove `ActorAttribute`, três `ActorResource` atuais e um `ActorDerivedSnapshot` por ator;
- manter máximos e derivados exclusivamente como resultados do `core-v1`, com snapshot auditável ligado à `RulesetVersion` e hash SHA-256 canônico dos inputs;
- usar contadores inteiros de estado, recomputação transacional única e leitura que detecta contagem inválida, drift, ruleset incompatível e snapshot stale;
- tornar `startGame` autoritativo para protagonista nível 1/XP 0 e restringir criação de demais atores a nível 1–20; patch comum passa a aceitar apenas identidade/narrativa;
- exigir clean slate de Actor na migration, sem backfill, limpeza, conversão, fallback ou colunas paralelas;
- manter gasto/cura/dano, inventário, equipamento, progressão, cenas, combate, deploy e atualização do GPT ao vivo fora desta fase.

Impacto:
- o GPT propõe somente os nove atributos, nível permitido e conteúdo narrativo; recursos máximos e derivados deixam de ser autoridade do cliente;
- respostas públicas entregam `primaryAttributes`, recursos current/max, derivados, versão mecânica e identidade do ruleset, sem UUIDs ou hash;
- rollout remoto futuro requer limpeza funcional deliberada antes da migration e atualização posterior da Action/GPT.

Status: implementada e validada na Fase 1D; revisão e integração rastreadas pelo PR correspondente

## 2026-07-13 — Fase 1C de persistência e vínculo imutável do ruleset

Decisão:
- persistir a família `Ruleset(code=core)` e a publicação imutável `RulesetVersion(code=core-v1, revision=RC1.1, schemaVersion=1)`;
- representar a configuração/identidade aprovada em manifesto JSON canônico, sem duplicar código executável, e calcular seu hash somente com SHA-256 de `node:crypto`;
- tornar `World.defaultRulesetVersionId` e `Campaign.rulesetVersionId` obrigatórios, copiando o default do World no insert da Campaign;
- bloquear no PostgreSQL update/delete de `RulesetVersion` e qualquer troca real de `Campaign.rulesetVersionId`;
- garantir e validar a versão oficial dentro da transação de `startGame`, sem aceitar seleção de ruleset pelo GPT e sem alterar HTTP/OpenAPI;
- usar constraints únicas como autoridade de concorrência, savepoints locais para colisões `P2002` esperadas e releitura/validação do vencedor;
- exigir clean slate: a migration falha claramente diante de World/Campaign antigos e nunca apaga ou converte dados;
- manter `legacy-v0`, backfill, dual-read/dual-write, combate persistido e demais entidades da Fase 1D fora do escopo;
- não acessar staging, Supabase remoto, deploy ou configuração do GPT nesta fase.

Impacto:
- campanhas passam a apontar para uma configuração mecânica auditável e não podem mudar silenciosamente de versão;
- replays futuros podem identificar o pacote por code/revision/hash sem expor o snapshot ao contrato público;
- o rollout remoto futuro exige limpeza funcional explícita antes da migration e gate manual normal de staging.

Status: implementada e validada na Fase 1C; revisão e integração rastreadas pelo PR correspondente

## 2026-07-13 — Fase 1B de timeline e economia de ações pura

Decisão:
- implementar a economia de ações `core-v1 numerical RC1.1` em um módulo puro, determinístico e sem banco;
- representar todo tick como `bigint`, com timeline contínua que salta ao próximo evento e processa eventos do mesmo tick sequencialmente;
- ordenar eventos por prioridade, iniciativa e desempates injetados, revalidando os eventos posteriores após cada resolução;
- modelar perfis temporais, velocidades física/mágica/híbrida, iniciativa, slots, casting, movimento por zonas, reações de profundidade máxima 2, combos atômicos, planos limitados e threat temporal;
- manter reserva/consumo de Mana, custo de SP, progressão temporal e demais recursos como deltas ou custos conceituais;
- limitar planos a cinco ações primárias, 32 eventos e 5000 ticks por processamento, sem continuation token nesta fase;
- manter persistência, repositories, Prisma, HTTP, OpenAPI e resolução completa de combate para a Fase 1C ou posterior;
- preservar números calibráveis por revisão e exigir nova versão e telemetria futura para recalibração.

Impacto:
- serviços autoritativos futuros podem compor a timeline sem duplicar fórmulas ou depender de infraestrutura;
- eventos equivalentes permanecem reproduzíveis quando o chamador fornece o desempate RNG persistível;
- nenhuma migration, dependência, mudança de ambiente ou contrato público HTTP é necessária.

Status: implementada e validada na Fase 1B; revisão e integração rastreadas pelo PR correspondente

## 2026-07-13 — `core-v1 numerical RC1.1` e Fase 1A numérica pura

Decisão:
- aprovar `core-v1 numerical RC1.1` como base oficial do Game Engine incremental, com nove atributos fixos, backend autoritativo, clean slate e ausência de `legacy-v0`;
- implementar na Fase 1A apenas matemática pura e versionada para atributos, recursos, derivados, precisão, crítico, componentes de dano, mitigação, envelopes, custos, progressão e papéis/threat base de NPC;
- manter Prisma, migrations, repositories, HTTP, OpenAPI, GPT, RNG, inventário e estado persistido de combate fora desta fase;
- reservar timeline, action time, initiative scheduling, action plans, economia temporal e reações em runtime para a Fase 1B;
- processar futuramente eventos no mesmo tick em sequência determinística por prioridade do tipo, initiative score, Agilidade, Percepção, Sorte, RNG persistido e referência estável, revalidando o estado após cada evento;
- limitar futuramente a cadeia a `reactionDepth` 0 para a ação originadora, 1 para no máximo uma reação defensiva e 2 para no máximo um contra-ataque terminal explicitamente permitido; profundidade 2 não gera nova reação ou contra-ataque;
- manter coeficientes de balanceamento configuráveis por versão e exigir telemetria para recalibrações futuras;
- manter tabelas internas imutáveis em runtime, expor cópias defensivas e rejeitar entradas ou intermediários fora de inteiros seguros;
- tratar limites de inventário de NPC como configuração provisória para telemetria, sem runtime de inventário nesta fase.

Impacto:
- serviços autoritativos futuros poderão reutilizar o núcleo sem dependência de banco ou transporte;
- o contrato GPT atual não é ampliado e os dados funcionais existentes não são convertidos;
- nenhuma migration, dependência ou alteração de ambiente faz parte da Fase 1A.

Status: implementada e validada na Fase 1A; revisão e integração rastreadas pelo PR #9

## 2026-07-12 — Criação estruturada, segura e sem migration

Decisão:
- ampliar `startGame` sem alterar o schema Prisma, usando `World.metadata.worldConfig` e `Campaign.metadata.campaignConfig` com `schemaVersion: 1`;
- exigir modos `create|reuse` para Player e World, validando reutilizados sem atualização silenciosa, e sempre criar Campaign nova;
- criar protagonista com aparência, personalidade e origem, definições globais/específicas, vínculos e um evento técnico `campaign-started` na mesma transação idempotente;
- usar dificuldade por preset com overrides parciais e perfil efetivo calculado; `custom` exige as seis dimensões;
- interpretar `equipped` como conteúdo selecionado/preparado/em uso, sem inventário por instância ou slots;
- limitar `startGame` a 80 KB, 24 pacotes e JSON controlado;
- tratar como retry idempotente somente colisão `P2002` comprovada por metadata estruturada de `IdempotencyRecord.key`.
- exigir que `className` coincida exatamente com o nome público da classe mecânica inicial, inclusive ao reutilizar definição persistida;
- montar `campaign-started` por DTO allowlisted de até 8 KB UTF-8 e manter seu `idempotencyKey` nulo, deixando a idempotência exclusivamente no registro da operação;
- nunca reproduzir resposta idempotente ausente ou vazia como sucesso.

Impacto:
- não há migration nem dependência nova;
- conteúdos `reuse` enviam somente mode, escopo global, tipo e code;
- checkpoint, inventário físico, combate e demais subsistemas especializados continuam adiados.

Status: implementado na branch de feature; validação e merge pendentes

## 2026-07-11 — Reinicialização da plataforma Node

Contexto:
- A arquitetura anterior dependia de GPT Actions, Edge Functions, RPCs e migrations históricas incompletas.

Decisão:
- Arquivar a v1 em `legacy/supabase-gpt-v1/` e iniciar runtime Node.js + TypeScript.
- Usar Express, Zod, PostgreSQL, Prisma Client 7 com `@prisma/adapter-pg` e npm.
- Fazer do Prisma Migrate a única autoridade do novo schema.
- Tratar Supabase apenas como PostgreSQL hospedado e manter acesso privilegiado exclusivo no backend.

Impacto:
- backend: nova API modular, inicialmente somente leitura;
- frontend: fase futura, sempre consumidor da API;
- banco: schema novo não incorpora migrations legadas automaticamente;
- deploy: autenticação, CORS, rate limit e auditoria ainda devem ser decididos;
- testes: Vitest e Supertest sem banco real nos testes HTTP.

Status: implementada

## 2026-07-11 — API GPT v1 e idempotência transacional

Decisão:
- preservar as leituras atuais e adicionar carga de estado, escrita de atores/conteúdo, progressão e eventos sob `/api/v1`;
- exigir `idempotencyKey` nas escritas e persistir chave, hash e resposta na mesma transação Prisma;
- retornar a resposta persistida para repetição idêntica e `409` para reutilização incompatível;
- manter combate avançado, inventário físico e autenticação pública fora desta fase.

Status: implementada localmente, ainda sem commit/deploy

## 2026-07-11 — Contrato GPT ativo e preparação de produção

Decisão:
- tornar `gpt/openapi.json` o contrato OpenAPI 3.1 ativo e servi-lo com `PUBLIC_BASE_URL`;
- manter o GPT legado apenas como referência;
- preparar Render Node nativo com readiness e migration pré-deploy, sem migration/seed no startup;
- habilitar RLS sem policies e revogar condicionalmente `anon`/`authenticated` nas tabelas Node;
- usar futuramente usuário PostgreSQL específico, `DATABASE_URL` no runtime e `DIRECT_URL` em migrations, com secrets somente no Render.

Status: preparado localmente; decisões e execução remotas pendentes

## 2026-07-11 — Dependências atuais com compatibilidade segura

Decisão:
- Usar as versões estáveis atuais compatíveis entre si.
- Manter TypeScript 6.0.3 enquanto `typescript-eslint` estável não suportar TypeScript 7.
- Aplicar overrides transitivos seguros para vulnerabilidades do toolchain Prisma sem downgrade ou `--force`.

Status: implementada

## 2026-07-11 — Chave interna temporária

Decisão:
- Proteger `/api/v1` com `x-rpg-key`; manter `/health` público.
- Não representar essa chave como autenticação pública definitiva.

Status: implementada

## 2026-07-11 — Escopo inicial do domínio

Decisão:
- Modelar Player, World, Campaign, Actor, ContentDefinition, ActorContent e GameEvent.
- Adiar combate, inventário físico, comércio, frontend e demais sistemas detalhados.
- Não alterar banco remoto nesta etapa.

Status: implementada

## 2026-07-11 — Estratégia automatizada de testes do backend

Decisão:
- manter unitários e HTTP com Supertest como suíte rápida, sem banco e sem porta;
- reservar integração para repositories, Prisma, migrations, seed, constraints, índices e relações;
- recriar exclusivamente o PostgreSQL local `game_gpt_test` após validações de segurança;
- usar scripts npm como fluxo normal de validação e testes manuais somente para investigação focal.

Status: implementada

## 2026-07-12 — Staging Render Free com gate manual de migrations e TLS completo

Decisão:
- fixar no Blueprint o projeto `Game-GPT`, ambiente `Staging`, serviço `cronicas-de-outro-mundo-staging-api`, branch `develop`, região `virginia`, plano Free e auto-deploy desligado;
- remover o pre-deploy, indisponível no plano Free, sem mover migrations para build, start, startup ou health check;
- exigir `prisma validate`, `prisma migrate status`, `prisma migrate deploy` e novo status como gate manual antes de cada deploy;
- usar Supavisor Session mode com `sslmode=verify-full`, CA oficial do Supabase e `NODE_EXTRA_CA_CERTS` definido antes do startup do processo;
- cadastrar a CA futuramente como secret file do Render em `/etc/secrets/supabase-ca.crt`;
- fazer a primeira criação pelo formulário manual do projeto/ambiente para inserir a CA antes do primeiro deploy, usando o Blueprint como configuração reproduzível para sincronizações posteriores;
- manter seed, Docker, auto-deploy e recursos pagos fora do staging.

Impacto:
- `DIRECT_URL` permanece local ao gate de migrations e não é secret do serviço Render;
- `DATABASE_URL`, `RPG_API_KEY` e `PUBLIC_BASE_URL` permanecem secrets/valores protegidos do serviço;
- cada deploy manual depende de evidência de schema atualizado e TLS com cadeia e hostname validados;
- rollback usa deploy anterior e migration corretiva, nunca reset destrutivo.

Status: preparado e validado localmente; serviço Render ainda não criado

## 2026-07-12 — Consolidação do Knowledge ativo por domínio

Decisão:
- manter nove arquivos oficiais de Knowledge, organizados por narrativa, atores/conteúdo, limites, poderes, criaturas, mundo, missões, memória e fichas;
- reutilizar princípios narrativos válidos do legado após revisão por seção, sem copiar contratos Supabase, Actions, tabelas ou campos obsoletos;
- classificar cada regra como persistência estruturada, persistência genérica, regra narrativa ou sistema futuro;
- fazer do backend e do OpenAPI atuais a autoridade para qualquer afirmação de capacidade;
- proibir o envio de `legacy/supabase-gpt-v1/` ao GPT ativo.

Impacto:
- o corpus deixa de comprimir domínios distintos em três arquivos insuficientes;
- combate, inventário, lojas, relações, memórias especializadas, Codex e viagens permanecem explicitamente adiados;
- regras narrativas podem orientar coerência sem prometer persistência inexistente.

Status: implementada

## 2026-07-12 — Auditoria sanitizada da comunicação GPT/backend

Decisão:
- emitir um evento JSON `http_request_completed` por requisição e devolver `x-request-id` para correlação;
- registrar método, caminho, status, duração e apenas resumos allowlisted da entrada e da resposta;
- registrar caminhos/códigos de validação e fingerprint reduzida da chave idempotente para diagnosticar escritas GPT;
- nunca registrar headers, API key, chave idempotente original, notas narrativas, valores livres de metadata/payload, stack traces ou connection strings;
- devolver em `INVALID_INPUT` somente caminhos e orientações seguras para uma correção automática limitada a uma tentativa;
- não orientar retry automático para `UNAUTHORIZED`, `NOT_FOUND`, `CONFLICT` ou `INTERNAL_ERROR`;
- usar o log efêmero do Render somente para diagnóstico, preservando o PostgreSQL como fonte de verdade.

Impacto:
- falhas de Action podem ser analisadas diretamente por operação, status, caminho de validação e `requestId`;
- a visibilidade aumenta sem transformar logs em cópia do estado narrativo ou novo repositório de dados sensíveis;
- retenção/exportação centralizada permanece uma decisão futura.

Status: implementada localmente; deploy pendente

## 2026-07-12 — Novo jogo criado integralmente pelo GPT

Decisão:
- adicionar `startGame` para criar Player, World, Campaign e protagonista em uma transação idempotente;
- permitir limpeza integral dos dados de aplicação no staging, preservando schema e migrations;
- interpretar `NOT_FOUND` ou `protagonist: null` em `loadGame` como início de configuração;
- exigir protagonista `character` com `code` igual a `playerRef` e recarregar o estado antes da primeira cena;
- recusar sobrescrita de campanha que já contenha atores, conteúdo ou eventos;
- não expor reset destrutivo como Action do GPT.

Status: preparado localmente; limpeza e validação online pendentes

## 2026-07-12 — Leituras GPT determinísticas por Player, World e Campaign

Decisão:
- exigir `playerRef`, `worldRef` e `campaignRef` explícitos em operações que leem ou alteram estado de campanha, removendo defaults que poderiam selecionar outro save;
- resolver atores somente pela chave composta da campanha e exigir `contentType` na leitura de ContentDefinition;
- para conteúdo, priorizar a definição específica da Campaign e permitir fallback apenas para a definição global do mesmo World, tipo e code;
- adicionar `listPlayerWorlds` e `listWorldCampaigns`, com ordenação por ref e DTOs sem UUIDs;
- não manter ponte de compatibilidade, fallback para save único, busca por UUID interno ou seleção implícita de escopo;
- não inferir “último save” sem critério persistido.

Impacto:
- clientes antigos que omitem refs recebem `400 INVALID_INPUT` e precisam seguir o fluxo de descoberta;
- o contrato passa a suportar mundos/campanhas com codes repetidos em escopos distintos sem leitura cruzada;
- nenhuma migration ou alteração de dados é necessária.

Status: implementada localmente; deploy e atualização da Action pendentes

## 2026-07-13 — Conteúdo canônico publicado em versões imutáveis

Decisão:
- publicar a configuração validável da Fase 1E em `ContentProfileVersion(core-v1-content-v1)` sem alterar o manifesto numérico `core-v1/RC1.1`;
- reduzir `ContentDefinition` a identidade/lifecycle e mover todo conteúdo mutável para `ContentVersion` numerada, imutável e hashada canonicamente;
- centralizar seed, `startGame` e `upsertContent` em `publishContentVersion`, com advisory lock transacional e deduplicação por hash;
- vincular `ActorContent` a uma versão exata por FK composta, sem upgrade implícito quando uma v2 é publicada;
- preservar prioridade Campaign e fallback somente para conteúdo global do mesmo World;
- aceitar perfil validado para 13 tipos canônicos e perfil nulo para os tipos narrativos genéricos, removendo `mechanics`/`requirements` livres dos requests;
- adotar migration clean-slate sem preservação, conversão ou remoção automática de dados funcionais.

Impacto:
- `upsertContent` preserva o operationId, mas “update” passa a significar publicar nova versão;
- triggers impedem update/delete de publicações e alteração da identidade, afetando futuros resets administrativos;
- inventário, equipamento por instância, aplicação de efeitos, combate, deploy e atualização do GPT ao vivo permanecem fora do escopo.

Status: implementada e validada na Fase 1F; revisão e integração rastreadas pelo PR correspondente

## 2026-07-13 — Efeitos autoritativos, bindings exatos e rolls transacionais

Decisão:
- preservar `core-v1-effects-v1` como núcleo puro e publicar seu manifesto em `EffectRulesVersion`;
- resolver referências de status durante a publicação, fixando definição/versão exatas e incluindo um hash separado na deduplicação;
- expor somente `resolveActorEffect` para leitura, execução de conteúdo e uso de consumível;
- gerar rolls criptográficos somente no backend, depois de locks e validação otimista, persistindo roll, chance e resultado com a resolução;
- versionar efeitos e cada recurso, recompor snapshots quando inventário/efeitos mudarem e manter `Actor.status` fora da automação;
- fazer da migration um novo corte clean-slate, sem conversão ou apagamento automático;
- manter multi-target, timeline, encontros, reaction/block runtime, cooldown, periodic ticks, upkeep, recursos customizados e GPT ao vivo fora desta fase.

Impacto:
- replay idempotente devolve o snapshot original sem reroll ou novo custo;
- conteúdo publicado não muda semanticamente quando uma nova versão de status aparece;
- falha de custo, versão, binding, inventário ou persistência reverte toda a operação;
- OpenAPI passa de 18 para 19 operationIds, com tokens de concorrência e nenhum roll aceito como input;
- rollout remoto e atualização da Action continuam pendentes.

Status: implementada e validada na Fase 1J; revisão e integração rastreadas pelo PR correspondente
