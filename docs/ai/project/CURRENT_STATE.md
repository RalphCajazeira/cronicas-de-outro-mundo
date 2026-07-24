# Estado Atual — Game-GPT / Crônicas de Outro Mundo

Atualizado em: 2026-07-24

Este arquivo registra o estado técnico confirmado conhecido. Fatos mutáveis de Git, banco, Render, Supabase e GPT Builder devem ser verificados no ambiente antes de qualquer efeito externo.

## Identificação técnica

- Repositório: `RalphCajazeira/cronicas-de-outro-mundo`.
- Diretório local principal: `C:\Users\ralph\Desktop\Game_GPT`.
- Branch de integração: `develop`.
- `develop` local e remoto no inventário de 2026-07-24: `924c3b08c9db720cc69cdc851e0cc201d6ddaedd`.
- Projeto técnico no ChatGPT: `Game_GPT`.
- GPT narrativo de staging: `Crônicas de Outro Mundo — Staging`.

## Stack da aplicação

- Node.js 22, TypeScript, Express e Zod;
- Prisma 7 e PostgreSQL;
- Vitest, Supertest e testes PostgreSQL de integração;
- OpenAPI 3.1 com exatamente 20 `operationId`s;
- Supabase para PostgreSQL de staging;
- Render para API de staging;
- GPT Actions, Instructions e nove arquivos de Knowledge para o GPT narrativo.

## Fundação integrada em `develop`

- Fases 1A–1K: núcleo numérico, timeline, regras versionadas, ficha, conteúdo, inventário, efeitos e orquestração pura de encontros.
- Fases 1L-A e 1L-B: persistência e adaptador transacional de encontros.
- Fase 1L-C: facade HTTP/OpenAPI por uma única Action `manageEncounter`.
- Fase 1M-A: consequência terminal auditável, `DEFEATED`, limpeza escopada de efeitos e ledger append-only, sem XP, ouro ou loot.
- Resolução por beat: intenção composta curta, cena autoritativa, NPCs determinísticos, recuperação de drift e fluxo granular preservado.
- Criação assistida e resolução automática limitada: cápsula `scene` v2, plano condicionado e política de até 12 beats por chamada.
- Correções integradas até `924c3b0`: integridade terminal e replay canônico, fuga em etapas legais e `wait` temporal sem efeito mecânico.
- As 20 operações do OpenAPI declaram explicitamente `x-openai-isConsequential: false`; confirmações conversacionais continuam obrigatórias para decisões materiais.

## Capacidades confirmadas

- escopo determinístico por Player, World e Campaign;
- criação estruturada e idempotente de jogo;
- ficha, conteúdo, inventário, equipamento, recursos e efeitos autoritativos;
- encontros com locks determinísticos, versões otimistas, rolls backend-only e checkpoint auditável;
- `loadGame` com recuperação segura de encontro ativo e `abandon` somente após drift comprovado;
- `resolve_beat` com ações comuns, ataque, magia, item, defesa, preparação, movimento e fuga;
- finalização atômica de encontro sem recompensa antecipada;
- auditoria HTTP sanitizada e respostas sem UUIDs, hashes, rolls ou snapshots internos.

## Staging conhecido

- Render: `cronicas-de-outro-mundo-staging-api`, projeto `Game-GPT`, Virginia, auto-deploy desligado.
- Supabase ativo: `cronicas-de-outro-mundo-staging-virginia`, região `us-east-1`, dez migrations e sem seed.
- O staging antigo em `sa-east-1` permanece vazio, pausado e desconectado.
- A co-localização Virginia reduziu materialmente a latência e os gates de readiness, criação, carga, idempotência e encontro passaram.
- O GPT de staging foi publicado com Instructions, nove arquivos de Knowledge e 20 Actions antes das correções finais de auto-resolução.
- A ampliação de resolução automática chegou ao staging em baseline intermediária, mas o smoke encontrou inconsistência terminal. As correções posteriores em `2981341`, `3664743` e `924c3b0` estão em `develop` e não devem ser tratadas como publicadas no GPT Builder sem novo rollout e verificação.

## Limitações e pendências

- XP e level-up permanecem para a Fase 1M-B.
- Ouro, drop e claim de loot permanecem para a Fase 1M-C.
- Não há morte definitiva automática, recompensa antecipada nem checkpoint narrativo completo.
- Frontend, autenticação pública, CORS/rate limit públicos, comércio, lojas, missões, relações e viagens continuam futuros.
- A política de autonomia e as correções finais de auto-resolução exigem novo gate de deploy e atualização manual do GPT Builder.
- Não assumir migration, deploy, Action, Instructions ou Knowledge atualizados apenas porque o código está em `develop`.

## Segurança operacional

- Nenhum secret deve ser versionado ou copiado para documentação.
- A credencial de staging exposta acidentalmente em inspeção anterior foi rotacionada; o valor e os artefatos locais de sessão não pertencem ao Git.
- Migrations remotas, deploy e GPT ao vivo exigem autorização própria e evidência atual.
