# ESLint da base Node.js + TypeScript

Estes exemplos fazem parte da preparação padrão dos projetos do Ralph.

A estrutura usual é:

```text
project-root/
  backend/
  frontend/
```

- use o exemplo `backend` para Node.js + TypeScript;
- use o exemplo `frontend` para Vite + React + TypeScript;
- adicione scripts de lint no `package.json` de cada aplicação;
- adapte versões, paths e regras ao projeto real antes de aplicar;
- não substitua uma configuração existente sem diagnóstico e autorização.

Em projeto novo JavaScript/TypeScript, ESLint com flat config integra a base mínima. Em projeto existente sem lint, a configuração deve entrar em uma task própria e pequena, sem ser misturada a uma feature de negócio.

Consulte também:

- `docs/ai/eslint-and-code-quality.md`;
- `.agents/skills/code-quality-linting/SKILL.md`;
- `docs/ai/validation.md`.
