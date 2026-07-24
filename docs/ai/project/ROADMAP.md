# Roadmap — Game-GPT / Crônicas de Outro Mundo

Atualizado em: 2026-07-24

Este roadmap registra as próximas frentes conhecidas após a integração das correções finais da resolução automática. Nenhuma fase é considerada implantada ou publicada apenas por estar integrada em `develop`.

## Baseline

- `develop`: `924c3b08c9db720cc69cdc851e0cc201d6ddaedd`.
- Fundação integrada: Fases 1A–1L-C, 1M-A e resolução de encontros por beat.
- Próximo gate: revisar e implantar no staging as correções posteriores à baseline intermediária de auto-resolução e só então atualizar o GPT Builder.

## Rollout da resolução automática

Objetivo: validar ponta a ponta a cápsula `scene` v2, criação assistida, plano curto e política automática sem regressão terminal, fuga inválida ou efeito artificial de `wait`.

Ordem obrigatória:

1. confirmar `develop` e working tree limpa;
2. executar lint, typecheck, unitários, integração PostgreSQL, validação OpenAPI e build;
3. revisar o diff dos commits de integridade terminal, fuga em etapas e `wait` temporal;
4. confirmar migrations do staging sem reset ou operação destrutiva;
5. implantar manualmente no Render somente após o gate;
6. validar health, readiness, criação, carga, auto-resolução, replay, terminalidade, fuga e ações genéricas;
7. atualizar OpenAPI, Instructions e Knowledge no GPT Builder de staging;
8. confirmar exatamente 20 Actions, a classificação consequencial explícita e a configuração salva;
9. observar logs sanitizados e preservar rollback.

Condições de parada:

- conflito entre `develop`, staging e GPT Builder;
- migration inesperada;
- falha de replay, idempotência, integridade terminal ou autoridade;
- exposição de payload, roll, UUID, credencial ou detalhe de infraestrutura;
- necessidade de ampliar escopo para recompensa, morte ou produção.

## Fase 1M-B — XP e level-up

Escopo previsto:

- política versionada de XP;
- distribuição e progressão idempotentes;
- limites e auditoria;
- nenhuma recompensa duplicada em replay;
- integração com o ledger terminal existente.

Não misturar com ouro, loot, comércio ou deploy de produção.

## Fase 1M-C — ouro, drop e claim de loot

Escopo previsto:

- geração e persistência autoritativa de drops;
- claim explícito e idempotente;
- ouro e inventário com capacidade/peso;
- distribuição entre protagonista e companheiros;
- proteção contra duplicação, perda silenciosa e replay.

## Backlog posterior

- checkpoints ou resumos narrativos persistidos;
- bestiário e persistência ampliada de NPCs, criaturas e companheiros;
- missões e relacionamentos;
- tempo, clima, localização e viagem;
- vendedores, lojas e economia;
- treinamento e progressão de habilidades;
- frontend ou ChatGPT App para ficha, inventário, mapa, missões e atores;
- autenticação pública, autorização por usuário, CORS, rate limit e observabilidade externa;
- consolidação editorial contínua do Knowledge narrativo.

## Regras de sequência

- Não misturar rollout de staging/GPT, XP e loot em uma única task.
- Banco remoto, Render, GPT Builder e produção exigem autorização explícita.
- Cada fase deve declarar escopo, fora de escopo, critérios, validações e rollback.
- Atualizar `CURRENT_STATE.md` após merge funcional, rollout ou mudança relevante de ambiente.
- Confirmar fatos mutáveis no Git e nos ambientes; documentação é baseline, não prova de implantação.
