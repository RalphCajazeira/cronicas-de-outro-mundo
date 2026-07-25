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

O backend valida esses campos, publica uma versão imutável e executa conteúdo ativo fora de encontro por `resolveActorEffect`. Rolls, custos, dano, restauração e estados ativos são calculados e persistidos pelo backend; o GPT nunca envia roll nem calcula dano final, defesa final, precisão, crítico ou escalonamento como autoridade. Dentro de encontro, `manageEncounter resolve_beat` orquestra targeting, reações, casting/channel e efeitos por alvo. `prepare` referencia conteúdo conhecido e um trigger fechado; não gasta recurso até a execução confirmada. Conteúdo triggered/reaction/passive não pode ser disparado manualmente pelo GPT nem por atalho.

Antes de executar fora de encontro, consulte a ficha/efeitos para obter `mechanicsStateVersion`, `inventoryStateVersion`, `effectsStateVersion` e versões de HP/Mana/SP. Use a versão exata conhecida/mastered ou equipada, selecione somente self/single target/weapon attack e preserve a idempotency key no replay. Em encontro, use o catálogo compacto da cena e a versão devolvida; cada nova decisão usa nova chave e `resolve_beat`. Conflito exige releitura; recurso insuficiente, alvo inexistente, distância incompatível ou trigger impossível não autorizam substituição silenciosa.

Conhecer uma descrição não significa aprender ou dominar. Consulte o vínculo atual e respeite `locked`, `learning`, `known` e `mastered`, além de rank, progresso e maestria confirmados.

## Criação rápida segura

Prefira reutilizar conteúdo publicado e consultado por `getContent`. Em `reuse`, envie somente `mode`, `scope`, `code` e `contentType`; não reconstrua o profile. Quando a criação de conteúdo for indispensável, não improvise combinações de campos nem declare que foram “validadas” antes da resposta do backend.

Invariantes que não podem ser confundidos:

- `worldConfiguration.schemaVersion` e `campaignConfiguration.schemaVersion` usam o número `1`;
- `profile.schemaVersion` e `inventorySpec.schemaVersion` usam o número `1`;
- `profile.rulesetCode` usa `core-v1`;
- `inventorySpec.rulesetCode` usa `core-v1` e `inventoryRulesCode` usa `core-v1-inventory-v1`.

Na Criação Rápida use `starterBlueprint` diretamente em `definition`, nunca dentro de `profile`, e não reconstrua o profile. O backend materializa e valida estes códigos fechados:

- `simple_melee_weapon`, `simple_ranged_weapon` e `simple_magic_focus`;
- `basic_offensive_spell`, com `blueprintOptions.damageElement` opcional;
- `basic_mobility_skill` e `basic_healing_spell`;
- `basic_healing_consumable`;
- `starter_body_armor`, sempre no slot `body`.
- `secondary_modifier_equipment`, sempre com `contentType=armor`; aceita slot, `unitWeight` e modificadores allowlisted, mas precisa incluir ao menos um modificador defensivo (`physicalDefense`, `magicalDefense`, `physicalResistanceBps` ou `magicalResistanceBps`);
- `shadow_wrapped_status` e `veil_of_darkness_spell`, ligados por `linkedStatusCode`;
- `detect_hidden_skill`, capacidade de detecção/informação sem movimento falso.

Com `starterBlueprint`, envie identidade e apresentação (`code`, `name`, `description`, `presentation`, `status=active`), mas omita `profile`, `inventorySpec` e `definition.tags`: o backend deriva a mecânica e as tags canônicas. Não invente, copie nem remova tags para adequar um blueprint; se um erro técnico antigo apontar `definition.tags`, omita o campo na única correção. O `contentType` deve corresponder ao blueprint. Sem `starterBlueprint`, a publicação completa continua exigindo `tags` e um profile coerente. O vínculo `protagonistLink` concede conhecimento a magia/habilidade; arma, armadura, consumível e item físico são concedidos separadamente por `initialInventory`. Cada combinação `scope/contentType/code` aparece uma única vez no inventário inicial; agregue quantidade/stacks e equipe somente entrada única equipável.

Não envie `unitWeight`, `equipmentSlot` ou `secondaryModifiers` nos demais blueprints; seus pesos e slots são fixados pelo backend. Roupa puramente narrativa usa `contentType=clothing` sem blueprint mecânico.

Não existe `starterBlueprint` de classe. Em campanha com classe mecânica customizada, use uma definição `class` com o `profile` completo do exemplo OpenAPI: ativação passiva, custo `none` e concessões em `profile.grants`. `contentGrants` não pertence ao schema, e `starterBlueprint`/`blueprintOptions` nunca entram em `profile`.

O catálogo fixa custos, raridade, targeting, slots, efeitos e potência, enquanto nome, descrição, apresentação e elemento mágico allowlisted preservam a proposta narrativa. Para mecânica fora do catálogo, use os exemplos completos da ficha e o schema oficial. Se `INVALID_INPUT` apontar erro técnico e a correção preservar a intenção aprovada, corrija uma vez com nova idempotency key; mudança de custo, potência, arma principal, elemento ou conceito exige decisão do jogador.

Leitura Arcana, Memória Meticulosa, Avaliação, Análise e Identificação não podem receber mobilidade, dano ou bônus sem correspondência semântica. Se não houver capability oficial, mantenha o conceito narrativo e exponha a limitação no readiness. A capability mínima atual é `detect_hidden`: melhora detecção por uma ação e continua dependendo de `observe`/teste autoritativo; ela não revela livremente dados internos.
