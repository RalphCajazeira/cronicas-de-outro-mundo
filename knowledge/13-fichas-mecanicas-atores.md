# Fichas Mecânicas de Atores Persistentes

Todo ator persistente relevante deve possuir ficha mecânica suficiente para participar de combate, evolução e testes narrativos.

Isso se aplica a:

- personagens;
- NPCs relevantes;
- criaturas nomeadas;
- espíritos;
- companheiros;
- comerciantes que possam agir em cena;
- mestres de guilda;
- chefes;
- divindades;
- construtos e outros atores recorrentes.

## Campos mecânicos

A ficha unificada do ator pode conter:

- `level`;
- `xp`;
- `gold`;
- `health`;
- `max_health`;
- `mana`;
- `max_mana`;
- `attributes`;
- `resistances`;
- `abilities`;
- `elemental_affinities`;
- `equipment`.

## Atributos principais

Use em `attributes` o padrão:

```json
{
  "strength": 8,
  "agility": 8,
  "vitality": 8,
  "intelligence": 8,
  "charisma": 8
}
```

Não coloque HP, MP, ataque ou defesa dentro de `attributes`.

- Vida usa `health` e `max_health`.
- Mana usa `mana` e `max_mana`.
- Resistências usam `resistances`.
- Técnicas, passivas, magias e poderes usam `abilities`.
- Afinidades mágicas usam `elemental_affinities`.
- Itens equipados usam `equipment`.

## Criação

Ao registrar ator relevante com `upsertEntity`, forneça valores coerentes com:

- espécie;
- tipo;
- nível;
- idade aparente;
- papel narrativo;
- treinamento;
- afinidade mágica;
- condição atual.

Quando `attributes` não for enviado, o backend aplica valores-base de acordo com o tipo do ator.

Espíritos e divindades recebem reserva de mana padrão. Atores sem aptidão mágica podem ter mana zero intencionalmente.

## Atualização

`upsertEntity` também atualiza fichas existentes.

Campos omitidos preservam os valores atuais. Objetos como `attributes` e `resistances` são mesclados com a ficha existente. Listas como `abilities`, `elemental_affinities` e `equipment` são substituídas apenas quando enviadas.

Nunca substitua uma ficha completa por valores genéricos sem justificativa narrativa.

## Companheiros

Tornar-se companheiro não cria uma segunda ficha mecânica.

O ator mantém:

- seus atributos;
- sua vida e mana;
- suas habilidades;
- suas resistências;
- suas afinidades;
- seus equipamentos;
- seu histórico.

O pacto acrescenta apenas o vínculo de companheiro.

## Coerência

A ficha mecânica deve refletir a narrativa, mas mudanças permanentes só existem após confirmação da ferramenta persistente.

Não invente números depois de uma falha de ferramenta. Não declare evolução, dano, cura, aprendizado ou equipamento sem confirmação quando isso alterar o estado persistente.