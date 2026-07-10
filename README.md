# Crônicas de Outro Mundo

Repositório oficial de documentação, regras, estrutura persistente e integração do GPT **Crônicas de Outro Mundo**.

## Arquitetura

- **Instruções do GPT:** comportamento essencial e regras críticas.
- **Knowledge:** regras detalhadas do RPG medieval.
- **Supabase:** estado persistente da campanha.
- **OpenAPI:** Actions do GPT.
- **GitHub:** fonte versionada dos documentos e da arquitetura.

## Estrutura

```text
instructions/   Instruções principais do GPT
knowledge/      Arquivos para subir em Conhecimento
docs/           Arquitetura e decisões
supabase/       Referência de banco, migrations e Edge Functions
schemas/        OpenAPI e exemplos
```

## Fonte de verdade

1. Estado retornado pelo Supabase
2. Instruções do GPT
3. Arquivos de Knowledge
4. Inferência narrativa

## OpenAPI

```text
https://whrsjzmjceyvrjulxksq.supabase.co/functions/v1/rpg-openapi
```

> Nunca coloque chaves, tokens ou credenciais neste repositório.
