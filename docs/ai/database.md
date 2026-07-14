# Banco e migrations

## Autoridade e ambientes

Prisma Migrate é a única autoridade do schema Node/PostgreSQL. O runtime usa `DATABASE_URL`; a CLI usa `DIRECT_URL` quando definida. Migrations não rodam no startup, build ou health check.

Integração automatizada pode recriar exclusivamente `localhost:5432/game_gpt_test`. O helper recusa produção, hosts remotos, bancos administrativos/desenvolvimento e marcadores de Supabase/Render. Nenhum teste local deve acessar staging ou Supabase remoto.

## Fase 1C — ruleset publicado

Models:

- `Ruleset`: família lógica, com `code` único;
- `RulesetVersion`: publicação imutável, com `code` único, revision, schema version, hash SHA-256 e snapshot JSON canônico;
- `World.defaultRulesetVersionId`: default obrigatório com delete restrito;
- `Campaign.rulesetVersionId`: cópia obrigatória e imutável do default usado na criação.

A migration `20260713174337_engine_v1_ruleset_persistence` adiciona checks de schema/hash, FKs e índices dos vínculos, RLS nas novas tabelas e triggers específicas para:

- rejeitar `UPDATE` de `RulesetVersion`;
- rejeitar `DELETE` de `RulesetVersion`;
- rejeitar mudança real de `Campaign.rulesetVersionId`, aceitando o mesmo valor.

## Clean slate e rollout

Não existe `legacy-v0`, backfill, conversão, fallback, dual-read ou dual-write. Antes de qualquer DDL incompatível, a migration falha se `World` ou `Campaign` contiver linhas e informa que os dados funcionais devem ser limpos antes do rollout. A própria migration não executa `DELETE`, `TRUNCATE` ou drop destrutivo de dados funcionais.

O futuro rollout em staging deve confirmar e limpar os dados funcionais por operação separada e explicitamente autorizada, executar o gate manual de migrations e só depois implantar código compatível. Nenhum rollout ou acesso remoto ocorreu na Fase 1C.

## Rollback

Depois de publicada, uma migration aplicada não é editada nem removida. Rollback operacional prefere código anterior compatível ou nova migration corretiva revisada. O plano estrutural, válido apenas antes de existirem dados funcionais compatíveis, remove triggers/funções, FKs/índices, os dois campos de vínculo e então as tabelas de ruleset; nunca apaga dados silenciosamente.

Status: implementada e validada na Fase 1C; revisão e integração rastreadas pelo PR correspondente

## Fase 1D — ficha mecânica de Actor

Models:

- `ActorAttribute`: um registro por Actor/código oficial, com base, ganho e XP separados;
- `ActorResource`: um valor atual por Actor/tipo `hp|mana|sp`, sem máximo independente;
- `ActorDerivedSnapshot`: snapshot único e recomputável de máximos/derivados, ligado obrigatoriamente à `RulesetVersion`;
- `Actor.mechanicsStateVersion`: contador positivo, iniciado em 1 e copiado pelo snapshot.

A migration `20260713190000_engine_v1_actor_mechanics` falha antes do DDL quando encontra qualquer Actor. Ela não faz backfill, dual-read, dual-write, fallback, `DELETE` ou `TRUNCATE`; remove as sete colunas mecânicas legadas somente após o guard, cria enums fechados, checks de caps/valores/versões/hash, unicidades 9/3/1, FKs cascade para estado pertencente ao Actor, FK restrita para `RulesetVersion` e a postura RLS/revogações vigente.

Máximos nunca são persistência independente em `ActorResource`. O snapshot usa `inputHash` SHA-256 canônico e é validado/recalculado pelo backend, não por trigger. O rollout remoto futuro continua exigindo limpeza funcional explícita e o gate manual normal; staging/Supabase não foram acessados.

Status: implementada e validada na Fase 1D; revisão e integração rastreadas pelo PR correspondente

## Fase 1F — conteúdo publicado por versão

Models:

- `ContentProfileVersion`: manifesto imutável `core-v1-content-v1`, ligado à `RulesetVersion`, sem `updatedAt`;
- `ContentDefinition`: identidade estável e lifecycle, sem conteúdo funcional mutável;
- `ContentVersion`: snapshot imutável numerado, com perfil, apresentação, tags, metadata e hash canônico;
- `ActorContent`: vínculo simultâneo à definição e à versão, garantido por FK composta.

A migration `20260713230000_engine_v1_content_versioning` falha antes do DDL se `ContentDefinition` ou `ActorContent` contiver linhas. Não há delete, truncate, conversão, backfill, dual-read ou dual-write. Ela adiciona `CLOTHING`/`CONSUMABLE`, cria o modo de perfil, remove os campos versionados da identidade, instala checks de schema/hash/JSON, índices da versão atual, FKs restritas e RLS sem policies.

Triggers bloqueiam `UPDATE`/`DELETE` em `ContentProfileVersion` e `ContentVersion`, além de alterações reais em World, Campaign, code ou tipo da definição. Somente status permanece lifecycle mutável. Como versões publicadas também não podem ser apagadas por cascata, futuras rotinas administrativas de reset precisam de desenho explícito e migration corretiva revisada; não existe bypass público.

`contentHash` usa JSON canônico de dados públicos e auditáveis, ruleset e identidade da publicação do perfil. UUIDs, timestamps, status e idempotency key não participam. A publicação usa advisory lock transacional por identidade antes de numerar versões; snapshots idênticos são deduplicados e diferentes recebem números sequenciais.

O rollout remoto exige limpeza funcional separada e autorizada antes da migration. Nenhum staging, Supabase remoto, deploy ou GPT ao vivo foi alterado nesta fase.

Status: implementada e validada na Fase 1F; revisão e integração rastreadas pelo PR correspondente

## Fase 1H — inventário físico e equipamento

Models:

- `InventoryRulesVersion`: publicação imutável `core-v1-inventory-v1`, ligada à `RulesetVersion`;
- `ContentVersion.inventoryRulesVersionId|inventorySpec|inventorySpecHash`: trio opcional e imutável que fixa as regras físicas à versão;
- `InventoryEntry`: instância ou stack pertencente a um Actor e a uma versão física exata;
- `ActorEquipmentSlot`: ocupação física por slot; a FK composta garante que slot e entrada pertencem ao mesmo Actor;
- `Actor.inventoryStateVersion` e `ActorDerivedSnapshot.inventoryStateVersion`: versão otimista autoritativa e versão observada pelo snapshot.

A migration `20260714010000_engine_v1_inventory_persistence` exige `ActorContent`, `ContentDefinition` e `ContentVersion` vazios antes de qualquer DDL. Ela remove `ActorContent.equipped|quantity`, cria enums, checks, índices parciais de deduplicação, FKs, RLS e triggers. Não contém `DELETE`, `TRUNCATE`, conversão ou cópia dos campos conceituais antigos. Rollback estrutural requer migration corretiva; publicações e dados físicos nunca são apagados silenciosamente.

Triggers tornam `InventoryRulesVersion` imutável e impedem entrada sem spec, ruleset incompatível, kind/stacking incoerente, quantidade acima de `maxStack`, slot para stack/entrada indisponível/outro Actor, mudança de lifecycle enquanto equipada e remoção equipada. Regras completas de handedness, requisitos e multisslot permanecem no domínio puro e no service transacional, evitando duplicação no banco.

`inventorySpecHash` usa SHA-256 do spec canônico separadamente de `contentHash`; versões sem spec deduplicam por definição+contentHash e versões com spec por definição+contentHash+inventorySpecHash. Nenhum rollout remoto foi executado.

Status: implementada e validada na Fase 1H; revisão e integração rastreadas pelo PR correspondente

## Fase 1J — efeitos, recursos e rolls autoritativos

Models e campos:

- `EffectRulesVersion`: publicação imutável `core-v1-effects-v1` ligada à `RulesetVersion`;
- `ContentEffectBinding` e `ContentVersion.effectBindingHash`: vínculo imutável e hash canônico das versões exatas de status;
- `Campaign.engineTick|engineStateVersion`: relógio mecânico persistido e token otimista;
- `Actor.effectsStateVersion` e `ActorDerivedSnapshot.effectsStateVersion`: versão de efeitos e versão observada pela recomposição;
- `ActiveEffect`: status/modificador/reação persistido, com origem, stacks e estado de duração coerente;
- `EffectResolution` e `EffectRoll`: snapshot/result hash idempotentes e rolls autoritativos auditáveis;
- `ActorResource.stateVersion`: positivo e incrementado uma vez por recurso realmente alterado.

A migration `20260714030000_engine_v1_effects_persistence` exige Actor, ContentDefinition, ContentVersion, ActorContent, InventoryEntry e ActorEquipmentSlot vazios antes do DDL incompatível. Não contém `DELETE`, `TRUNCATE`, backfill, dual-read ou dual-write. Índices parciais de conteúdo passam a incluir `effectBindingHash`; rollback estrutural é somente por migration corretiva revisada.

Checks cobrem hashes, versões, ticks, stacks, payloads JSON, roll/chance e coerência de duração. FKs compostas fixam versão/definição do status. Triggers validam campanha/ruleset de atores, conteúdo, bindings e resoluções; `EffectRulesVersion`, `ContentEffectBinding`, `EffectResolution` e `EffectRoll` rejeitam update/delete. As cinco tabelas novas têm RLS habilitado, sem policies públicas, e revogação condicional para `anon`/`authenticated`.

Integração recria exclusivamente `localhost:5432/game_gpt_test`, testa a precondition sem alteração de dados, aplica migrations desde zero, exige diff vazio, valida registry concorrente/rollback, executa seed determinístico e cobre bindings, effects, rolls, idempotência, recursos e consumíveis. Nenhum banco remoto foi acessado.

Status: implementada e validada na Fase 1J; revisão e integração rastreadas pelo PR correspondente

## Fase 1L-A — persistência mínima de encontros

Models:

- `Encounter`: identidade por Campaign, ruleset, lifecycle, versão/tick, snapshot interno schema 1 e hash SHA-256;
- `EncounterParticipant`: vínculo imutável entre `actorRef` e Actor persistido ou entidade efêmera fechada, com versões iniciais para detecção futura de drift;
- `EncounterOperation`: transições mutantes confirmadas, append-only, uma por `IdempotencyRecord` e por próxima versão;
- `EncounterRoll`: cada entrada aleatória consumida, append-only e ligada simultaneamente ao Encounter e à operação.

A migration `20260714120000_add_encounter_persistence` é incremental, aditiva e sem backfill. Checks cobrem versões, ticks, schema/tamanho do snapshot, hashes, bindings e ordinais; FKs usam delete restrito. Um índice único parcial SQL permite somente um lifecycle aberto por Campaign, pois o filtro `IN` não é representável no partial index declarativo do Prisma 7.8. As quatro tabelas têm RLS sem policies e revogações condicionais de `anon`/`authenticated`.

Status: implementada localmente na Fase 1L-A; banco remoto não acessado
