# Arquitetura ativa

## Decisão aprovada

O projeto foi reiniciado. A versão baseada em GPT Actions, Supabase Edge Functions, RPCs e OpenAPI manual está em `legacy/supabase-gpt-v1/` somente como referência. O runtime principal é uma API Express + TypeScript modular em `backend/`, com Zod nos limites e PostgreSQL via Prisma Client 7 e o adapter oficial `@prisma/adapter-pg`.

Prisma Migrate é a única autoridade das novas migrations. O histórico Supabase legado não participa do novo schema. Supabase pode fornecer o PostgreSQL, sem ser camada de aplicação.

No runtime, `DATABASE_URL` é obrigatória. A CLI usa `DIRECT_URL` quando definida e recorre conscientemente a `DATABASE_URL` apenas quando ambas apontam para uma conexão direta adequada ao desenvolvimento local; ambientes com pooler devem sempre fornecer `DIRECT_URL`.

## Implementação atual

```text
HTTP -> routes/controller -> service -> repository -> Prisma -> PostgreSQL
```

- `app.ts` compõe o Express sem abrir porta; `server.ts` inicializa o processo.
- `config/` valida ambiente sem expor valores.
- `shared/http` concentra autenticação e erros; `shared/database` concentra um único Prisma Client e o pool do driver `pg`, limitado a cinco conexões, com timeouts explícitos.
- `server.ts` encerra o servidor HTTP e desconecta Prisma em `SIGINT`/`SIGTERM`; testes HTTP injetam repositories e não abrem pool real.
- módulos começam rasos; `characters` reutiliza atores e restringe `actorType`.
- respostas são DTOs normalizados, nunca objetos Prisma brutos.
- `modules/gpt` reúne os casos de uso da Action v1 sem substituir os endpoints de leitura anteriores.
- leituras de estado resolvem explicitamente `Player.slug` → `World(playerId, code)` → `Campaign(worldId, code)`; atores nunca são procurados globalmente por code.
- `getContent` exige tipo e escopo, prioriza a definição da campanha e limita o fallback à definição global do mesmo World.
- `listWorldCampaigns.hasProtagonist` é verdadeiro somente quando existe na Campaign um Actor `character` cujo code coincide com `Player.slug`.
- escritas usam `IdempotencyRecord`: constraint única, hash de operação/payload e resposta persistida na mesma transação Prisma.
- `/health/ready` executa consulta curta com timeout e resposta binária segura; `/openapi.json` substitui o servidor por `PUBLIC_BASE_URL`.

## Game Engine `core-v1`

O pacote `core-v1 numerical RC1.1` é a base oficial da implementação incremental. A Fase 1A mantém em `backend/src/modules/rules/core-v1/` somente regras numéricas puras, determinísticas, versionadas e independentes de Prisma, repositories, HTTP, OpenAPI, GPT e ambientes. O backend é a autoridade para atributos, recursos, derivados, precisão, crítico, dano, mitigação, custos, progressão e threat base; o GPT futuramente envia apenas intenções e propostas, nunca resultados derivados.

O `core-v1` fixa nove atributos primários e usa configuração versionada para presets, caps, envelopes, custos e papéis de NPC. Modificadores internos exigem origem tipada. A separação entre poder do ator, dano-base de arma/magia, defesa plana e resistência impede contagem dupla. Não existe `legacy-v0`: o rollout futuro parte de dados funcionais vazios, preservando a infraestrutura e o histórico oficial de migrations.

As tabelas internas da versão são imutáveis em runtime e a API pública expõe valores escalares estáveis ou cópias defensivas. Entradas mecânicas e resultados intermediários permanecem em inteiros seguros; qualquer overflow é rejeitado em vez de sofrer arredondamento implícito. Os limites de inventário por papel de NPC são defaults provisórios para futura telemetria e não implementam inventário na Fase 1A.

A Fase 1B implementa a economia de ações RC1.1 como núcleo puro, determinístico e sem persistência. A timeline é contínua, usa `bigint` para ticks e salta diretamente ao próximo evento, sem rodadas fixas nem iteração por ticks vazios. Eventos do mesmo tick são processados sequencialmente por prioridade, initiative score, Agilidade, Percepção, Sorte, desempate RNG injetado e referência estável; depois de cada evento, os posteriores são revalidados e podem ser cancelados.

O módulo também concentra perfis temporais versionados, velocidades física/mágica/híbrida, iniciativa, slots independentes, casting e deltas conceituais de Mana, movimento por zonas, combos atômicos, planos limitados, economia temporal de encontros e multiplicadores temporais de XP. A cadeia de reações tem profundidade máxima 2: ação originadora em 0, no máximo uma reação defensiva em 1 e, quando permitido, um contra-ataque terminal em 2. Profundidade 2 não gera nova reação nem reinicia a cadeia.

Não há estado persistido de combate, desconto real de recursos ou contrato HTTP mecânico nesta fase. A Fase 1C persiste somente a identidade autoritativa do pacote: `Ruleset(code=core)` agrupa a família e `RulesetVersion(code=core-v1, revision=RC1.1, schemaVersion=1)` publica manifesto canônico e hash SHA-256. Números calibráveis permanecem associados à revisão do ruleset e somente uma nova versão pode alterá-los para novos replays; telemetria de combate continua futura.

`World.defaultRulesetVersionId` é obrigatório e pode ser alterado somente por futura operação administrativa explícita. `Campaign.rulesetVersionId` copia o default no insert e é imutável depois disso. O registry interno garante a versão oficial dentro da transação de `startGame`, valida revision/schema/hash/snapshot, rejeita drift e resolve somente colisões `P2002` comprovadas nas chaves `Ruleset.code` ou `RulesetVersion.code`. Triggers PostgreSQL bloqueiam `UPDATE`/`DELETE` de versões publicadas e qualquer troca real do vínculo da Campaign; FKs usam delete restrito.

A migration da Fase 1C é clean-slate e falha antes do DDL quando encontra World ou Campaign existente. Ela não contém backfill, `legacy-v0`, dual-read, dual-write ou remoção de dados. O rollout futuro deve limpar dados funcionais deliberadamente antes de aplicar a migration; staging e Supabase remoto não foram acessados nesta fase.

Os coeficientes calibráveis permanecem associados à identidade `core-v1`/futura `RulesetVersion` e exigirão telemetria antes de nova versão. Nenhum número publicado deve ser alterado retroativamente para replays existentes.

### Fase 1D — estado mecânico autoritativo de atores

`Actor` preserva identidade, narrativa, nível, XP, ouro e `mechanicsStateVersion`, mas não contém mais recursos, atributos ou derivados livres. `ActorAttribute` persiste exatamente os nove valores-base, ganho futuro separado e XP da trilha; `ActorResource` persiste somente o valor atual e sua versão para `hp`, `mana` e `sp`; `ActorDerivedSnapshot` mantém um cache auditável, único, ligado à `RulesetVersion` e identificado por SHA-256 canônico dos inputs mecânicos.

`createActorMechanicalState`, `recomputeActorDerivedSnapshot` e `loadActorMechanicalSheet` formam a única orquestração de persistência. A validação inicial reutiliza integralmente `validateInitialPrimaryAttributes`; máximos e derivados reutilizam `calculateResourceMaximums` e `calculateSecondaryAttributes`. O snapshot nunca contém fórmula e a leitura recalcula hash e resultados, exige 9 atributos/3 recursos, compara versão e ruleset e falha com erro sanitizado diante de estado incompleto ou stale.

`startGame` cria o protagonista em nível 1/XP 0 e todo o estado 9/3/1 na transação idempotente existente. `upsertActor` cria NPCs/atores em nível 1–20 com a mesma autoridade e só atualiza narrativa quando as entradas mecânicas coincidem; `updateActor` é exclusivamente narrativo. Na Fase 1D, recursos começavam cheios e gasto, cura, regeneração aplicada, inventário, equipamento, cenas e combate ainda ficavam fora do escopo; inventário/equipamento e o subconjunto transacional de recursos/efeitos foram incorporados nas Fases 1H e 1J.

A migration da Fase 1D exige `Actor` vazio antes de qualquer DDL incompatível, não apaga nem converte dados, remove `health`, `maxHealth`, `mana`, `maxMana`, `attributes`, `resistances` e `affinities`, instala constraints/FKs/RLS e mantém rollout remoto e GPT ao vivo pendentes.

### Fase 1E — conteúdo mecânico canônico puro

`core-v1` possui uma fronteira interna, pura e determinística para validar definições canônicas de `weapon`, `armor`, `shield`, `clothing`, `spell`, `skill`, `talent`, `item`, `consumable`, `status_effect`, `race`, `class` e `creature_template`. Todo perfil declara `schemaVersion: 1`, `rulesetCode: core-v1`, modo narrativo ou mecânico e um `contentKind` fechado. O GPT permanece proponente; somente o backend valida a definição e nunca aceita dano final, mitigação, recurso gasto, duração restante ou estado aplicado como resultado oficial.

O validador reutiliza componentes e envelopes de dano, bandas de custo, caps de área, papéis e orçamento de NPC, perfis temporais, targeting RC1.1, reações e helpers de inteiros seguros. Elementos são códigos fechados da versão (`fire`, `ice`, `lightning`, `earth`, `wind`, `water`, `light`, `shadow`, `poison`, `arcane`); canais físico/mágico permanecem separados, imunidade não é representada como resistência de 100% e consumíveis exigem efeitos numéricos completos.

Entradas runtime são objetos fechados, sem protótipos inesperados, arrays esparsos, números não finitos ou caminhos arbitrários de modificador. Falhas esperadas retornam código, `retryable` e issues determinísticas com path/rule/message/expected/received, sem exceção genérica. Configurações de raridade, stacking e limites operacionais são imutáveis internamente e expostas somente por cópias defensivas.

Esta fase não altera o manifesto persistido da Fase 1C, Prisma, migrations, repositories, HTTP, OpenAPI, inventário, equipamento, aplicação de efeitos, recursos ou combate. A Fase 1F deverá integrar deliberadamente essa fronteira ao fluxo de definição/versionamento persistido, com contrato e rollout próprios.

Status: implementada e validada na Fase 1E; revisão e integração rastreadas pelo PR correspondente

### Fase 1F — publicação canônica e conteúdo persistido por versão

`ContentProfileVersion(code=core-v1-content-v1, schemaVersion=1)` publica, separadamente da configuração numérica imutável de `RulesetVersion`, o catálogo e os limites validáveis da Fase 1E em snapshot JSON canônico e hash SHA-256. O registry valida ruleset, code, schema, hash e snapshot, rejeita drift e só recupera colisões `P2002` comprovadamente esperadas; não atualiza nem registra o snapshot.

`ContentDefinition` contém apenas identidade estável (`World`, Campaign opcional, code, tipo e lifecycle). Nome, descrição, perfil, apresentação, tags e metadata pertencem a `ContentVersion`, que é imutável e referencia obrigatoriamente a `RulesetVersion` e a `ContentProfileVersion`. A versão atual é a de maior `versionNumber`; não há ponte circular `currentVersionId`.

`publishContentVersion` é a única orquestração de escrita usada por `startGame`, `upsertContent` e seed. Ela resolve o ruleset do escopo, delega ao validador puro da Fase 1E, calcula hash sem IDs/status/timestamps, serializa a identidade com advisory lock transacional e deduplica snapshots iguais ou cria a próxima versão. Campanha específica tem prioridade nas leituras e o fallback permanece restrito ao mesmo World, tipo e code global.

`ActorContent` referencia simultaneamente definição e versão com FK composta. Novos vínculos recebem a versão atual, mas get/list/update/equip/unequip continuam na versão fixada; publicar v2 não migra um ator ligado à v1. `equipped` e `quantity` continuam conceituais: não há `ItemInstance`, inventário, slots físicos ou aplicação de modificadores.

A migration é clean-slate para `ContentDefinition`/`ActorContent`, não apaga ou converte dados e instala constraints, FKs restritas, RLS e triggers contra update/delete das publicações e contra mudança de identidade. Imutabilidade afeta futuras rotinas administrativas: reset funcional deve recriar o banco local autorizado ou ser desenhado por migration corretiva explícita, nunca por bypass público.

O OpenAPI ativo aceita perfil estruturado para os 13 tipos canônicos e `profile: null` para tipos narrativos genéricos; `mechanics`, `requirements` e schema arbitrário deixaram de ser rotas paralelas. O nome `upsertContent` foi preservado, mas update significa publicação de nova versão imutável. O GPT ao vivo e qualquer deploy continuam pendentes.

Status: implementada e validada na Fase 1F; revisão e integração rastreadas pelo PR correspondente

### Fase 1G — núcleo puro de inventário, carga e equipamento

`core-v1-inventory-v1` adiciona uma fronteira pura, determinística e sem infraestrutura para posse física futura. `ActorContent` permanece um vínculo conceitual com conteúdo conhecido ou concedido; seus campos genéricos `quantity` e `equipped` não são reinterpretados como inventário. Entradas físicas usam referências públicas de escopo, tipo, code e `versionNumber`, de modo que publicar v2 nunca altera ou funde automaticamente uma posse fixada em v1.

O `CoreV1InventorySpec` separado contém peso e política `unique|stackable` e pode declarar slots/handedness físicos quando esses dados não cabem no perfil publicado da Fase 1E, sem alterar `core-v1-content-v1` ou seu hash. Instâncias possuem estado fechado; stacks são homogêneos, nunca vazios e limitados a 999 unidades. Operações processam no máximo 256 entradas e o loadout no máximo 32 instâncias, rejeitando refs duplicadas, objetos abertos, arrays esparsos, mutação e overflow.

Peso usa a mesma unidade abstrata de `carryingCapacity`; equipamento conta uma vez e estados consumidos/destruídos não contam. Os thresholds delegam à economia de ações RC1.1: normal até 70%, encumbered até 100%, heavily encumbered até 125% e overloaded acima disso. Comparações inteiras evitam ponto flutuante e overflow.

O loadout possui mãos, seis slots corporais e dois acessórios. Armas one-handed ocupam uma mão explícita; two-handed ocupam as duas; versatile exige modo explícito. Itens multisslot são planejados e alterados atomicamente, conflitos nunca são substituídos em silêncio e requisitos usam apenas projeções públicas do ator. Modificadores passivos equipados recebem origem tipada `equipment`, são apenas coletados/agregados e não recomputam o snapshot.

Não há Prisma, migration, repository, HTTP, OpenAPI, persistência de `ItemInstance`, uso de consumível, aplicação de efeito ou acesso remoto. A Fase 1H deverá decidir o modelo persistido, transações, integração com a ficha e recomputação autoritativa.

Status: implementada e validada na Fase 1G; revisão e integração rastreadas pelo PR correspondente

## Arquitetura de testes

```text
unitário: regra/schema/service isolado
HTTP: Supertest -> app em memória -> repository injetado
integração: Supertest -> app -> repository real -> Prisma -> game_gpt_test local
```

`server.ts` permanece fora de todas as suítes. A preparação de integração valida o destino antes de recriar exclusivamente `game_gpt_test`, aplica migrations com `migrate deploy`, executa o seed e propaga o exit code. Testes rápidos não carregam Prisma real; integração fica restrita a comportamento dependente de PostgreSQL.

## Limites de responsabilidade

O backend valida entrada, chave interna, regra de domínio e persistência. O GPT futuramente chama a API Node e cuida da interação narrativa dentro dos contratos. O frontend futuro cuida da UX e também chama a API; nunca recebe service role, URL privilegiada ou acesso direto a tabelas/RPCs.

## Segurança temporária

`GET /health` é público. `/api/v1` exige `x-rpg-key`, comparada sem logging. Essa é autenticação interna temporária entre GPT/admin e backend, não autenticação pública definitiva.

## Auditoria HTTP segura

Toda requisição recebe um `x-request-id` gerado pelo backend e produz ao final um evento JSON `http_request_completed`. O evento registra timestamp, origem pública ou GPT, método, caminho sem query string, status, duração e resumos allowlisted da entrada e da resposta. Falhas Zod acrescentam somente código, caminho e mensagem customizada conhecida; erros internos nunca incluem stack trace ou mensagem bruta.

Para escritas GPT, o resumo preserva os dados operacionais necessários ao diagnóstico — operação, referências, tipo de conteúdo, campos alterados, valores mecânicos escalares e comprimento/fingerprint SHA-256 reduzida da chave idempotente. Não são registrados `x-rpg-key`, headers, cookies, chave idempotente original, descrições, notas narrativas, valores de metadata/payload, connection strings ou corpos completos.

No Render, investigar primeiro pelo texto `http_request_completed`, depois restringir por `path`, `statusCode`, `requestId` ou fingerprint. A retenção do plano Free é operacionalmente limitada; os logs são diagnóstico temporário, não fonte de verdade nem armazenamento narrativo.

Respostas `400 INVALID_INPUT` incluem `retryable`, uma instrução curta e uma lista `issues` com `path`, `code` e mensagem de correção sem ecoar o valor rejeitado. O GPT corrige somente os campos indicados e tenta uma vez; autenticação, ausência, conflito e erro interno não autorizam retry automático. Esse retorno melhora a recuperação de payloads incompletos sem transformar falhas em loops ou escritas duplicadas.

`startGame` cria ou reutiliza explicitamente Player e World sem atualizá-los, sempre cria uma Campaign nova e persiste em uma única transação idempotente as configurações `worldConfig`/`campaignConfig` de versão 1, protagonista completo, até 24 definições/vínculos iniciais e o evento técnico `campaign-started`. Configuração, aparência, personalidade, origem e limites são validados no backend; o perfil efetivo de dificuldade é calculado, nunca aceito do cliente. Não há migration, checkpoint, inventário por instância ou slots físicos. `NOT_FOUND` em `loadGame` inicia a configuração e reset continua administrativo, nunca uma Action destrutiva.

Em classe mecânica inicial, `Actor.className` é exatamente o nome público da única definição `class` vinculada; definição reutilizada é comparada dentro da transação. Metadata arbitrária é medida em bytes UTF-8, limitada por objeto e agregada, enquanto as configurações versionadas seguem schemas próprios. O payload fechado de `campaign-started` tem no máximo 8 KB, é montado por allowlist e usa `GameEvent.idempotencyKey = null`: a idempotência pertence exclusivamente ao `IdempotencyRecord` da operação externa.

Somente `P2002` cuja metadata estruturada identifica `IdempotencyRecord.key` é tratado como retry idempotente. A linha persistida ainda deve coincidir em operação/hash e conter resposta não vazia; registro ausente ou incompleto retorna conflito seguro, sem loop ou falso sucesso. Outras colisões únicas viram conflito de domínio seguro, sem nomes de constraints ou detalhes Prisma.

## Banco hospedado e deploy preparado

O fluxo futuro é GitHub → Render (Node nativo) → Supabase PostgreSQL. Runtime usa `DATABASE_URL`; migrations usam `DIRECT_URL`. Em Supabase deve existir usuário específico para Prisma, com senha forte, e Supavisor Session mode pode ser usado no runtime quando adequado. Secrets pertencem somente ao Render.

A migration incremental habilita RLS nas tabelas da plataforma Node sem policies para clientes Supabase e revoga privilégios de `anon`/`authenticated` somente quando esses papéis existem. Proprietário e migration role permanecem responsáveis por acesso e migrations. Objetos legados e Data API não são alterados.

O papel PostgreSQL específico do Prisma deve aplicar as migrations via `DIRECT_URL`, permanecer proprietário das tabelas Node e ser o mesmo papel usado por `DATABASE_URL`. Sem `FORCE ROW LEVEL SECURITY`, o proprietário opera intencionalmente sem policies; outro papel será bloqueado mesmo que receba grants comuns. Rollback deve preferir código anterior e migration corretiva: remover `IdempotencyRecord` perderia o histórico de idempotência, e desabilitar RLS reduziria a segurança.

## Staging gratuito no Render

O staging usa o projeto Render `Game-GPT`, ambiente `Staging`, branch `develop`, região `virginia`, Web Service Node nativo no plano Free e auto-deploy desligado. O serviço não usa Docker. Como Web Services Free não suportam pre-deploy, migrations são um gate manual obrigatório antes de cada deploy; nunca devem ser movidas para build, start, inicialização da aplicação ou health check.

Gate manual, sempre a partir do commit que será implantado:

1. confirmar branch, commit e alvo Supabase staging;
2. iniciar o processo com `NODE_EXTRA_CA_CERTS` apontando para a CA oficial local e carregar `DATABASE_URL`/`DIRECT_URL` de staging;
3. executar `npm run prisma:validate --prefix backend`;
4. executar `npx prisma migrate status` no diretório `backend/`;
5. executar `npm run prisma:migrate:deploy --prefix backend`;
6. repetir `npx prisma migrate status` e exigir schema atualizado, sem migration pendente ou falha;
7. somente então iniciar manualmente o deploy do commit aprovado;
8. validar `/health`, `/health/ready`, `/openapi.json` e smoke tests protegidos somente de leitura.

O certificado local fica em `backend/.secrets/supabase-ca.crt`, diretório ignorado pelo Git. As URLs usam `sslmode=verify-full` com a CA oficial carregada antes do startup do Node, Prisma CLI ou npm. No Render, cadastrar manualmente um secret file chamado `supabase-ca.crt`; o runtime o monta em `/etc/secrets/supabase-ca.crt`, caminho configurado por `NODE_EXTRA_CA_CERTS`. O conteúdo do certificado, connection strings e chaves nunca pertencem ao Blueprint ou à documentação.

Variáveis do serviço: `NODE_ENV`, `HOST`, `NODE_EXTRA_CA_CERTS`, `DATABASE_URL`, `RPG_API_KEY` e `PUBLIC_BASE_URL`. `PORT` é fornecida pelo Render. `DIRECT_URL` é exclusiva do gate manual e não é necessária no build ou runtime remoto: `prisma generate` usa `DATABASE_URL` sem conectar ao banco.

Ordem do primeiro deploy: concluir o gate manual e abrir a criação manual do Web Service dentro de `Game-GPT`/`Staging`. Replicar exatamente o `render.yaml`, cadastrar `DATABASE_URL`, `RPG_API_KEY`, `PUBLIC_BASE_URL` e o secret file da CA antes de clicar em **Deploy web service**, confirmar Free/`develop`/`virginia`/auto-deploy off e só então criar e iniciar o deploy. A criação inicial é manual porque o Blueprint não declara o conteúdo do secret file; depois que o serviço e o YAML estiverem publicados e revisados, o Blueprint pode assumir a configuração pelo mesmo nome. Seed é proibido no Render.

Rollback operacional usa um dos dois deploys anteriores disponíveis no Free, sem reverter migrations destrutivamente. Se código anterior for incompatível com uma migration já aplicada, corrigir por nova migration compatível antes de qualquer rollback. Cold start, suspensão após inatividade, filesystem efêmero e limites de horas, banda, pipeline e logs permanecem limitações aceitas do staging Free.

A trava de custos é absoluta: não selecionar instância paga, upgrade, disco persistente ou recurso cobrado. Qualquer tela com cobrança deve ser abandonada antes da confirmação.

## Pendente antes de deploy

Cadastrar secrets e o secret file no Render, executar o gate manual a partir do commit aprovado, validar o preview do Blueprint publicado e realizar o primeiro deploy controlado. Para futura exposição pública além do GPT/admin, definir autenticação pública, autorização, CORS explícito, rate limit e retenção/exportação de logs. Não usar CORS `*`. Nenhuma migration ou seed roda no startup.

## Fases futuras

Frontend, combate multi-target/timeline, comércio e demais sistemas narrativos/mecânicos ainda não cobertos pela Fase 1J permanecem futuros.

### Fase 1H — inventário e equipamento persistentes

`ActorContent` registra somente conhecimento e progressão; `equipped` e `quantity` foram removidos. Posse física é `InventoryEntry`, fixada a uma `ContentVersion` que contém `inventorySpec` canônico e referência à publicação imutável `InventoryRulesVersion(core-v1-inventory-v1)`. Instâncias possuem lifecycle; stacks possuem quantidade homogênea. O estado equipado é derivado exclusivamente de `ActorEquipmentSlot`, permitindo um item multisslot sem estado físico duplicado.

`manageActorInventory` resolve o escopo, bloqueia a linha do Actor, valida `expectedInventoryStateVersion`, delega às funções puras da Fase 1G, persiste o diff, incrementa uma vez as versões de inventário e mecânica e recompõe o snapshot na mesma transação idempotente. O fluxo cobre leitura, grant, remove, split, merge, reserve, release, destroy, equip e unequip. `startGame` chama a mesma orquestração e equipa somente depois de conceder todas as entradas.

A projeção mecânica carrega entradas e slots, valida o estado puro, soma peso e aplica somente modificadores de itens efetivamente equipados. Capacidade modificada precede encumbrance; penalidade de carga e modificadores de atributos, máximos, defesas, velocidades, resistências e regenerações entram no hash canônico sem IDs ou timestamps. Um item multisslot é contado uma vez.

O contrato público expõe refs, versão otimista, resumo de inventário, slots, peso e encumbrance, nunca UUIDs ou hashes internos. Uso de consumíveis, aplicação de efeitos, durabilidade, munição, loot automático e combate permanecem fora do escopo.

Status: implementada e validada na Fase 1H; revisão e integração rastreadas pelo PR correspondente

### Fase 1I — resolução pura de efeitos, recursos e estados ativos

`core-v1-effects-v1` é uma identidade interna, schema 1, que orquestra definições canônicas sem alterar os manifestos publicados de ruleset, conteúdo ou inventário. A resolução valida toda a entrada, planeja e verifica o custo, executa efeitos em ordem sobre cópias e só retorna o novo estado e relatório após sucesso completo.

Custos reutilizam `CoreV1Cost` e sua validação, aplicam modificadores tipados de Mana/SP/HP em BPS e preservam ao menos 1 HP. Rolls de hit e crítico são injetados; dano reutiliza precisão, crítico, dano bruto e mitigação da Fase 1A, incluindo defesa plana, block, resistências, imunidades e dano mínimo. Restauração reporta aplicado e desperdiçado sem alterar máximos ou `Actor.status`.

Estados ativos fixam a versão pública exata da origem/status e usam ticks `bigint`, actions explícitas e scopes scene/encounter/permanent. Stacking implementa none, refresh, intensidade, duração e replace; modificadores ativos são coletados com origem `status` e ordem por `effectRef`, sem recalcular snapshots. Não há pulso periódico automático, upkeep executado, timeline, RNG ou persistência.

Sequências aplicam custo uma vez e carregam o estado entre efeitos; miss mantém custos e efeitos self, mas bloqueia dano/status ofensivo dependente de hit. O uso puro de consumível reutiliza validação/remoção da Fase 1G, consome uma unidade somente depois do sucesso e exige orquestrador futuro para multi-target/area.

Prisma, migrations, repositories, HTTP, OpenAPI, banco remoto, deploy e GPT ao vivo permanecem inalterados. A Fase 1J deverá decidir persistência autoritativa, transações, produção/persistência de rolls e integração com inventário/combate.

Status: implementada e validada na Fase 1I; revisão e integração rastreadas pelo PR correspondente

### Fase 1J — persistência autoritativa de efeitos

`EffectRulesVersion(core-v1-effects-v1)` publica o manifesto operacional imutável. `ContentEffectBinding` fixa cada `apply_status`/`remove_status` da versão fonte à definição e versão exatas do status; `effectBindingHash` participa da deduplicação sem contaminar `contentHash` ou `inventorySpecHash`.

`resolveActorEffect` é a única fronteira pública desta fase. `get` somente projeta recursos versionados e efeitos ativos. `execute_content` exige versão conhecida/mastered ou versão equipada; `use_consumable` resolve o perfil da entrada física. Escritas bloqueiam Campaign e Actors em ordem determinística, validam `mechanicsStateVersion`, `inventoryStateVersion`, `effectsStateVersion` e as três versões de recurso antes de qualquer roll criptográfico. Custo, dano/restauração, consumo, diffs de `ActiveEffect`, `EffectResolution`, `EffectRoll`, `GameEvent` allowlisted e resposta idempotente são confirmados ou revertidos juntos.

Efeitos persistidos usam origem pública determinística, versão de conteúdo exata e duração `ticks|actions|scene|encounter|permanent`. Expiração por tick, avanço por ação e fechamento de scope são services internos que incrementam versões e recompõem o snapshot uma única vez. Equipamento e efeitos ativos alimentam a mesma projeção mecânica; máximos podem clampá-los sem cura implícita.

O contrato deliberadamente não implementa recursos customizados persistidos, seleção multi-target, timeline/turnos/encontros, reaction/block runtime, cooldown, periodic ticks ou upkeep. HP zero retorna `defeatedCandidate`, mas não altera `Actor.status`. OpenAPI e instruções locais já descrevem a Action futura; o GPT ao vivo, staging e deploy não foram alterados.

Status: implementada e validada na Fase 1J; revisão e integração rastreadas pelo PR correspondente

### Fase 1K — núcleo puro de orquestração de encontros

`core-v1-encounter-v1`, schema 1, compõe a economia de ações RC1.1, targeting canônico, inventário/equipamento e `core-v1-effects-v1` sem alterar qualquer manifesto publicado. `CoreV1EncounterState` usa somente refs públicas, ticks `bigint`, versões inteiras, participantes/relações ordenados, action slots existentes, a event queue da Fase 1B e cópias defensivas. Não há UUID, relógio de parede, RNG interno, metadata livre ou persistência.

O targeting fechado resolve self, single/weapon, multi-target, area, chain e cleave. Selectors são limitados a self, explicit, nearest hostile, lowest HP hostile e nearest ally; relações vêm da composição autoritativa, HP relativo usa aritmética inteira e empates usam zona, `stableOrder` e ref. Area/cleave recebem candidatos espaciais pré-resolvidos e chain recebe ranges fechados entre candidatos, sem grid ou geometria livre.

A compilação de intenção valida slot, conteúdo versionado, inventário/equipamento, custo, velocidade e targets; então agenda start, preparação, efeitos independentes, casting/channel, upkeep e recovery na fila existente. Eventos do mesmo tick são processados sequencialmente e revalidados depois de cada mudança. Multi-target cobra custo e efeitos self uma vez, mas chama `resolveCoreV1EffectSequence` separadamente por alvo com rolls injetados e estado atualizado.

Reações preservam tempos, penalidades e cooldowns RC1.1, uma defesa em depth 1 e contra-ataque terminal em depth 2. Como não há fórmula publicada para sucesso de block/dodge/interrupt/counter, `ReactionOutcomeResolver` é uma fronteira interna determinística; blockValue e completeBlock também precisam vir de contexto autoritativo. Casting reutiliza reserva/progresso/interrupção antes/depois de 50%, channel pulses e recovery; movimento reutiliza zonas, terreno, encumbrance e custo conceitual de SP; combos e action plans mantêm caps e stop conditions fechados.

Os limites operacionais são 64 participantes, 16 alvos, 256 eventos agendados, 32 eventos por lote, 5 ações por plano, 8 eventos internos por combo, avanço de 5000 ticks por lote e tick máximo de 1.000.000.000. O resultado de lote contém snapshots before/after, eventos, resoluções, mudanças, invalidações, ready actors, stop reason e continuação, sempre sem referências aos objetos de entrada.

Esta fase não adiciona Prisma, migration, Combat/ActorCombatState/ScheduledCombatEvent persistidos, HTTP, OpenAPI, token de continuação, RNG persistido, progressão, XP, loot, deploy ou integração com o GPT. A Fase 1L deverá criar o adaptador autoritativo de produção/persistência, inclusive rolls e confirmação do encerramento sugerido pelo núcleo.

Status: implementada e validada na Fase 1K; revisão e integração rastreadas pelo PR correspondente

### Fase 1L-A — persistência mínima de encontros

`Encounter`, `EncounterParticipant`, `EncounterOperation` e `EncounterRoll` formam a fundação persistida do adaptador futuro. O encontro fixa imutavelmente Campaign e `RulesetVersion`, mantém versão otimista, tick, lifecycle e o snapshot interno completo; participantes mapeiam refs do core para Actor canônico ou entidade efêmera explícita; operações e rolls são trilhas append-only ligadas à idempotência.

`EncounterStateSnapshotV1` codifica todos os ticks `bigint` como decimais canônicos, valida schema fechado, faz round-trip defensivo, limita o JSON canônico a 1 MiB UTF-8 e usa SHA-256. O banco aplica apenas uma guarda física de 2 MiB ao `jsonb::text`, para acomodar sua formatação; esse não é um limite público. O snapshot é interno e não é projeção pública do GPT.

A migration é aditiva, sem backfill, usa FKs restritas, checks, RLS sem policies e índice único parcial em SQL para um encontro aberto por Campaign. O Prisma 7.8 não expressa filtros parciais por catálogo `IN`, por isso somente esse índice permanece como SQL explícito. Service/repository operacional, aplicação transacional de recursos/efeitos/inventário, HTTP, OpenAPI e GPT continuam fora da Fase 1L-A.

Status: implementada localmente na Fase 1L-A; revisão técnica pendente
