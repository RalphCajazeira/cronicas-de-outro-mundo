# ESLint e Qualidade de Código

## Objetivo

ESLint é a ferramenta padrão para manter consistência, detectar problemas e reduzir variações de estilo que confundem manutenção humana e agentes de código.

## Quando usar

Use ESLint em todo projeto JavaScript/TypeScript que tenha código de aplicação, backend, frontend, mobile ou scripts relevantes.

## Configuração preferida

Preferir flat config:

```text
eslint.config.js
eslint.config.mjs
```

Evitar criar `.eslintrc` em projeto novo, salvo se o projeto já usa configuração legada.

## Dependências recomendadas por cenário

### TypeScript geral

```bash
npm install -D eslint @eslint/js typescript-eslint globals
```

### Backend Node/Express

```bash
npm install -D eslint @eslint/js typescript-eslint globals
```

### Frontend React/Vite

```bash
npm install -D eslint @eslint/js typescript-eslint globals eslint-plugin-react-hooks eslint-plugin-react-refresh
```

Opcional, quando o projeto precisar de regras React/JSX além de hooks:

```bash
npm install -D eslint-plugin-react
```

## Scripts recomendados

No pacote afetado:

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix"
  }
}
```

Na raiz de projeto com `backend/` e `frontend/`:

```json
{
  "scripts": {
    "lint": "npm run lint --prefix backend && npm run lint --prefix frontend",
    "lint:fix": "npm run lint:fix --prefix backend && npm run lint:fix --prefix frontend"
  }
}
```

## Regras para projeto novo

- Adicionar ESLint na base inicial de qualquer projeto JavaScript/TypeScript.
- Usar configuração simples e recomendada.
- Evitar regras excessivamente opinativas no início.
- Integrar `npm run lint` ao checklist de validação.

## Regras para projeto legado

- Não adicionar ESLint junto com uma feature de negócio, salvo autorização explícita.
- Fazer uma task pequena: diagnosticar stack, instalar dependências, configurar lint, rodar, corrigir apenas problemas seguros.
- Não refatorar o projeto inteiro só para satisfazer lint.
- Se houver muitos erros, configurar regras gradualmente ou limitar o escopo inicial.

## Regras para Codex

Antes de mexer em lint:

1. Conferir package manager real.
2. Conferir se já existe ESLint, Prettier, Biome, Oxlint ou configuração equivalente.
3. Conferir scripts no `package.json`.
4. Propor dependências e scripts antes de instalar.
5. Não trocar ferramenta existente sem justificativa.
6. Rodar `npm run lint` e relatar erros restantes.

## ESLint, Prettier, Biome e Oxlint

Padrão do usuário: ESLint.

Prettier pode ser usado para formatação se o projeto quiser separar formatação de lint.
Biome/Oxlint podem ser avaliados caso a performance vire problema, mas não são padrão.
Não misturar ferramentas sem decisão documentada.
