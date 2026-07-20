# Fontes de poder, classes, magias e talentos

Poder e progressão devem respeitar nível, contexto, requisitos, treino e estado confirmado. Fontes narrativas possíveis incluem classe, estudo, prática, fé, pacto, bênção, maldição, artefato, origem e experiência. Não imponha evolução racial por porcentagem.

Classes podem ser representadas pelo campo `className` do ator e, quando houver uma definição reutilizável, por conteúdo do tipo `class`. Habilidades, magias e talentos usam `ContentDefinition` dos tipos correspondentes e só pertencem ao ator após vínculo confirmado em `ActorContent`.

O modelo da Campaign diferencia classes inexistentes, classes de identidade e classes mecânicas. Em `none`, `className` fica ausente e progressão não depende de classe. Em `identity`, `className` é somente rótulo narrativo e não concede benefício nem autoriza requisitos mecânicos de classe. Em `mechanical`, a classe inicial usa exatamente uma definição `class` vinculada como conhecida ou dominada, e `className` coincide exatamente com o nome público da versão vinculada, nunca com seu code; outros requisitos usam `profile.requirements.requiredContent` com tipo e code estáveis.

Uma ficha de poder canônica descreve no `profile` fechado e em `presentation`, conforme aplicável:

- ativação, categoria e elemento;
- custo de recurso;
- conjuração, alcance, duração e recarga;
- efeitos e riscos;
- requisitos e progressão;
- aparência e efeitos sensoriais.

O backend valida esses campos, publica uma versão imutável e executa conteúdo ativo fora de encontro por `resolveActorEffect`. Rolls, custos, dano, restauração e estados ativos são calculados e persistidos pelo backend; o GPT nunca envia roll nem calcula dano final, defesa final, precisão, crítico ou escalonamento como autoridade. Dentro de encontro, `manageEncounter` orquestra targeting, reações, casting/channel e efeitos por alvo; conteúdo triggered/reaction/passive não pode ser disparado manualmente pelo GPT nem por um atalho em `resolveActorEffect`.

Antes de executar fora de encontro, consulte a ficha/efeitos para obter `mechanicsStateVersion`, `inventoryStateVersion`, `effectsStateVersion` e versões de HP/Mana/SP. Use a versão exata conhecida/mastered ou equipada, selecione somente self/single target/weapon attack e preserve a idempotency key no replay. Em encontro, use a versão de estado devolvida e o próximo passo indicado por `manageEncounter`. Conflito exige releitura; recurso insuficiente ou `REQUIRES_ACTION_ORCHESTRATOR` não autoriza inventar resultado.

Conhecer uma descrição não significa aprender ou dominar. Consulte o vínculo atual e respeite `locked`, `learning`, `known` e `mastered`, além de rank, progresso e maestria confirmados.

## Criação rápida segura

Prefira reutilizar conteúdo publicado e consultado por `getContent`. Em `reuse`, envie somente `mode`, `scope`, `code` e `contentType`; não reconstrua o profile. Quando a criação de conteúdo for indispensável, não improvise combinações de campos nem declare que foram “validadas” antes da resposta do backend.

Invariantes que não podem ser confundidos:

- `worldConfiguration.schemaVersion` e `campaignConfiguration.schemaVersion` usam o número `1`;
- `profile.schemaVersion` e `inventorySpec.schemaVersion` usam o número `1`;
- `profile.rulesetCode` usa `core-v1`;
- `inventorySpec.rulesetCode` usa `core-v1` e `inventoryRulesCode` usa `core-v1-inventory-v1`.

Para um starter novo, copie um template mecânico já aprovado e altere apenas `code`, `name`, descrição, lore, tags e apresentação. Preserve os demais campos até uma decisão mecânica consciente. Padrões tier 1 aprovados:

- arma comum de uma mão: ativação `active`, custo `none`, `actionProfile=quick`, targeting `single_target/engaged/maxTargets=1`, um dano físico base 4 com scaling `full` e crítico, `handedness=one_handed`, uma `weaponTag`;
- armadura comum: ativação `passive`, custo `none`, `defense.physicalFlatDefense=5`, `equipmentSlots=[chest]`;
- escudo incomum: ativação `passive`, custo `none`, `defense.blockValue=4`, `equipmentSlots=[off_hand]`, efeito `grant_reaction` com `reactionKind=block` e `reactionDepth=1`;
- roupa narrativa: somente campos narrativos canônicos; slot físico fica também no `inventorySpec`, nunca inventado fora do schema;
- habilidade comum `whirlwind`: ativação `active`, custo SP 6, `actionProfile=whirlwind`, efeito `damage` multi-target engaged com até 3 alvos e multiplicadores aprovados pelo contrato;
- consumível comum de cura: ativação `active`, custo `none`, `actionProfile=normal`, `consumable=true`, efeito `restore_resource` de HP 30 com targeting `self/self`.

Não altere custos, raridade, targeting, slots, efeitos ou potência desses padrões por estética. Para uma ficha diferente, proponha a diferença, valide pelo contrato e só persista após confirmação explícita. Se `INVALID_INPUT` apontar profile inválido, mostre a correção; o payload alterado usa nova idempotency key e exige nova confirmação.
