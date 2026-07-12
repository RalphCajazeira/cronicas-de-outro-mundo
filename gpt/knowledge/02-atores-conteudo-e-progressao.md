# Atores, conteúdo e progressão

## Persistência estruturada atual

`Actor` representa personagem ou figura individual relevante. Possui `code` estável, identidade básica, ficha mecânica, descrição, metadados e estado. Os tipos atuais são `character`, `npc`, `creature`, `companion` e `spirit`.

`ContentDefinition` representa conteúdo reutilizável no mundo ou em uma campanha. Tipos atuais incluem habilidade, magia, arma, armadura, escudo, item, talento, material, classe, raça, localização, facção, modelo de missão, efeito de estado, receita, modelo de criatura e outros.

`ActorContent` liga uma definição a um ator e registra `state`, `rank`, `progress`, `mastery`, `equipped`, `quantity`, `notes` e metadados. Estados de progressão: `locked`, `learning`, `known` e `mastered`.

`GameEvent` registra um fato narrativo da campanha, opcionalmente ligado a um ator. Um evento não cria automaticamente um subsistema de missão, memória, relacionamento ou inventário.

## Uso responsável

Antes de criar, consulte atores e conteúdos existentes. Reutilize definição compatível; não duplique por pequena diferença de nome. Use `code` estável.

Uma definição de conteúdo exige descrição, `mechanics`, `requirements`, `presentation`, `tags`, `schemaVersion` e `status`. Esses objetos JSON são persistidos, mas o backend atual não interpreta toda fórmula possível nem calcula resultados avançados.

Criar conteúdo não o concede ao ator. Aprendizado, concessão, atualização, equipamento, remoção e demais mudanças só existem após resposta bem-sucedida do backend.

Metadados permitem contexto genérico, mas não devem simular campo, tabela, vínculo ou regra automática inexistente. Use evento para fatos duradouros somente quando o contrato de eventos representar a intenção com clareza.
