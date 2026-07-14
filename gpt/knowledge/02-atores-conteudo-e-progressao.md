# Atores, conteúdo e progressão

## Persistência estruturada atual

`Actor` representa personagem ou figura individual relevante. Possui `code` estável, identidade básica, descrição, metadados, estado e ficha mecânica autoritativa calculada pelo backend. Os tipos atuais são `character`, `npc`, `creature`, `companion` e `spirit`.

A ficha pública contém nove `primaryAttributes`, recursos atuais/máximos de HP, Mana e SP com `stateVersion`, `secondaryAttributes`, versões de mecânica/inventário/efeitos e ruleset. O GPT propõe os atributos iniciais e, para NPC/criatura, nível 1–20; não propõe máximos nem derivados. Recursos começam cheios. A Action futura `resolveActorEffect` pode gastar/restaurar recursos e aplicar dano de forma autoritativa; cada escrita exige os tokens lidos imediatamente antes.

`ContentDefinition` representa a identidade estável de conteúdo reutilizável no mundo ou em uma campanha. Nome, descrição, perfil, apresentação, tags e metadados pertencem a uma `ContentVersion` imutável. Os 13 tipos canônicos são arma, armadura, escudo, roupa, magia, habilidade, talento, item, consumível, efeito de estado, raça, classe e modelo de criatura. Material, localização, facção, modelo de missão, receita e outros continuam narrativos genéricos, sem perfil mecânico.

Efeitos `apply_status` e `remove_status` são vinculados na publicação a uma versão exata de `status_effect`. Publicar v2 do status não altera uma magia v1; somente nova versão da fonte pode fixar a versão nova.

`ActorContent` liga uma definição e uma versão específica a um ator e registra somente `state`, `rank`, `progress`, `mastery`, `notes` e metadados. Estados de progressão: `locked`, `learning`, `known` e `mastered`. Uma nova publicação não migra silenciosamente vínculos antigos.

O inventário físico é separado: entradas são instâncias ou stacks fixados em versões exatas, e equipamento é derivado de slots físicos. Toda escrita usa `manageActorInventory`, idempotência e `expectedInventoryStateVersion`; conflito de versão exige nova leitura antes de tentar outra vez. Conhecer conteúdo não concede posse, e possuir item não cria `ActorContent`.

`GameEvent` registra um fato narrativo da campanha, opcionalmente ligado a um ator. Um evento não cria automaticamente um subsistema de missão, memória, relacionamento ou inventário.

Efeitos ativos usam refs públicas e podem ser consultados por `resolveActorEffect(operation=get)`. `loadGame` traz somente contagem resumida. O uso de consumível reduz/remove a entrada física na mesma transação dos efeitos; conhecer um consumível continua sem conceder posse.

## Uso responsável

Antes de criar, consulte atores e conteúdos existentes. Reutilize definição compatível; não duplique por pequena diferença de nome. Use `code` estável.

Uma publicação canônica exige descrição, `profile`, `presentation`, `tags` e `status`. O perfil fechado é validado pelo backend `core-v1`; não envie `mechanics`, `requirements`, schema arbitrário, dano final ou derivados como JSON livre. Repetir o mesmo snapshot mantém a versão; mudar conteúdo publicável cria a próxima versão imutável.

Criar conteúdo não o concede ao ator. Aprendizado/concessão conceitual usa `manageActorContent`; posse, remoção e equipamento físico usam `manageActorInventory`. Mudanças só existem após resposta bem-sucedida do backend.

Na criação inicial confirmada, `startGame` pode publicar definições globais ou específicas da Campaign, criar vínculos conceituais e conceder `initialInventory` na mesma transação. Uma definição reutilizada deve ser consultada antes e referenciada sem reenviar sua ficha. Inventário inicial referencia conteúdo físico resolvido e refs de entrada determinísticas; equipamentos são aplicados somente depois de todas as entradas serem concedidas.

Metadados permitem contexto genérico, mas não devem simular campo, tabela, vínculo ou regra automática inexistente. Use evento para fatos duradouros somente quando o contrato de eventos representar a intenção com clareza.
