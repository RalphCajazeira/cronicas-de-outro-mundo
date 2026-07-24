# Fichas e coerência mecânica

## Ficha autoritativa do ator

A API atual persiste identidade e tipo; espécie, classe, papel e descrição; nível, XP e ouro; aparência, personalidade, metadados e estado. A parte mecânica é composta por exatamente nove atributos primários (`strength`, `vitality`, `agility`, `dexterity`, `intelligence`, `wisdom`, `perception`, `willpower`, `luck`), recursos HP/Mana/SP atuais e um snapshot derivado recomputável. Na criação inicial, a origem narrativa estruturada é preservada em `metadata.origin` sem ser convertida automaticamente em raça ou condição.

Estados atuais: `active`, `inactive`, `defeated`, `dead` e `archived`. Tipos atuais: `character`, `npc`, `creature`, `companion` e `spirit`.

`primaryAttributes` representa a base do nível 1. Cada valor deve ser inteiro de 4 a 16 e os nove somam exatamente 90. O protagonista de `startGame` nasce no nível 1 e XP 0; `upsertActor` aceita demais atores em qualquer nível inteiro positivo dentro do envelope técnico e `progressionPrimaryAttributes` fechado para ganhos já alocados. Ganhos podem ser menores que `10 × (level - 1)`, deixando saldo derivado. Na revisão atual não há nível máximo de gameplay nem cap efetivo fixo: atributo efetivo é base + ganho e todo ponto conquistado pode ser gasto.

`manageActorProgression(get)` devolve `basePrimaryAttributes`, `progressionPrimaryAttributes`, `effectivePrimaryAttributes`, pontos ganhos/alocados/disponíveis, XP, próxima exigência e versão. `grant_xp` exige `source.type/ref` estável; a mesma fonte não recompensa o mesmo ator duas vezes, mesmo com outra chave. `level_up` usa a curva versionada também acima do nível 20. Use as escritas somente após intenção clara. Ordem exata é executada; pedido de sugestão recebe 3–4 opções e aguarda escolha; delegação explícita autoriza escolher e executar; correção clara autoriza `set_progression_state` com motivo. Nunca simule esses dados em metadata.

## Conteúdo e valores derivados

Habilidades, magias e outros conceitos podem existir como `ContentDefinition` e vínculo `ActorContent`. Posse física usa inventário separado; `equipped` é derivado dos slots ocupados e nunca pertence ao vínculo conceitual.

Uma espécie nominal usa `species`. Conteúdo `race` só é criado quando houver regra mecânica real. Condições canônicas usam `status_effect`, versão exata, duração/stacking allowlisted e persistência em `ActiveEffect`. Elas não são equipamento e sua projeção completa fica em `resolveActorEffect(operation=get)`.

O backend calcula máximos, poderes do ator, defesas, precisão, evasão, furtividade, detecção, velocidades, crítico, movimento, capacidade, resistências e regenerações pelo `core-v1`. O GPT nunca envia esses resultados como autoridade. Modificadores de um item são aplicados ao snapshot somente enquanto sua instância estiver equipada; itens apenas conhecidos, carregados, reservados, consumidos ou destruídos não contribuem.

## Furtividade, detecção e surpresa (RC1.3)

`stealth = floor((2×agility + dexterity + perception + luck)/2)` e `detection = floor((2×perception + wisdom + intelligence + luck)/2)`, ambos mais modificadores autoritativos. São scores mecânicos brutos não percentuais: não há cap de gameplay em 100; o único envelope é o `INTEGER` não negativo do snapshot. Assim, progressão, Bota Élfica, Véu e debuffs continuam relevantes em níveis altos. O confronto calcula `stealth + contexto + contribuição do roll - detection - contribuição do roll`; empate (`0`) é sucesso, margem `>=20` é `high_success`, `0..19` é `success`, `-1..-19` é `failure` e `<=-20` é `critical_failure`. Luz, cobertura, ruído e ritmo usam enums fechados; o cliente nunca envia sucesso, margem ou roll.

Ocultação geral é `exposed|obscured|hidden`, mas a consciência é por observador: `unaware|suspicious|detected|tracking`. A cena pública mostra somente faixa de margem, nunca roll ou margem numérica. `hide` testa observadores hostis elegíveis; `sneak_move` também executa uma transição legal de zona e sofre penalidade por ritmo. `observe` pode atualizar a consciência.

Ataque surpresa só se aplica contra o alvo que ainda está `unaware`: +1500 bps de acerto e +1000 bps de chance crítica. Em dano que pode critar, a chance final segue o envelope normal de 100–2500 bps; `forcedCritical` é emitido pelo backend somente com margem `high_success` ou tag mecânica específica já persistida no conteúdo. Reação permanece normal. Cada alvo consulta a própria consciência e cada componente de dano usa o crítico autoritativo daquela resolução. O primeiro ataque revelador muda o atacante para exposto/tracking e consome a janela; replay devolve a resolução persistida. Véu das Trevas, sozinho, não torna invisível nem garante crítico.

Bota Élfica usa `secondary_modifier_equipment`, slot `feet`, peso 1 e quatro modificadores equipados: `evasion +2`, `movementSpeed +1`, `physicalDefense +2`, `magicalDefense +5`. Conhecer ou carregar o item não concede bônus; a versão possuída permanece pinada e só o equipamento efetivo contribui. Véu das Trevas custa 4 Mana, alvo self, aplica por cena o status Envolto em Sombras (`stealth +4`, `evasion +2`, `movementSpeed +1`, stacking refresh). O status melhora uma nova tentativa de `hide`, mas não altera consciência anterior, não força `hidden` e pode continuar ativo depois da revelação; fim da cena/remoção encerra todos os modificadores.

Peso e equipamento alteram `mechanicsStateVersion`, recompõem o snapshot e podem mudar encumbrance. Itens multisslot contam uma vez; remover ou mudar lifecycle de uma entrada equipada é rejeitado até o unequip explícito.

## Coerência

Interprete valores confirmados de modo coerente com espécie, classe, experiência, condição e contexto. Campos omitidos preservam o estado apenas conforme o contrato da operação; nunca substitua ficha conhecida por padrão genérico.

Mudanças permanentes só existem após confirmação. `updateActor` é narrativo e não altera nível, XP, atributos, recursos ou derivados. Progressão usa a Action oficial, idempotência e `expectedMechanicsStateVersion`; conflito exige novo `get`, nunca incremento inventado. Dano, cura, gasto e efeitos só mudam após sucesso de `resolveActorEffect` fora de encontro ou de `manageEncounter` durante um encontro. Falha ou inferência narrativa não alteram a ficha. Máximo aumentado não cura; máximo reduzido limita o atual ao novo máximo e registra o delta. HP zero só produz `defeated` quando um encerramento/cancelamento confirmado encontra participante persistido ainda `active`; cura oficial de 0 para valor positivo reativa somente quem já estava `defeated`.

Durante o encontro persistente, o participante carrega versões da ficha, recursos, efeitos, action slots, zona e um `combatState` interno. `incapacitated_candidate` e sugestões não alteram `Actor.status`. Somente a resposta terminal bem-sucedida torna o outcome oficial, aplica `defeated`, remove os efeitos `scope=encounter` pertencentes ao encontro e registra o evento. Ela não concede XP, level-up, loot, ouro, progressão, morte ou recompensa material.

## Blueprints canônicos de início

Na Criação Rápida, envie um `starterBlueprint` fechado e omita `profile`/`inventorySpec`; o backend materializa estes modelos com o `code` e `name` propostos. Os JSON abaixo auditam a mecânica completa também para criação avançada. Depois, `initialInventory` concede a versão publicada; arma/armadura são equipadas nos slots declarados. Vínculo conceitual não é posse.

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

### Passo ágil

```json
{
  "contentType": "skill",
  "profile": {
    "schemaVersion": 1, "rulesetCode": "core-v1", "profileMode": "mechanical",
    "contentKind": "skill", "code": "starter-step", "name": "Passo ágil",
    "tier": 1, "rarity": "common", "activation": { "type": "active" },
    "cost": { "type": "sp", "amount": 3 }, "actionProfile": "quick",
    "effects": [{ "type": "movement", "from": "near", "to": "engaged", "maximumTransitions": 1 }]
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

### Diário de viagem narrativo

```json
{
  "contentType": "other",
  "profile": null,
  "inventorySpec": {
    "schemaVersion": 1, "rulesetCode": "core-v1", "inventoryRulesCode": "core-v1-inventory-v1",
    "unitWeight": 1, "stacking": { "mode": "unique" }
  }
}
```

Este item pode ser possuído, mas não possui bônus, ação ou slot e nunca é equipado.

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
