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
