# Crônicas de Outro Mundo

Repositório oficial de documentação, regras, estrutura persistente e integração do GPT **Crônicas de Outro Mundo**.

## Arquitetura

- **Instruções do GPT:** comportamento essencial e regras críticas.
- **Knowledge:** regras detalhadas do RPG medieval.
- **Supabase:** estado persistente da campanha e resolvedores mecânicos.
- **OpenAPI:** Actions públicas do GPT.
- **GitHub:** fonte versionada dos documentos, migrations, Edge Functions e contratos da API.

## Estrutura

```text
instructions/   Instruções principais do GPT
knowledge/      Arquivos para subir em Conhecimento
docs/           Arquitetura e decisões
supabase/       Migrations e código-fonte das Edge Functions
schemas/        Contrato OpenAPI oficial
```

## Fonte de verdade

Para código e contratos:

1. GitHub;
2. deploy e migrations gerados a partir dos arquivos versionados;
3. ambiente Supabase em execução.

Para estado narrativo dinâmico:

1. estado retornado pelo Supabase;
2. Instruções do GPT;
3. arquivos de Knowledge;
4. inferência narrativa.

## OpenAPI único

Existe apenas um contrato oficial para copiar e colar no editor do GPT:

```text
schemas/openapi.json
```

Versão atual:

```text
9.0.0
```

Ele reúne todas as Actions, inclusive:

- estado e recuperação;
- mundo e viagem;
- combate;
- atores e memórias;
- companheiros;
- Codex;
- conteúdo dinâmico.

O conteúdo dinâmico continua exposto por apenas três operações:

- `searchWorldContent`;
- `upsertWorldContent`;
- `manageCharacterContent`.

`manageCharacterContent` também permite leitura sem criar nova Action:

- `operation: get` para consultar um vínculo específico;
- `operation: list` com `content_id: "*"` para listar vínculos e atributos derivados.

## Blueprints mecânicos

A Fase 1 adicionou modelos consultáveis para:

- habilidades;
- magias;
- armas;
- armaduras;
- escudos;
- itens.

`searchWorldContent` devolve o `blueprint` do tipo solicitado, contendo campos obrigatórios, recomendados, padrões e exemplo completo.

`upsertWorldContent` normaliza o conteúdo e rejeita conteúdo ativo mecanicamente incompleto.

Conteúdos persistidos passam a registrar:

- `schema_version`;
- `validation_status`;
- `validation_errors`;
- `validated_at`.

## Fluxo obrigatório

```text
consultar conteúdo e blueprint
→ reutilizar quando existir
→ criar ficha mecânica completa quando necessário
→ validar e persistir
→ vincular ao personagem
→ consultar estado e atributos derivados
```

NPCs e criaturas individuais continuam em atores persistentes. Modelos reutilizáveis ficam no catálogo unificado.

## Próximas fases

1. inventário universal para personagens, NPCs e inimigos;
2. encontros com equipamentos e itens físicos definidos antes do combate;
3. loot derivado do inventário real;
4. resolvedor de ações com buffs, debuffs, furtividade, percepção e proficiência;
5. comércio e estoque de lojas.

> Nunca coloque chaves, tokens ou credenciais neste repositório.