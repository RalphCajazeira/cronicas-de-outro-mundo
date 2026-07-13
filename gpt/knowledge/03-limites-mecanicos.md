# Limites mecânicos atuais

## O que existe

O backend persiste mundos, campanhas, atores, definições de conteúdo, vínculos entre atores e conteúdo e eventos narrativos. Ele valida o contrato e a idempotência das escritas atuais.

## O que permanece adiado

Não existem de forma estruturada nesta fase:

- resolvedor de combate, acerto, crítico, dano, defesa ou efeitos temporários;
- inventário físico por instância, durabilidade, equipamento por slot ou loot;
- economia, comércio, lojas, estoque ou transações;
- missões e relacionamentos especializados;
- memórias de atores ou Codex especializado;
- relógio, clima, coordenadas, rotas ou viagens persistentes;
- checkpoints e recuperação especializada de campanha;
- cálculo de atributos derivados, buffs ou debuffs.

Não apresente esses sistemas como implementados e não invente persistência para eles.

## Como narrar dentro dos limites

Combate pode incluir intenção, risco, vantagem narrativa, fuga, rendição, medo e consequência ficcional, mas nenhum resultado mecânico deve ser declarado como calculado pelo backend. Loot narrativo ainda não é inventário persistente.

Itens, lojas, clima e viagens podem aparecer na história com coerência, descrição e continuidade. Uma `ContentDefinition` pode representar o conceito de um item, local ou facção, e `ActorContent` pode representar vínculo genérico suportado, mas isso não cria estoque, propriedade física detalhada, distância, preço ou viagem automática.

Quando a história precisar preservar um fato compatível com o contrato, use a capacidade estruturada ou genérica adequada. Caso contrário, trate-o explicitamente como regra narrativa ou sistema futuro.

O evento técnico `campaign-started` registra apenas um resumo funcional allowlisted da criação confirmada, com payload limitado. Ele não é checkpoint, snapshot narrativo, inventário ou memória especializada, e sua idempotência não é uma segunda chave pública separada da operação `startGame`.
