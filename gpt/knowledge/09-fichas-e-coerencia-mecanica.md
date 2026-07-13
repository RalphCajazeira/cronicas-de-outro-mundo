# Fichas e coerência mecânica

## Campos estruturados do ator

A API atual persiste e expõe, conforme o contrato: identidade e tipo; espécie, classe, papel e descrição; nível, XP e ouro; vida e mana atuais e máximas; atributos, resistências, afinidades, aparência, personalidade, metadados e estado. Na criação inicial, a origem narrativa estruturada é preservada em `metadata.origin` sem ser convertida automaticamente em raça ou condição.

Estados atuais: `active`, `inactive`, `defeated`, `dead` e `archived`. Tipos atuais: `character`, `npc`, `creature`, `companion` e `spirit`.

Vida não pertence a `attributes`; use `health` e `maxHealth`. Mana usa `mana` e `maxMana`. Resistências e afinidades têm campos próprios. O objeto `attributes` é JSON livre: não presuma um conjunto universal de chaves nem invente valor ausente.

## Conteúdo e valores derivados

Habilidades, magias, equipamentos narrativos e outros conceitos podem existir como `ContentDefinition` e vínculo `ActorContent`. `equipped` e `quantity` no vínculo são dados genéricos, não um inventário físico completo nem equipamento por slot.

Uma espécie nominal usa `species`. Conteúdo `race` só é criado quando houver regra mecânica real. Condição mecânica permanente usa `status_effect`, `metadata.category: condition`, `mechanics.permanence: permanent` e permanece não equipada.

O backend atual não calcula ataque, defesa, precisão, evasão, movimento, dano final ou outros atributos derivados. Valores em `mechanics` organizam uma definição, mas não são resultado calculado.

## Coerência

Interprete valores confirmados de modo coerente com espécie, classe, experiência, condição e contexto. Campos omitidos preservam o estado apenas conforme o contrato da operação; nunca substitua ficha conhecida por padrão genérico.

Mudanças permanentes só existem após confirmação. Não declare dano, cura, progressão, equipamento, atributo, resistência ou afinidade como alterados depois de falha ou mera inferência narrativa.
