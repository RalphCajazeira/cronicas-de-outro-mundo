# Decision Log

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
