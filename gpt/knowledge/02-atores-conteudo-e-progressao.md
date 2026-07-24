# Atores, conteúdo e progressão

## Persistência estruturada atual

`Actor` representa personagem ou figura individual relevante. Possui `code` estável, identidade básica, descrição, metadados, estado e ficha mecânica autoritativa calculada pelo backend. Os tipos atuais são `character`, `npc`, `creature`, `companion` e `spirit`.

A ficha pública contém nove `primaryAttributes`, recursos atuais/máximos de HP, Mana e SP com `stateVersion`, `secondaryAttributes`, versões de mecânica/inventário/efeitos e ruleset. Na criação, `primaryAttributes` é sempre a base do nível 1: nove valores de 4–16 somando 90. Atores não protagonistas podem nascer em qualquer nível inteiro positivo aceito pela revisão e usar `progressionPrimaryAttributes` para ganhos já distribuídos; pontos omitidos permanecem disponíveis. Não há nível máximo de gameplay nem cap efetivo fixo na revisão atual. O backend não recebe máximos nem derivados. Recursos começam cheios.

`manageActorProgression` é a operação oficial para consultar e alterar nível, XP e atributos. `get` retorna base, ganhos, efetivos, direito ganho/alocado/disponível, próxima exigência de XP, `canLevelUp` e `mechanicsStateVersion`. Cada nível após o primeiro concede 10 pontos: direito total = `90 + 10 × (level - 1)`; saldo = `10 × (level - 1) - soma dos ganhos`. O limite de 4–16 vale somente para a base; a revisão atual não limita o efetivo por um teto fixo.

`grant_xp` registra XP com motivo e identidade `source.type/ref`; a mesma fonte não duplica recompensa ao ator nem com outra idempotencyKey. `level_up` consome a exigência oficial também acima do nível 20, preserva excedente, não cura e deixa os novos pontos disponíveis; `allocate_attributes` aceita somente deltas dos nove atributos; `set_progression_state` corrige nível, XP, base ou ganhos com motivo auditável. Escritas são idempotentes, usam `expectedMechanicsStateVersion`, recalculam snapshot/derivados e são bloqueadas para participante de encontro ativo. `updateActor` continua exclusivamente narrativo.

RC1.1 permanece uma publicação histórica limitada a nível 20 e atributo efetivo 30. Campanhas e mundos já pinados nela não mudam de revisão nem criam campanhas RC1.2 automaticamente; novos mundos usam RC1.2. Usar RC1.2 em escopo antigo exige recriação autorizada ou uma operação explícita futura, nunca migração silenciosa.

`ContentDefinition` representa a identidade estável de conteúdo reutilizável no mundo ou em uma campanha. Nome, descrição, perfil, apresentação, tags e metadados pertencem a uma `ContentVersion` imutável. Os 13 tipos canônicos são arma, armadura, escudo, roupa, magia, habilidade, talento, item, consumível, efeito de estado, raça, classe e modelo de criatura. Material, localização, facção, modelo de missão, receita e outros continuam narrativos genéricos, sem perfil mecânico.

Efeitos `apply_status` e `remove_status` são vinculados na publicação a uma versão exata de `status_effect`. Publicar v2 do status não altera uma magia v1; somente nova versão da fonte pode fixar a versão nova.

`ActorContent` liga uma definição e uma versão específica a um ator e registra somente `state`, `rank`, `progress`, `mastery`, `notes` e metadados. Estados de progressão: `locked`, `learning`, `known` e `mastered`. Uma nova publicação não migra silenciosamente vínculos antigos.

O inventário físico é separado: entradas são instâncias ou stacks fixados em versões exatas, e equipamento é derivado de slots físicos. Toda escrita usa `manageActorInventory`, idempotência e `expectedInventoryStateVersion`; conflito de versão exige nova leitura antes de tentar outra vez. Conhecer conteúdo não concede posse, e possuir item não cria `ActorContent`.

`GameEvent` registra um fato narrativo da campanha, opcionalmente ligado a um ator. Um evento não cria automaticamente um subsistema de missão, memória, relacionamento ou inventário.

Efeitos ativos usam refs públicas e podem ser consultados por `resolveActorEffect(operation=get)`. `loadGame` traz somente contagem resumida. O uso de consumível reduz/remove a entrada física na mesma transação dos efeitos; conhecer um consumível continua sem conceder posse.

Encontros novos vinculam somente atores `active` com HP positivo já existentes na Campaign. Suas respostas projetam HP/Mana/SP e indicam o próximo passo autoritativo em `nextRequiredAction`. Ao confirmar conclusão ou cancelamento, o backend deriva o outcome, marca participantes persistidos `active` com HP zero como `defeated`, remove apenas efeitos `scope=encounter` pertencentes àquele encontro e devolve `consequencesSummary`. Isso não concede XP, level-up, ouro, loot, morte ou recompensa material.

`defeated` não significa `dead`. Cura oficial que eleva HP de zero para valor positivo reativa somente um ator `defeated`; narrativa, tempo ou encerramento não reativam ninguém. Outros estados são preservados.

## Uso responsável

Antes de criar, consulte atores e conteúdos existentes. Reutilize definição compatível; não duplique por pequena diferença de nome. Use `code` estável.

Uma publicação canônica exige descrição, `profile`, `presentation`, `tags` e `status`. O perfil fechado é validado pelo backend `core-v1`; não envie `mechanics`, `requirements`, schema arbitrário, dano final ou derivados como JSON livre. Repetir o mesmo snapshot mantém a versão; mudar conteúdo publicável cria a próxima versão imutável.

Criar conteúdo não o concede ao ator. Aprendizado/concessão conceitual usa `manageActorContent`; posse, remoção e equipamento físico usam `manageActorInventory`. Mudanças só existem após resposta bem-sucedida do backend.

Na criação inicial confirmada, `startGame` pode publicar definições globais ou específicas da Campaign, criar vínculos conceituais e conceder `initialInventory` na mesma transação. Uma definição reutilizada deve ser consultada antes e referenciada sem reenviar sua ficha. Inventário inicial referencia conteúdo físico resolvido e refs de entrada determinísticas; equipamentos são aplicados somente depois de todas as entradas serem concedidas.

Metadados permitem contexto genérico, mas nunca armazenam nível real, XP, atributos extras, saldo de pontos, progressão ou correções de ficha. Use as operações mecânicas oficiais. Use evento para fatos duradouros somente quando o contrato de eventos representar a intenção com clareza.
