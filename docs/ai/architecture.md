# Architecture Guidelines

## Objetivo

> Detalhes operacionais de pastas, nomes de arquivos e separação de responsabilidades estão em `structure-and-responsibilities.md`.


Manter uma arquitetura fácil para humanos e agentes de IA entenderem, com baixo acoplamento, nomes explícitos e evolução incremental.

## Princípios

- Comece simples.
- Organize por domínio/módulo quando houver domínio claro.
- Evite separação global exagerada por tipo técnico em projetos modulares.
- Prefira nomes explícitos a abreviações.
- Evite abstrações genéricas antes de necessidade real.
- Mantenha contratos próximos do domínio.
- Documente decisões relevantes no `decision-log.md`.

## Estrutura full-stack preferida

Quando o projeto for uma aplicação completa com API separada:

```text
project-root/
  AGENTS.md
  docs/
    ai/
  backend/
  frontend/
```

## Backend modular recomendado

Comece com estrutura rasa por módulo:

```text
backend/src/modules/<module>/
  Create<Module>Controller.ts
  Create<Module>Service.ts
  Update<Module>Service.ts
  <Module>Repository.ts
  <module>.routes.ts
  <module>.schemas.ts
  <module>.types.ts
  <module>.test.ts
```

Se o módulo crescer, permitir subpastas locais:

```text
backend/src/modules/<module>/
  controllers/
  services/
  repositories/
  schemas/
  tests/
```

Não migrar para subpastas só por preferência estética.

## Frontend modular recomendado

Comece por módulo/tela/fluxo:

```text
frontend/src/modules/<module>/
  <Module>Page.tsx
  <Module>Form.tsx
  <module>Api.ts
  <module>Queries.ts
  <module>Schemas.ts
  <module>Types.ts
```

Se crescer:

```text
frontend/src/modules/<module>/
  _components/
  _hooks/
  _schemas.ts
  _types.ts
  <module>Api.ts
  <module>Queries.ts
```

## Backend vs frontend

Backend protege regra de negócio, autorização, validação crítica, persistência e integrações.

Frontend cuida de experiência, formulário, estado de UI, rotas e consumo de API.

O frontend nunca deve ser a única camada de proteção para permissões ou regras críticas.

## Next.js

Next.js não é padrão. Avaliar apenas se SEO, SSR, páginas públicas indexáveis, produto público full-stack ou app + site no mesmo produto forem requisitos centrais.

Se Next.js for escolhido, documentar:

- quando usar Server Components;
- quando usar Client Components;
- onde fica regra de negócio;
- se Server Actions são permitidas;
- estratégia de cache;
- autenticação;
- deploy.

## Projetos existentes

Não forçar esta estrutura em projeto antigo sem plano. Primeiro auditar, depois migrar por etapas.
