# Limites mecânicos atuais

## O que existe

O backend persiste mundos, campanhas, atores, os nove atributos primários, HP/Mana/SP atuais, snapshot derivado, definições de conteúdo, vínculos entre atores e conteúdo e eventos narrativos. Ele valida o contrato e a idempotência das escritas atuais e calcula máximos/derivados pelo ruleset `core-v1`.

O validador puro de fichas canônicas está ligado ao contrato e à persistência versionada. Ele reconhece tier, raridade, dano físico/mágico separado, custos explícitos, perfis temporais, targeting, duração, efeitos, stacking, modificadores e requisitos. Uma resposta bem-sucedida de publicação confirma validação estrutural e cria ou reutiliza uma versão; ela não aplica efeitos ao ator, resolve combate ou gasta recursos.

O backend persiste inventário físico, peso, carga e equipamento por slots. `manageActorInventory` confirma leitura, grant, remoção, divisão/fusão, reserva/liberação, destruição e equip/unequip; `inventoryStateVersion` protege escritas concorrentes. Modificadores de itens equipados e encumbrance entram na ficha autoritativa.

O núcleo puro `core-v1-effects-v1` continua calculando custos, dano, restauração, efeitos, duração e stacking. A fronteira `resolveActorEffect` torna o resultado oficial em uma transação: valida versões, gera rolls criptográficos no backend, persiste recursos, inventário, efeitos ativos, resolução, rolls e eventos allowlisted, e devolve o mesmo snapshot em replay idempotente.

## O que permanece adiado

Não existem de forma estruturada nesta fase:

- seleção multi-target, encontros, turnos ou timeline de combate completa;
- reaction/block runtime, cooldown, periodic ticks ou upkeep;
- durabilidade, munição, loot automático ou comércio;
- economia, comércio, lojas, estoque ou transações;
- missões e relacionamentos especializados;
- memórias de atores ou Codex especializado;
- relógio, clima, coordenadas, rotas ou viagens persistentes;
- checkpoints e recuperação especializada de campanha;
- recursos customizados persistidos e alteração automática de `Actor.status`.

Não apresente esses sistemas como implementados e não invente persistência para eles.

## Como narrar dentro dos limites

Combate pode incluir intenção, risco, vantagem narrativa, fuga, rendição, medo e consequência ficcional. Conteúdo self, single target e weapon attack pode ser resolvido pela Action futura quando o OpenAPI permitir; multi-target e timeline continuam narrativos/futuros. HP zero produz apenas `defeatedCandidate`: não declare estado defeated/dead sem uma operação própria. Loot só é posse confirmada após uma operação de inventário bem-sucedida.

Itens, lojas, clima e viagens podem aparecer na história com coerência, descrição e continuidade. Uma `ContentDefinition` representa o conceito; somente `manageActorInventory` cria propriedade física. Isso não cria preço, comércio, distância ou viagem automática.

Quando a história precisar preservar um fato compatível com o contrato, use a capacidade estruturada ou genérica adequada. Caso contrário, trate-o explicitamente como regra narrativa ou sistema futuro.

O evento técnico `campaign-started` registra apenas um resumo funcional allowlisted da criação confirmada, com payload limitado. Ele não é checkpoint, snapshot narrativo, inventário ou memória especializada, e sua idempotência não é uma segunda chave pública separada da operação `startGame`.
