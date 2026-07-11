# AGENTS.md — Regras Universais do Repositório para Codex

Este arquivo é a fonte principal de orientação para agentes de código neste repositório.

## Papel do Codex

O Codex é o executor dentro do repositório. Ele deve:

- ler este `AGENTS.md` antes de alterar código;
- consultar `docs/ai/` conforme a tarefa;
- diagnosticar antes de mexer quando o escopo estiver incerto;
- implementar a menor mudança segura;
- reutilizar código existente antes de criar algo novo;
- preservar alterações existentes do usuário;
- rodar validações compatíveis;
- entregar resumo objetivo com arquivos alterados, validações e riscos.

O ChatGPT Project é o gerente técnico externo. Quando o prompt vier do ChatGPT, siga o escopo pedido por ele e este arquivo.

---

## Regra máxima de manutenção

Antes de criar qualquer arquivo, função, componente, hook, service, schema, tipo, módulo, helper, repository, rota ou teste novo:

1. Procure se já existe algo igual ou parecido.
2. Leia pelo menos os arquivos mais próximos da área afetada.
3. Reutilize o que já existe quando fizer sentido.
4. Adapte um padrão existente antes de inventar um novo.
5. Extraia algo reutilizável apenas quando houver uso real ou duplicação clara.
6. Crie novo somente quando não houver opção existente adequada.

Não duplique lógica por conveniência. Não crie abstração genérica cedo demais.

---

## Modos de projeto

### Projeto novo

Se o repositório estiver vazio ou quase vazio:

- faça Fase 0 antes de gerar código;
- identifique tipo de projeto, domínio, usuários, riscos e stack mínima;
- não instale dependências preventivamente;
- proponha estrutura simples que possa escalar;
- peça confirmação quando houver decisões de arquitetura relevantes.

### Projeto existente que já segue este kit

- mantenha padrões atuais;
- leia `docs/ai/project-context.md`, `docs/ai/architecture.md`, `docs/ai/reuse-and-maintainability.md` e docs específicos da tarefa;
- evite reestruturação fora do escopo;
- prefira mudanças incrementais.

### Projeto antigo/legado sem esta estrutura

- não reescreva tudo por padrão;
- faça auditoria sem alteração quando solicitado;
- descubra stack, scripts, package manager, estrutura, testes, riscos e padrões reais;
- proponha plano incremental;
- reestruture gradualmente conforme novas features/refactors;
- só proponha reestruturação ampla se o projeto for pequeno, o risco for baixo e houver autorização.

---

## Preferências técnicas padrão

Estas são preferências, não autorização para instalar tudo.

```text
Gerenciador padrão: npm.
Banco relacional padrão: PostgreSQL.
ORM Node/TypeScript padrão: Prisma.
Validação: Zod.
Qualidade de código: ESLint com flat config.
Backend API separada: Express + TypeScript.
Frontend SPA/dashboard: Vite + React + React Router + TanStack Query.
Formulários: React Hook Form + Zod quando houver formulário relevante.
UI nova: Tailwind CSS + shadcn/ui.
Autenticação OAuth/JWT/JWKS: jose.
Testes: Vitest, Supertest, Testing Library e Playwright para fluxos críticos.
Lint: ESLint recomendado para projetos JavaScript/TypeScript quando aplicável ao escopo real.
```

Não trocar npm por pnpm/yarn/bun sem autorização.
Não trocar Prisma/PostgreSQL sem motivo técnico real e aprovação.
Não usar Next.js como padrão. Next.js só deve ser sugerido quando SEO, SSR, páginas públicas indexáveis ou produto público full-stack forem requisitos centrais.

---

## Dependências

Não instale dependências preventivamente.

Antes de adicionar uma dependência, entregue:

- necessidade real;
- por que agora;
- biblioteca recomendada;
- alternativas;
- impacto no backend, frontend, banco, testes e deploy;
- risco de manutenção;
- comando de instalação proposto;
- confirmação aguardada, salvo quando o prompt já autorizou explicitamente a instalação.

Se o projeto já usa uma biblioteca equivalente, prefira manter e melhorar o padrão existente.

---

## Segurança e dados sensíveis

Nunca:

- alterar `.env` real sem autorização;
- exibir secrets no output;
- commitar `.env`, dumps, logs, uploads, screenshots, vídeos ou artefatos locais;
- rodar comandos destrutivos sem autorização;
- fazer reset/drop/migrate destrutivo em banco sem plano e confirmação;
- implementar autenticação, pagamento, assinatura, reconhecimento facial, geolocalização sensível, documentos ou biometria sem decisão explícita de segurança e auditoria.

Para funcionalidades sensíveis, consulte `docs/ai/security-and-sensitive-features.md`.

---

## Git, commit e push

Não faça commit sem autorização explícita.
Não faça push sem autorização explícita.
Não altere histórico, rebase, merge ou branch sem autorização.

Antes de sugerir commit, verifique:

```bash
git status --short
git diff --name-only
git diff --check
```

Depois de commit autorizado, informe hash, branch, arquivos commitados e `git status --short`.

Antes de push autorizado, confirme branch, último commit e working tree limpa.

---

## Validação

Use os scripts reais do projeto. Não invente script que não existe.

Em projetos JavaScript/TypeScript novos, considere ESLint desde a base mínima quando a stack estiver confirmada. Em projetos existentes sem ESLint, proponha uma task pequena para adicionar ESLint antes de grandes refactors, sem misturar com feature e sem instalar dependências sem autorização.

Se existir:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Em monorepo com `backend/` e `frontend/`, use scripts com `--prefix` se existirem:

```bash
npm run typecheck --prefix backend
npm run test --prefix backend
npm run build --prefix backend
npm run typecheck --prefix frontend
npm run test --prefix frontend
npm run build --prefix frontend
```

Se um comando não existir, diga isso e não invente substituto sem diagnosticar o `package.json`.

---

## Estrutura e arquitetura

Preferir organização por domínio/módulo quando o projeto for modular.

Comece simples. Use subpastas internas apenas quando houver volume, repetição ou separação clara de responsabilidade.

Para projetos full-stack separados, o padrão preferido é:

```text
backend/
frontend/
docs/
AGENTS.md
```

Consulte `docs/ai/structure-and-responsibilities.md` para detalhes de pastas, nomes de arquivos e separação de responsabilidades entre backend, frontend, mobile, raiz e banco.

Mas em projeto existente, preserve a estrutura atual até haver plano de migração.

---

## Documentação

Atualize `docs/ai/decision-log.md` quando houver decisão arquitetural relevante.
Atualize `docs/ai/project-context.md` quando o contexto do produto mudar.
Atualize documentação apenas quando isso ajudar manutenção; não gere documentação volumosa sem necessidade.

---

## Skills do repositório

Quando a tarefa combinar com uma skill em `.agents/skills/`, use essa skill como guia complementar.

Consulte `docs/ai/skills-index.md` para ver as skills disponíveis e quando aplicá-las.

Skills não substituem este `AGENTS.md`; elas detalham fluxos específicos como reuso, legado, dependências, qualidade de código/lint, banco, autenticação, pagamentos, tempo real, mobile, documentos, testes e Git.

---

## Entrega final do Codex

Ao final de cada tarefa, responda com:

```text
Resumo:
- ...

Arquivos alterados:
- ...

Validações executadas:
- ...

Validações não executadas:
- ... motivo ...

Riscos/observações:
- ...

Git:
- branch: ...
- git status --short: ...

Próximo passo sugerido:
- ...
```

Se não alterou arquivos, diga claramente.
