# Rollback de staging — RC1.3

Este pacote registra o ponto de retorno antes do rollout RC1.3. Ele não contém
credenciais, URLs de banco, chaves, tokens, cookies ou dumps.

## Baseline preservado

- Serviço Render: `cronicas-de-outro-mundo-staging-api` (workspace Ralph's workspace).
- Commit anteriormente implantado: `7280cce6eaca787677f3a1541f8424cc785c7174`.
- Branch implantada: `develop`.
- Auto-deploy: desligado; qualquer retorno requer um deploy manual deliberado.
- OpenAPI anterior: `git show 7280cce6eaca787677f3a1541f8424cc785c7174:gpt/openapi.json`.
- Instructions anteriores: `git show 7280cce6eaca787677f3a1541f8424cc785c7174:gpt/instructions.md` (7.482 code points).
- Knowledge anterior: os nove arquivos em
  `gpt/knowledge/` no commit `7280cce6eaca787677f3a1541f8424cc785c7174`.
- Actions anteriores: 21 `operationId` únicos no OpenAPI do commit de baseline.

## Procedimento de retorno

1. Interromper os smokes e registrar o `requestId`/erro sem incluir payloads
   sensíveis em tickets ou logs.
2. No Render de staging, disparar redeploy manual do commit de baseline somente
   para o serviço acima. Confirmar que a branch, o workspace e o commit são os
   indicados antes de confirmar a ação.
3. Se o banco também precisar voltar, executar explicitamente o reset
   clean-slate somente dos objetos allowlisted da aplicação no schema do jogo;
   preservar `auth`, `storage`, `realtime`, extensões e schemas internos da
   plataforma. A partir de um checkout do baseline, aplicar as migrations
   daquele commit. Não tentar downgrade in-place, backfill ou exclusão ampla de
   schemas.
4. Restaurar no GPT de staging os artefatos do commit de baseline: OpenAPI,
   Instructions e os mesmos nove Knowledge. Preservar a autenticação existente.
5. Revalidar health, readiness, os 21 `operationId` únicos e o estado vazio do
   banco antes de reabrir testes manuais.

## Limites

- Este procedimento é exclusivo do staging dedicado.
- Não usar o staging legado em sa-east-1 nem qualquer ambiente de produção.
- RC1.1 e RC1.2 continuam imutáveis; não regravar snapshots históricos.
