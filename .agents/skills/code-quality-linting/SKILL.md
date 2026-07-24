---
name: code-quality-linting
description: Use quando a tarefa envolver ESLint, lint, padrões de código, TypeScript linting, configuração de qualidade de código, scripts de lint ou correção de problemas detectados por lint.
---

# Skill: Code Quality e ESLint

## Objetivo

Adicionar, manter ou corrigir ESLint sem bagunçar o projeto, sem trocar ferramentas existentes sem motivo e sem misturar lint com feature de negócio.

## Fluxo obrigatório

1. Identificar se o projeto é novo, existente ou legado.
2. Verificar package manager real.
3. Procurar configurações existentes:
   - `eslint.config.js`
   - `eslint.config.mjs`
   - `.eslintrc*`
   - `biome.json`
   - `oxlint*`
   - `.prettierrc*`
4. Verificar scripts reais em `package.json`.
5. Verificar se o escopo é backend, frontend, mobile ou raiz.
6. Propor dependências antes de instalar, salvo autorização explícita.
7. Usar flat config em projeto novo.
8. Em legado, começar com configuração recomendada e baixo risco.
9. Rodar lint e corrigir somente problemas seguros dentro do escopo.
10. Relatar erros restantes e plano incremental.

## Preferências de dependências

### TypeScript geral/backend

```bash
npm install -D eslint @eslint/js typescript-eslint globals
```

### React/Vite

```bash
npm install -D eslint @eslint/js typescript-eslint globals eslint-plugin-react-hooks eslint-plugin-react-refresh
```

### React opcional

```bash
npm install -D eslint-plugin-react
```

Use `eslint-plugin-react` apenas se o projeto precisar de regras React/JSX além de hooks.

## Scripts recomendados

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix"
  }
}
```

Em monorepo:

```json
{
  "scripts": {
    "lint": "npm run lint --prefix backend && npm run lint --prefix frontend"
  }
}
```

## Cuidados

- Não ativar regras muito rígidas de uma vez em projeto legado.
- Não formatar o projeto inteiro junto com feature.
- Não misturar troca de arquitetura com correção de lint.
- Não trocar ESLint por Biome/Oxlint sem decisão explícita.
- Não adicionar Prettier automaticamente se o pedido era só lint.

## Entrega final

Incluir:

- dependências adicionadas;
- arquivos de configuração criados/alterados;
- scripts adicionados;
- resultado de `npm run lint`;
- problemas corrigidos;
- problemas restantes, se houver;
- risco de continuidade.
