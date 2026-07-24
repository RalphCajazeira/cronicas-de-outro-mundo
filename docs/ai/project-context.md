# Contexto do Projeto — preencher para cada projeto

Este arquivo registra o que é específico do projeto. A base geral atual já assume Node.js + TypeScript, npm e, para aplicações full-stack, `backend/` e `frontend/` na raiz.

Preencha somente o que confirma, altera ou complementa o padrão.

## Nome do projeto

`[preencher]`

## Tipo de projeto

```text
[ ] aplicação full-stack com backend/ e frontend/
[ ] API isolada
[ ] frontend isolado
[ ] dashboard/ERP/sistema interno
[ ] marketplace/e-commerce
[ ] SaaS público
[ ] mobile/app
[ ] projeto legado em migração
[ ] outro: ...
```

## Objetivo do produto

Descreva em poucas linhas o problema resolvido, para quem e qual resultado esperado.

## Usuários principais

```text
- administrador
- cliente
- funcionário
- vendedor
- gestor
- suporte
- outro
```

## Estrutura do repositório

Padrão para aplicação completa:

```text
project-root/
  AGENTS.md
  README.md
  docs/ai/
  backend/
  frontend/
```

Registre somente diferenças ou pastas adicionais realmente necessárias:

```text
Estrutura atual:
Exceções:
Pastas adicionais justificadas:
```

## Stack atual ou desejada

Padrão geral:

```text
Runtime: Node.js 22
Linguagem: TypeScript
Gerenciador: npm
Backend: Express + Zod
Banco: PostgreSQL
ORM: Prisma
Frontend: Vite + React + React Router + TanStack Query
Formulários: React Hook Form + Zod
UI: Tailwind CSS + shadcn/ui
Auth/JWT/OAuth: jose
Qualidade: ESLint com flat config
Testes: Vitest, Supertest, Testing Library e Playwright para fluxos críticos
```

Registre o estado real e as exceções:

```text
Frontend:
Backend:
Banco:
ORM:
Autenticação:
Testes:
Deploy:
Storage:
Tempo real:
Mobile:
Exceções à base geral:
```

Não troque a stack geral por preferência local. Exceções devem ter motivo técnico e autorização.

## O que não instalar agora

Liste bibliotecas, serviços ou capacidades que devem esperar necessidade real.

## Regras de negócio conhecidas

- `[preencher]`

## Requisitos sensíveis

```text
[ ] pagamento
[ ] assinatura recorrente
[ ] documentos assinados
[ ] reconhecimento facial
[ ] biometria
[ ] localização
[ ] chat ao vivo
[ ] tempo real
[ ] upload privado
[ ] dados financeiros
[ ] dados de menores
[ ] LGPD, retenção ou exclusão
```

## Estado do projeto

```text
[ ] novo ou vazio
[ ] iniciado com esta base
[ ] existente sem esta base
[ ] legado em produção
[ ] legado sem produção
```

## Estratégia de evolução

```text
[ ] começar mínimo e escalar por necessidade
[ ] preservar a arquitetura atual
[ ] reestruturar gradualmente
[ ] reestruturação ampla permitida, se justificada e autorizada
```

## Decisões e restrições específicas

```text
Decisões:
Restrições:
Riscos:
Fora de escopo atual:
```
