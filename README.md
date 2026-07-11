# Crônicas de Outro Mundo

Repositório oficial de documentação, regras, estrutura persistente e integração do GPT **Crônicas de Outro Mundo**.

## Arquitetura

- **Instruções do GPT:** comportamento essencial e regras críticas.
- **Knowledge:** regras detalhadas do RPG medieval.
- **Supabase:** estado persistente da campanha.
- **OpenAPI:** Actions do GPT.
- **GitHub:** fonte versionada dos documentos, migrations, Edge Functions e contratos da API.

## Estrutura

```text
instructions/   Instruções principais do GPT
knowledge/      Arquivos para subir em Conhecimento
docs/           Arquitetura e decisões
supabase/       Migrations e código-fonte das Edge Functions
schemas/        Contratos OpenAPI oficiais
```

## Fonte de verdade

Para código e contratos:

1. GitHub;
2. deploy gerado a partir dos arquivos versionados;
3. ambiente Supabase em execução.

Para estado narrativo dinâmico:

1. estado retornado pelo Supabase;
2. Instruções do GPT;
3. arquivos de Knowledge;
4. inferência narrativa.

## OpenAPI

Contrato principal:

```text
schemas/openapi.json
```

Módulo oficial de conteúdo dinâmico:

```text
schemas/openapi-content.json
```

O módulo de conteúdo dinâmico expõe somente três operações:

- `searchWorldContent`;
- `upsertWorldContent`;
- `manageCharacterContent`.

Essas operações permitem consultar, criar e vincular magias, armas, armaduras, itens, materiais, habilidades, talentos, criaturas-base, locais, facções e outros conteúdos sem criar uma Action diferente para cada tipo.

## Fluxo obrigatório

```text
consultar → reutilizar quando existir → criar quando necessário → persistir → vincular ao personagem
```

NPCs e criaturas individuais continuam em atores persistentes. Modelos reutilizáveis ficam no catálogo unificado.

> Nunca coloque chaves, tokens ou credenciais neste repositório.