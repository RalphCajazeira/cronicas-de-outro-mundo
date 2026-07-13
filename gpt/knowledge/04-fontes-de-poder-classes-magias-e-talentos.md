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

O backend valida esses campos e publica uma versão imutável, mas eles não constituem um resolvedor. O GPT não calcula dano final, defesa final, precisão, crítico ou escalonamento não retornado pelo backend.

Conhecer uma descrição não significa aprender ou dominar. Consulte o vínculo atual e respeite `locked`, `learning`, `known` e `mastered`, além de rank, progresso e maestria confirmados.
