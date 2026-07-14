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

O backend valida esses campos, publica uma versão imutável e executa conteúdo ativo pela Action futura `resolveActorEffect`. Rolls, custos, dano, restauração e estados ativos são calculados e persistidos pelo backend; o GPT nunca envia roll nem calcula dano final, defesa final, precisão, crítico ou escalonamento como autoridade. Conteúdo triggered/reaction/passive não pode ser disparado manualmente, e multi-target exige orquestrador futuro.

Antes de executar, consulte a ficha/efeitos para obter `mechanicsStateVersion`, `inventoryStateVersion`, `effectsStateVersion` e versões de HP/Mana/SP. Use a versão exata conhecida/mastered ou equipada, selecione somente self/single target/weapon attack e preserve a idempotency key no replay. Conflito exige releitura; recurso insuficiente ou `REQUIRES_ACTION_ORCHESTRATOR` não autoriza inventar resultado.

Conhecer uma descrição não significa aprender ou dominar. Consulte o vínculo atual e respeite `locked`, `learning`, `known` e `mastered`, além de rank, progresso e maestria confirmados.
