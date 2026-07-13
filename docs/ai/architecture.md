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

`startGame` cria o protagonista em nível 1/XP 0 e todo o estado 9/3/1 na transação idempotente existente. `upsertActor` cria NPCs/atores em nível 1–20 com a mesma autoridade e só atualiza narrativa quando as entradas mecânicas coincidem; `updateActor` é exclusivamente narrativo. Recursos começam cheios. Gasto, cura, regeneração aplicada, inventário, equipamento, cenas e combate continuam fora do escopo.

A migration da Fase 1D exige `Actor` vazio antes de qualquer DDL incompatível, não apaga nem converte dados, remove `health`, `maxHealth`, `mana`, `maxMana`, `attributes`, `resistances` e `affinities`, instala constraints/FKs/RLS e mantém rollout remoto e GPT ao vivo pendentes.

### Fase 1E — conteúdo mecânico canônico puro

`core-v1` possui uma fronteira interna, pura e determinística para validar definições canônicas de `weapon`, `armor`, `shield`, `clothing`, `spell`, `skill`, `talent`, `item`, `consumable`, `status_effect`, `race`, `class` e `creature_template`. Todo perfil declara `schemaVersion: 1`, `rulesetCode: core-v1`, modo narrativo ou mecânico e um `contentKind` fechado. O GPT permanece proponente; somente o backend valida a definição e nunca aceita dano final, mitigação, recurso gasto, duração restante ou estado aplicado como resultado oficial.

O validador reutiliza componentes e envelopes de dano, bandas de custo, caps de área, papéis e orçamento de NPC, perfis temporais, targeting RC1.1, reações e helpers de inteiros seguros. Elementos são códigos fechados da versão (`fire`, `ice`, `lightning`, `earth`, `wind`, `water`, `light`, `shadow`, `poison`, `arcane`); canais físico/mágico permanecem separados, imunidade não é representada como resistência de 100% e consumíveis exigem efeitos numéricos completos.

Entradas runtime são objetos fechados, sem protótipos inesperados, arrays esparsos, números não finitos ou caminhos arbitrários de modificador. Falhas esperadas retornam código, `retryable` e issues determinísticas com path/rule/message/expected/received, sem exceção genérica. Configurações de raridade, stacking e limites operacionais são imutáveis internamente e expostas somente por cópias defensivas.

Esta fase não altera o manifesto persistido da Fase 1C, Prisma, migrations, repositories, HTTP, OpenAPI, inventário, equipamento, aplicação de efeitos, recursos ou combate. A Fase 1F deverá integrar deliberadamente essa fronteira ao fluxo de definição/versionamento persistido, com contrato e rollout próprios.

Status: implementada e validada na Fase 1E; revisão e integração rastreadas pelo PR correspondente

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

Frontend, escrita, combate, inventário físico, comércio e demais sistemas narrativos/mecânicos permanecem fora do escopo atual.
