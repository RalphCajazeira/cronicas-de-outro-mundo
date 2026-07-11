# Padrões Mecânicos de Conteúdo

Este arquivo define como o GPT deve criar e consultar habilidades, magias, armas, armaduras, escudos e itens.

## Princípio

O GPT cria e narra. O backend valida, calcula e persiste.

Todo conteúdo ativo deve possuir:

- `code` estável;
- `name`;
- `description`;
- `mechanics`;
- `requirements`;
- `presentation` quando houver efeitos visuais ou sensoriais;
- `tags` para busca e classificação.

Antes de criar, use `searchWorldContent` com `content_type`. A resposta contém:

- `items`: conteúdos já existentes;
- `blueprint`: modelo oficial do tipo solicitado, com campos obrigatórios, recomendados, valores padrão e exemplo completo.

Nunca crie conteúdo mecânico sem consultar o blueprint correspondente quando ele estiver disponível.

## Validação

`upsertWorldContent` normaliza o conteúdo com os valores padrão do blueprint e valida os campos obrigatórios.

Conteúdo com `status: active` é rejeitado quando a ficha mecânica obrigatória está incompleta.

Conteúdo incompleto pode ser salvo como `draft`, mas não deve ser utilizado oficialmente em combate, progressão, comércio ou loot.

Cada conteúdo persistido possui:

- `schema_version`;
- `validation_status`;
- `validation_errors`;
- `validated_at`.

Use somente conteúdo `active` com `validation_status: valid` nas regras mecânicas.

## Habilidades

Campos principais em `mechanics`:

- `activation`: `active`, `passive`, `reaction` ou `toggle`;
- `category`: mobilidade, ataque, defesa, controle, suporte ou utilidade;
- `element`, quando aplicável;
- `resource_cost`;
- `cooldown_turns`;
- `duration_turns`;
- `effects`;
- `scaling`;
- riscos durante aprendizado, quando aplicável.

Exemplo de custo:

```json
{
  "resource": "mana",
  "amount": 3
}
```

Exemplo de efeito:

```json
{
  "type": "evasion_bonus",
  "value": 10,
  "target": "self"
}
```

Criar uma habilidade não significa que o personagem aprendeu. Use `manageCharacterContent` separadamente.

## Magias

Campos principais:

- ativação;
- elemento;
- poder base;
- tipo de dano ou efeito;
- custo de mana;
- tempo de conjuração;
- alcance;
- área;
- recarga;
- efeitos adicionais;
- escalonamento por atributos e afinidades.

O dano final nunca é apenas o poder base. O backend deve combinar poder base, atributos, proficiência, afinidades, buffs, debuffs, resistências e situação tática.

## Armas

Campos obrigatórios:

- `weapon_type`;
- `base_damage`;
- `damage_type`;
- `durability_max`;
- `scaling`.

Campos recomendados:

- precisão;
- velocidade;
- alcance;
- número de mãos;
- bônus crítico;
- peso.

A arma visível ou utilizada por um ator deve existir como item real antes do combate. O loot não deve inventar outra arma após a derrota.

## Armaduras e escudos

Armaduras usam:

- tipo;
- slot;
- defesa base;
- resistências;
- penalidade de movimento;
- durabilidade;
- peso.

Escudos usam:

- tipo de escudo;
- slot;
- defesa base;
- chance de bloqueio;
- resistências;
- penalidade de movimento;
- durabilidade;
- peso.

## Itens

Itens devem informar:

- `item_type`;
- `stackable`;
- `base_value`;
- peso;
- quantidade máxima por pilha;
- efeitos, cargas ou usos quando aplicável.

Objetos ocultos devem existir no inventário real, mesmo que o personagem ainda não saiba deles.

## Conteúdo do personagem

`manageCharacterContent` suporta:

- `get`: consultar um vínculo específico sem alterar dados;
- `list`: listar todo o conteúdo vinculado e os atributos derivados. Use `content_id: "*"`;
- `learn`;
- `grant`;
- `add`;
- `equip`;
- `update`;
- `remove`;
- `forget`;
- `unequip`.

O retorno de `get` e `list` inclui:

- conteúdo completo;
- estado, rank, progresso, maestria, quantidade e observações;
- `derived_stats` calculados pelo backend.

## Atributos derivados

A primeira versão calcula:

- poder de ataque;
- poder mágico;
- defesa;
- precisão;
- evasão;
- movimento;
- resistências;
- vida e mana atuais e máximas.

Esses valores partem dos atributos principais e recebem modificadores de equipamentos e habilidades passivas válidas.

Habilidades ativas, buffs temporários, debuffs e condições serão aplicados pelo resolvedor de ações e pelo sistema de efeitos em fases posteriores.

## Passo da Brisa

A técnica oficial possui:

- ativação ativa;
- elemento Ar;
- custo de 3 de mana;
- duração de 1 turno;
- recarga de 1 turno;
- multiplicador de movimento de 1,25;
- bônus de evasão 10;
- bônus de equilíbrio 15;
- escalonamento por Agilidade, Inteligência e afinidade com Ar;
- uso permitido durante aprendizado;
- risco de tropeço e custo adicional durante aprendizado.

Ralph permanece com:

- `state: learning`;
- `rank: 1`;
- `progress: 10`;
- `mastery: 0`;
- `notes: Treino inicial com Lyra`.

Conhecer a descrição da técnica não significa dominá-la. O estado persistente do vínculo determina sua progressão.