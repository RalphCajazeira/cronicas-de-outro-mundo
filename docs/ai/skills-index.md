# Skills disponíveis para o Codex

As skills ficam em `.agents/skills/<nome>/SKILL.md` e servem como fluxos especializados. Elas não substituem `AGENTS.md`; complementam a execução quando a tarefa combina com a descrição da skill.

## Skills essenciais

- `project-intake`: primeira análise de projeto novo, iniciado ou legado.
- `reuse-before-create`: obrigatório antes de criar algo novo.
- `legacy-audit`: auditoria sem alteração em projeto antigo.
- `feature-implementation`: implementação incremental de feature.
- `architecture-refactor`: reestruturação e refatoração arquitetural.
- `dependency-evaluation`: avaliação antes de instalar biblioteca.
- `code-quality-linting`: ESLint, scripts de lint e padrões de qualidade de código.
- `testing-validation`: testes, build, typecheck e validação.
- `git-release-flow`: commit, push, PR, merge, rebase e release.

## Skills por domínio sensível ou escala

- `database-prisma-migration`: Prisma, PostgreSQL, schema e migrations.
- `auth-permissions`: login, OAuth, JWT/JWKS, permissões e autorização.
- `security-sensitive-feature`: dados sensíveis, LGPD, biometria, documentos e segurança.
- `payments-subscriptions`: pagamentos, marketplace, checkout, assinaturas e webhooks.
- `storage-media-upload`: upload, mídia, documentos, storage externo e URLs privadas.
- `realtime-feature`: Socket.IO, chat, status, presença e localização ao vivo.
- `mobile-app`: React Native/Expo, câmera, localização e push mobile.
- `document-workflow`: PDF, contracheque, aceite e assinatura eletrônica.
- `observability-production`: logs, Sentry, healthcheck, deploy e produção.

## Regra de uso

Quando uma tarefa se encaixar em mais de uma skill, combine as regras. Exemplo: pagamento com webhook usa `payments-subscriptions`, `security-sensitive-feature`, `database-prisma-migration` e `testing-validation`. Configuração de lint em projeto legado usa `code-quality-linting`, `legacy-audit` e `testing-validation`.

Não force o uso de skill quando a tarefa é simples. A prioridade continua sendo menor escopo seguro, reuso e validação.
