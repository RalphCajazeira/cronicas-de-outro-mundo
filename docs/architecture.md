# Arquitetura

## Camadas

```text
GPT
├── Instruções
├── Knowledge
└── Actions
     └── Supabase Edge Functions
          └── PostgreSQL
```

## Fonte de verdade

- Supabase: estado vivo e persistente.
- GitHub: documentação e arquitetura versionadas.
- Knowledge: cópia publicada das regras.
- GPT Instructions: regras críticas de comportamento.

## Módulos atuais

- core;
- personagens;
- inventário;
- habilidades;
- magias;
- talentos;
- heranças opcionais;
- missões;
- NPCs;
- relacionamentos;
- combate;
- loot;
- mundo;
- tempo;
- clima;
- viagens;
- companheiros;
- Codex.

## Próximos módulos

- entidades persistentes;
- memórias por entidade;
- lojas e vendedores;
- estoque comercial;
- missões aprofundadas;
- facções e reputação;
- propriedades;
- guildas do jogador.
