# Validação, Testes, Commit e Push

## Regra principal

Use comandos reais do projeto. Não invente scripts.

Antes de rodar um script, confira `package.json`, documentação ou instruções do projeto.

## ESLint

Para projetos JavaScript/TypeScript, ESLint é a validação preferida de qualidade de código quando já estiver configurado ou quando a adoção tiver sido autorizada.

Preferir:

```text
eslint.config.js ou eslint.config.mjs
```

Scripts recomendados quando aplicável:

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix"
  }
}
```

Em monorepo, cada pacote pode ter seu próprio `lint`, e a raiz pode orquestrar:

```json
{
  "scripts": {
    "lint": "npm run lint --prefix backend && npm run lint --prefix frontend"
  }
}
```

Em projeto legado, propor a adoção de ESLint em task própria, com regras recomendadas e baixo risco. Endurecer regras em etapas posteriores.

## Validações comuns

Quando existirem:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## Projetos com backend/frontend

Quando existirem scripts por pasta:

```bash
npm run lint --prefix backend
npm run typecheck --prefix backend
npm run test --prefix backend
npm run build --prefix backend

npm run lint --prefix frontend
npm run typecheck --prefix frontend
npm run test --prefix frontend
npm run build --prefix frontend
```

## E2E

Playwright deve ser usado para fluxos críticos, não para tudo.

Antes de rodar E2E, verificar:

- banco de teste;
- fixtures;
- serviços necessários;
- variáveis de ambiente;
- custo de tempo;
- se o escopo da tarefa exige E2E.

## Antes de commit

Nunca commit sem autorização explícita.

Antes de pedir autorização ou preparar commit:

```bash
git status --short
git diff --name-only
git diff --check
```

Depois de autorização:

```bash
git add -A
git status --short
git diff --cached --name-status
git diff --cached --check
git commit -m "mensagem"
```

Depois do commit:

```bash
git rev-parse --short HEAD
git branch --show-current
git show --name-status --format="" HEAD
git status --short
```

## Antes de push

Nunca push sem autorização explícita.

Confirmar:

```bash
git status --short
git branch --show-current
git log -1 --oneline
```

Só fazer push se branch e commit estiverem corretos e working tree estiver limpa.

## O que nunca deve entrar no commit

- `.env` real;
- secrets;
- dumps de banco;
- logs;
- screenshots;
- vídeos;
- uploads locais;
- arquivos temporários;
- artefatos de build não versionados pelo projeto;
- lockfile de outro package manager.
