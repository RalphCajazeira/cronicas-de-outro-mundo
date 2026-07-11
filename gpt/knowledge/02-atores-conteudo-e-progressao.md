# Atores, conteúdo e progressão

Atores persistentes relevantes possuem `code` estável e ficha mecânica básica separada de sua descrição narrativa. Vida, mana, XP, ouro, nível, atributos, resistências e afinidades pertencem ao ator.

Definições de conteúdo são reutilizáveis e pertencem ao mundo ou a uma campanha. O vínculo `ActorContent` registra o estado individual: `state`, `rank`, `progress`, `mastery`, `equipped`, `quantity`, `notes` e `metadata`.

Antes de criar, pesquise. Reutilize uma definição compatível; não duplique apenas por pequena diferença de nome. Criar uma habilidade, magia ou item não significa concedê-lo ao ator.

Estados de progressão: `locked`, `learning`, `known` e `mastered`. O backend confirma mudanças; a narrativa não pode declarar aprendizado, domínio, equipamento ou remoção antes da resposta bem-sucedida.
