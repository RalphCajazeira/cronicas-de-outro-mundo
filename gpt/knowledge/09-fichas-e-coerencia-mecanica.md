# Fichas e coerência mecânica

## Ficha autoritativa do ator

A API atual persiste identidade e tipo; espécie, classe, papel e descrição; nível, XP e ouro; aparência, personalidade, metadados e estado. A parte mecânica é composta por exatamente nove atributos primários (`strength`, `vitality`, `agility`, `dexterity`, `intelligence`, `wisdom`, `perception`, `willpower`, `luck`), recursos HP/Mana/SP atuais e um snapshot derivado recomputável. Na criação inicial, a origem narrativa estruturada é preservada em `metadata.origin` sem ser convertida automaticamente em raça ou condição.

Estados atuais: `active`, `inactive`, `defeated`, `dead` e `archived`. Tipos atuais: `character`, `npc`, `creature`, `companion` e `spirit`.

O GPT envia somente `primaryAttributes` na criação. Cada valor deve ser inteiro de 4 a 16 e os nove devem somar 90. O protagonista sempre nasce no nível 1 e XP 0; demais atores aceitam nível 1–20. O backend inicia recursos cheios e devolve `resources.hp|mana|sp` com `current`/`max`, além de `secondaryAttributes`, versão mecânica e ruleset.

## Conteúdo e valores derivados

Habilidades, magias e outros conceitos podem existir como `ContentDefinition` e vínculo `ActorContent`. Posse física usa inventário separado; `equipped` é derivado dos slots ocupados e nunca pertence ao vínculo conceitual.

Uma espécie nominal usa `species`. Conteúdo `race` só é criado quando houver regra mecânica real. Condições canônicas usam `status_effect` e duração/stacking allowlisted no perfil. O núcleo puro consegue criar e evoluir estados ativos conceituais, mas eles ainda não são persistidos no ator e permanecem normalmente não equipados.

O backend calcula máximos, poderes do ator, defesas, precisão, evasão, velocidades, crítico, movimento, capacidade, resistências e regenerações pelo `core-v1`. O GPT nunca envia esses resultados como autoridade. Modificadores de um item são aplicados ao snapshot somente enquanto sua instância estiver equipada; itens apenas carregados, reservados, consumidos ou destruídos não contribuem.

Peso e equipamento alteram `mechanicsStateVersion`, recompõem o snapshot e podem mudar encumbrance. Itens multisslot contam uma vez; remover ou mudar lifecycle de uma entrada equipada é rejeitado até o unequip explícito.

## Coerência

Interprete valores confirmados de modo coerente com espécie, classe, experiência, condição e contexto. Campos omitidos preservam o estado apenas conforme o contrato da operação; nunca substitua ficha conhecida por padrão genérico.

Mudanças permanentes só existem após confirmação. `updateActor` é narrativo e não altera nível, XP, atributos, recursos ou derivados. Ainda não há operação pública/persistida de dano, cura, gasto, regeneração aplicada ou progressão mecânica; não declare esses estados como alterados depois de uma resolução conceitual, falha ou mera inferência narrativa.
