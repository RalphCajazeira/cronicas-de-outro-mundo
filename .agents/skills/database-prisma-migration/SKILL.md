---
name: database-prisma-migration
description: Use para Prisma, schema, migrations, seed, PostgreSQL, queries, constraints, índices e mudanças de banco.
---

# Skill: Database, Prisma and Migrations

## Princípios

- PostgreSQL é o banco relacional preferido.
- Prisma é o ORM padrão em Node/TypeScript.
- Não executar reset/drop/migration destrutiva sem autorização explícita.
- Preservar dados quando o projeto puder ter dados úteis.

## Antes de alterar schema

1. Ler schema atual e migrations existentes.
2. Identificar impacto em dados existentes.
3. Avaliar relação com API, frontend e testes.
4. Planejar migration reversível/segura quando possível.
5. Adicionar constraints/índices quando houver regra clara.
6. Atualizar seed apenas se necessário.

## Entrega

- mudança de modelo;
- impacto em dados;
- migration criada/necessária;
- comandos sugeridos/executados;
- validações;
- riscos.
