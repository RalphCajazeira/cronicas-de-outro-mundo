# Limites mecânicos atuais

## O que existe

O backend persiste mundos, campanhas, atores, os nove atributos primários, HP/Mana/SP atuais, snapshot derivado, definições de conteúdo, vínculos entre atores e conteúdo e eventos narrativos. Ele valida o contrato e a idempotência das escritas atuais e calcula máximos/derivados pelo ruleset `core-v1`.

O validador puro de fichas canônicas está ligado ao contrato e à persistência versionada. Ele reconhece tier, raridade, dano físico/mágico separado, custos explícitos, perfis temporais, targeting, duração, efeitos, stacking, modificadores e requisitos. Uma resposta bem-sucedida de publicação confirma validação estrutural e cria ou reutiliza uma versão; ela não aplica efeitos ao ator, resolve combate ou gasta recursos.

## O que permanece adiado

Não existem de forma estruturada nesta fase:

- resolução/aplicação de combate, dano, cura, gasto de recursos ou efeitos temporários;
- inventário físico por instância, durabilidade, equipamento por slot ou loot;
- economia, comércio, lojas, estoque ou transações;
- missões e relacionamentos especializados;
- memórias de atores ou Codex especializado;
- relógio, clima, coordenadas, rotas ou viagens persistentes;
- checkpoints e recuperação especializada de campanha;
- modificadores persistidos de equipamento, buffs ou debuffs.

Não apresente esses sistemas como implementados e não invente persistência para eles.

## Como narrar dentro dos limites

Combate pode incluir intenção, risco, vantagem narrativa, fuga, rendição, medo e consequência ficcional. A ficha contém precisão, defesas, crítico e demais derivados oficiais, mas ainda não existe operação que resolva uma ação ou aplique seus efeitos. Loot narrativo ainda não é inventário persistente.

Itens, lojas, clima e viagens podem aparecer na história com coerência, descrição e continuidade. Uma `ContentDefinition` pode representar o conceito de um item, local ou facção, e `ActorContent` pode representar vínculo genérico suportado, mas isso não cria estoque, propriedade física detalhada, distância, preço ou viagem automática.

Quando a história precisar preservar um fato compatível com o contrato, use a capacidade estruturada ou genérica adequada. Caso contrário, trate-o explicitamente como regra narrativa ou sistema futuro.

O evento técnico `campaign-started` registra apenas um resumo funcional allowlisted da criação confirmada, com payload limitado. Ele não é checkpoint, snapshot narrativo, inventário ou memória especializada, e sua idempotência não é uma segunda chave pública separada da operação `startGame`.
