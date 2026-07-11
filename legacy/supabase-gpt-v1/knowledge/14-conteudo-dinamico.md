# Conteúdo Dinâmico Gerenciado pelo GPT

O GPT pode criar conteúdo novo quando a narrativa precisar, e o banco existe para preservar esse conteúdo e impedir perda de continuidade.

## Regra principal

Antes de criar algo persistente:

1. use `searchWorldContent`;
2. reutilize um resultado compatível quando existir;
3. use `upsertWorldContent` somente quando não houver conteúdo adequado ou quando uma atualização for necessária;
4. só declare o conteúdo como existente após confirmação da ferramenta;
5. use `manageCharacterContent` para vincular conteúdo ao personagem.

Nunca crie duplicatas apenas por pequenas diferenças de nome.

## Tipos de conteúdo

O catálogo unificado aceita:

- `spell`;
- `weapon`;
- `armor`;
- `item`;
- `material`;
- `skill`;
- `talent`;
- `creature_template`;
- `class`;
- `race`;
- `location`;
- `faction`;
- `quest_template`;
- `status_effect`;
- `recipe`;
- `other`.

NPCs e criaturas individuais continuam sendo atores persistentes gerenciados por `upsertEntity`. `creature_template` representa um modelo reutilizável, não um indivíduo específico.

## Escopo

Conteúdo sem `campaign_id` pertence ao mundo e pode ser reutilizado por qualquer campanha desse mundo.

Conteúdo com `campaign_id` é exclusivo da campanha atual.

Use escopo de mundo para magias comuns, armas genéricas, materiais, classes, raças e criaturas-base.

Use escopo de campanha para itens únicos, técnicas criadas por um personagem, locais secretos, facções particulares ou conteúdo ligado especificamente àquela história.

## Estrutura do conteúdo

Todo conteúdo possui:

- `code`: identificador estável e reutilizável;
- `name`: nome apresentado na narrativa;
- `description`: descrição permanente;
- `aliases`: nomes alternativos;
- `mechanics`: números e efeitos mecânicos;
- `requirements`: requisitos de uso ou aprendizado;
- `presentation`: aparência, efeitos visuais e detalhes sensoriais;
- `tags`: classificação e busca;
- `metadata`: dados adicionais;
- `status`: estado do conteúdo.

## Magias

Uma magia pode usar:

```json
{
  "content_type": "spell",
  "content": {
    "code": "minor_spark",
    "name": "Faísca",
    "description": "Uma centelha elemental inicial.",
    "mechanics": {
      "element": "fire",
      "mana_cost": 3,
      "power": 4
    },
    "requirements": {
      "minimum_level": 1,
      "training": ["mana_perception"]
    },
    "tags": ["elemental", "beginner", "fire"]
  }
}
```

O GPT pode criar uma magia coerente quando não existir uma opção adequada. A criação da magia não significa que o personagem a aprendeu.

Depois da criação, use `manageCharacterContent` com:

- `learn` para aprender;
- `update` para aumentar progresso ou domínio;
- `forget` para remover conhecimento;
- `grant` para conceder por evento especial.

## Armas, armaduras e itens

O catálogo guarda o modelo persistente. O vínculo com o personagem guarda propriedade, quantidade, equipamento e progresso.

Exemplo de arma:

```json
{
  "content_type": "weapon",
  "content": {
    "code": "silent_ash_sword",
    "name": "Espada de Cinzas Silenciosas",
    "mechanics": {
      "weapon_type": "longsword",
      "physical_damage": 12,
      "fire_damage": 2
    },
    "requirements": {
      "minimum_strength": 8
    },
    "tags": ["weapon", "sword", "uncommon"]
  }
}
```

Use `add` para entregar o item e `equip` para equipá-lo.

## Progressão do personagem

`manageCharacterContent` aceita:

- `learn`;
- `grant`;
- `add`;
- `equip`;
- `update`;
- `remove`;
- `forget`;
- `unequip`.

O vínculo pode guardar:

- `state`;
- `rank`;
- `progress`;
- `mastery`;
- `equipped`;
- `quantity`;
- `notes`;
- `metadata`.

Sempre use o ID interno do personagem retornado por `loadGame`. Nunca envie o nome do personagem no campo `character_id`.

## Limites de autonomia

O GPT pode criar conteúdo narrativo e mecânico, mas deve manter coerência com:

- nível atual;
- atributos;
- raridade;
- economia;
- regras do mundo;
- progressão já persistida;
- contexto da cena.

Não conceda automaticamente uma magia, arma ou habilidade apenas porque ela foi criada. Criação do conteúdo e aquisição pelo personagem são operações separadas.

Fórmulas estruturais do sistema, como progressão de nível, cálculo geral de dano, morte e limites máximos, continuam sendo regras do backend e não devem ser alteradas silenciosamente durante a narrativa.