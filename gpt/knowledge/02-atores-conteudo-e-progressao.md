# Atores, conteúdo e progressão

## Persistência estruturada atual

`Actor` representa personagem ou figura individual relevante. Possui `code` estável, identidade básica, descrição, metadados, estado e ficha mecânica autoritativa calculada pelo backend. Os tipos atuais são `character`, `npc`, `creature`, `companion` e `spirit`.

A ficha pública contém nove `primaryAttributes`, recursos atuais/máximos de HP, Mana e SP, `secondaryAttributes`, `mechanicsStateVersion` e ruleset. O GPT propõe os atributos iniciais e, para NPC/criatura, nível 1–20; não propõe máximos nem derivados. Recursos começam cheios. O backend já possui resolução conceitual pura de gasto, cura e dano, mas ainda não existe operação pública ou persistência desses resultados.

`ContentDefinition` representa a identidade estável de conteúdo reutilizável no mundo ou em uma campanha. Nome, descrição, perfil, apresentação, tags e metadados pertencem a uma `ContentVersion` imutável. Os 13 tipos canônicos são arma, armadura, escudo, roupa, magia, habilidade, talento, item, consumível, efeito de estado, raça, classe e modelo de criatura. Material, localização, facção, modelo de missão, receita e outros continuam narrativos genéricos, sem perfil mecânico.

`ActorContent` liga uma definição e uma versão específica a um ator e registra somente `state`, `rank`, `progress`, `mastery`, `notes` e metadados. Estados de progressão: `locked`, `learning`, `known` e `mastered`. Uma nova publicação não migra silenciosamente vínculos antigos.

O inventário físico é separado: entradas são instâncias ou stacks fixados em versões exatas, e equipamento é derivado de slots físicos. Toda escrita usa `manageActorInventory`, idempotência e `expectedInventoryStateVersion`; conflito de versão exige nova leitura antes de tentar outra vez. Conhecer conteúdo não concede posse, e possuir item não cria `ActorContent`.

`GameEvent` registra um fato narrativo da campanha, opcionalmente ligado a um ator. Um evento não cria automaticamente um subsistema de missão, memória, relacionamento ou inventário.

## Uso responsável

Antes de criar, consulte atores e conteúdos existentes. Reutilize definição compatível; não duplique por pequena diferença de nome. Use `code` estável.

Uma publicação canônica exige descrição, `profile`, `presentation`, `tags` e `status`. O perfil fechado é validado pelo backend `core-v1`; não envie `mechanics`, `requirements`, schema arbitrário, dano final ou derivados como JSON livre. Repetir o mesmo snapshot mantém a versão; mudar conteúdo publicável cria a próxima versão imutável.

Criar conteúdo não o concede ao ator. Aprendizado/concessão conceitual usa `manageActorContent`; posse, remoção e equipamento físico usam `manageActorInventory`. Mudanças só existem após resposta bem-sucedida do backend.

Na criação inicial confirmada, `startGame` pode publicar definições globais ou específicas da Campaign, criar vínculos conceituais e conceder `initialInventory` na mesma transação. Uma definição reutilizada deve ser consultada antes e referenciada sem reenviar sua ficha. Inventário inicial referencia conteúdo físico resolvido e refs de entrada determinísticas; equipamentos são aplicados somente depois de todas as entradas serem concedidas.

Metadados permitem contexto genérico, mas não devem simular campo, tabela, vínculo ou regra automática inexistente. Use evento para fatos duradouros somente quando o contrato de eventos representar a intenção com clareza.
