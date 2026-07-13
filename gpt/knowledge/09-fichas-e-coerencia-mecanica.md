# Fichas e coerência mecânica

## Ficha autoritativa do ator

A API atual persiste identidade e tipo; espécie, classe, papel e descrição; nível, XP e ouro; aparência, personalidade, metadados e estado. A parte mecânica é composta por exatamente nove atributos primários (`strength`, `vitality`, `agility`, `dexterity`, `intelligence`, `wisdom`, `perception`, `willpower`, `luck`), recursos HP/Mana/SP atuais e um snapshot derivado recomputável. Na criação inicial, a origem narrativa estruturada é preservada em `metadata.origin` sem ser convertida automaticamente em raça ou condição.

Estados atuais: `active`, `inactive`, `defeated`, `dead` e `archived`. Tipos atuais: `character`, `npc`, `creature`, `companion` e `spirit`.

O GPT envia somente `primaryAttributes` na criação. Cada valor deve ser inteiro de 4 a 16 e os nove devem somar 90. O protagonista sempre nasce no nível 1 e XP 0; demais atores aceitam nível 1–20. O backend inicia recursos cheios e devolve `resources.hp|mana|sp` com `current`/`max`, além de `secondaryAttributes`, versão mecânica e ruleset.

## Conteúdo e valores derivados

Habilidades, magias, equipamentos narrativos e outros conceitos podem existir como `ContentDefinition` e vínculo `ActorContent`. `equipped` e `quantity` no vínculo são dados genéricos, não um inventário físico completo nem equipamento por slot.

Uma espécie nominal usa `species`. Conteúdo `race` só é criado quando houver regra mecânica real. Condições canônicas usam `status_effect` e duração/stacking allowlisted no perfil; elas não são estado ativo aplicado ao ator nesta fase e permanecem normalmente não equipadas.

O backend calcula máximos, poderes do ator, defesas, precisão, evasão, velocidades, crítico, movimento, capacidade, resistências e regenerações pelo `core-v1`. O GPT nunca envia esses resultados como autoridade. Modificadores de um `ContentVersion.profile` são validados e persistidos, mas ainda não são aplicados ao snapshot do ator nesta fase.

## Coerência

Interprete valores confirmados de modo coerente com espécie, classe, experiência, condição e contexto. Campos omitidos preservam o estado apenas conforme o contrato da operação; nunca substitua ficha conhecida por padrão genérico.

Mudanças permanentes só existem após confirmação. `updateActor` é narrativo e não altera nível, XP, atributos, recursos ou derivados. Ainda não há operação de dano, cura, gasto, regeneração aplicada ou progressão mecânica; não declare esses estados como alterados depois de falha ou mera inferência narrativa.
