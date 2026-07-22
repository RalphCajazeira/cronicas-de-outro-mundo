# Fichas e coerência mecânica

## Ficha autoritativa do ator

A API atual persiste identidade e tipo; espécie, classe, papel e descrição; nível, XP e ouro; aparência, personalidade, metadados e estado. A parte mecânica é composta por exatamente nove atributos primários (`strength`, `vitality`, `agility`, `dexterity`, `intelligence`, `wisdom`, `perception`, `willpower`, `luck`), recursos HP/Mana/SP atuais e um snapshot derivado recomputável. Na criação inicial, a origem narrativa estruturada é preservada em `metadata.origin` sem ser convertida automaticamente em raça ou condição.

Estados atuais: `active`, `inactive`, `defeated`, `dead` e `archived`. Tipos atuais: `character`, `npc`, `creature`, `companion` e `spirit`.

O GPT envia somente `primaryAttributes` na criação. Cada valor deve ser inteiro de 4 a 16 e os nove devem somar 90. O protagonista sempre nasce no nível 1 e XP 0; demais atores aceitam nível 1–20. O backend inicia recursos cheios e devolve `resources.hp|mana|sp` com `current`/`max`, além de `secondaryAttributes`, versão mecânica e ruleset.

## Conteúdo e valores derivados

Habilidades, magias e outros conceitos podem existir como `ContentDefinition` e vínculo `ActorContent`. Posse física usa inventário separado; `equipped` é derivado dos slots ocupados e nunca pertence ao vínculo conceitual.

Uma espécie nominal usa `species`. Conteúdo `race` só é criado quando houver regra mecânica real. Condições canônicas usam `status_effect`, versão exata, duração/stacking allowlisted e persistência em `ActiveEffect`. Elas não são equipamento e sua projeção completa fica em `resolveActorEffect(operation=get)`.

O backend calcula máximos, poderes do ator, defesas, precisão, evasão, velocidades, crítico, movimento, capacidade, resistências e regenerações pelo `core-v1`. O GPT nunca envia esses resultados como autoridade. Modificadores de um item são aplicados ao snapshot somente enquanto sua instância estiver equipada; itens apenas carregados, reservados, consumidos ou destruídos não contribuem.

Peso e equipamento alteram `mechanicsStateVersion`, recompõem o snapshot e podem mudar encumbrance. Itens multisslot contam uma vez; remover ou mudar lifecycle de uma entrada equipada é rejeitado até o unequip explícito.

## Coerência

Interprete valores confirmados de modo coerente com espécie, classe, experiência, condição e contexto. Campos omitidos preservam o estado apenas conforme o contrato da operação; nunca substitua ficha conhecida por padrão genérico.

Mudanças permanentes só existem após confirmação. `updateActor` é narrativo e não altera nível, XP, atributos, recursos ou derivados. Dano, cura, gasto e efeitos só mudam após sucesso de `resolveActorEffect` fora de encontro ou de `manageEncounter` durante um encontro; falha, conflito ou mera inferência narrativa não alteram a ficha. Máximo aumentado não cura e máximo reduzido pode clampá-la. HP zero só produz `defeated` quando um encerramento/cancelamento confirmado encontra participante persistido ainda `active`; cura oficial de 0 para valor positivo reativa somente quem já estava `defeated`.

Durante o encontro persistente, o participante carrega versões da ficha, recursos, efeitos, action slots, zona e um `combatState` interno. `incapacitated_candidate` e sugestões não alteram `Actor.status`. Somente a resposta terminal bem-sucedida torna o outcome oficial, aplica `defeated`, remove os efeitos `scope=encounter` pertencentes ao encontro e registra o evento. Ela não concede XP, level-up, loot, ouro, progressão, morte ou recompensa material.

## Blueprints canônicos de início

Em `startGame.initialContentPackages[].definition` com `mode=create`, adapte nome/code sem retirar campos mecânicos. A definição física recebe também o `inventorySpec` indicado. Depois, conceda a versão exata em `initialInventory`; arma e armadura devem ser equipadas nos slots declarados. Estes são modelos válidos, não texto narrativo disfarçado de mecânica.

### Adaga inicial

```json
{
  "contentType": "weapon",
  "profile": {
    "schemaVersion": 1, "rulesetCode": "core-v1", "profileMode": "mechanical",
    "contentKind": "weapon", "code": "starter-dagger", "name": "Adaga inicial",
    "tier": 1, "rarity": "common", "activation": { "type": "active" },
    "cost": { "type": "none" }, "actionProfile": "quick",
    "targeting": { "type": "single_target", "rangeBand": "engaged", "maxTargets": 1 },
    "damageComponents": [{ "id": "starter-dagger-hit", "channel": "physical", "element": null, "baseDamage": 4, "scaling": "full", "canCrit": true }],
    "handedness": "one_handed", "weaponTags": ["dagger"]
  },
  "inventorySpec": {
    "schemaVersion": 1, "rulesetCode": "core-v1", "inventoryRulesCode": "core-v1-inventory-v1",
    "unitWeight": 1, "stacking": { "mode": "unique" },
    "equipmentSlots": ["main_hand", "off_hand"], "handedness": "one_handed"
  }
}
```

### Bola de fogo

```json
{
  "contentType": "spell",
  "profile": {
    "schemaVersion": 1, "rulesetCode": "core-v1", "profileMode": "mechanical",
    "contentKind": "spell", "code": "fireball", "name": "Bola de fogo",
    "tier": 1, "rarity": "common", "activation": { "type": "active" },
    "cost": { "type": "mana", "amount": 8 }, "actionProfile": "normal",
    "effects": [{ "type": "damage", "targeting": { "type": "single_target", "rangeBand": "medium", "maxTargets": 1 },
      "damageComponents": [{ "id": "fireball-fire", "channel": "magical", "element": "fire", "baseDamage": 8, "scaling": "full", "canCrit": true }] }]
  }
}
```

### Cura inicial

```json
{
  "contentType": "spell",
  "profile": {
    "schemaVersion": 1, "rulesetCode": "core-v1", "profileMode": "mechanical",
    "contentKind": "spell", "code": "starter-heal", "name": "Cura inicial",
    "tier": 1, "rarity": "common", "activation": { "type": "active" },
    "cost": { "type": "mana", "amount": 4 }, "actionProfile": "normal",
    "effects": [{ "type": "restore_resource", "resource": "hp", "amount": 12, "targeting": { "type": "self", "rangeBand": "self" } }]
  }
}
```

### Poção de cura

```json
{
  "contentType": "consumable",
  "profile": {
    "schemaVersion": 1, "rulesetCode": "core-v1", "profileMode": "mechanical",
    "contentKind": "consumable", "code": "healing-potion", "name": "Poção de cura",
    "tier": 1, "rarity": "common", "activation": { "type": "active" },
    "cost": { "type": "none" }, "actionProfile": "potion", "consumable": true,
    "effects": [{ "type": "restore_resource", "resource": "hp", "amount": 30, "targeting": { "type": "self", "rangeBand": "self" } }]
  },
  "inventorySpec": {
    "schemaVersion": 1, "rulesetCode": "core-v1", "inventoryRulesCode": "core-v1-inventory-v1",
    "unitWeight": 1, "stacking": { "mode": "stackable", "maxStack": 20 }
  }
}
```

### Armadura de corpo inteiro

```json
{
  "contentType": "armor",
  "profile": {
    "schemaVersion": 1, "rulesetCode": "core-v1", "profileMode": "mechanical",
    "contentKind": "armor", "code": "starter-body-armor", "name": "Armadura de corpo inteiro",
    "tier": 1, "rarity": "common", "activation": { "type": "passive" },
    "cost": { "type": "none" }, "defense": { "physicalFlatDefense": 5 },
    "equipmentSlots": ["body"]
  },
  "inventorySpec": {
    "schemaVersion": 1, "rulesetCode": "core-v1", "inventoryRulesCode": "core-v1-inventory-v1",
    "unitWeight": 3, "stacking": { "mode": "unique" }, "equipmentSlots": ["body"]
  }
}
```

`body` ocupa traje/armadura de corpo inteiro. `chest` é reservado a peitoral; nunca troque o slot para fazer um payload passar.

Este blueprint é um exemplo inicial adaptável, não uma regra universal de armadura. Defesa 5 é a única propriedade mecânica do perfil `common`; uma segunda propriedade independente excede esse orçamento. Peso 3 não garante ausência de penalidade: o backend calcula encumbrance pelo peso total carregado e pela capacidade do ator.
