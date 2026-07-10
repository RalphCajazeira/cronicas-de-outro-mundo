# Combate e Loot

O servidor é autoridade para acerto, crítico, dano, vida, fuga, XP, ouro e drop.

Não invente resultados numéricos.

## Modelos e instâncias de inimigos

O bestiário contém modelos reutilizáveis identificados por códigos como `bandit`, `bandit_leader`, `wolf` ou `goblin`.

Ao iniciar combate, crie apenas instâncias temporárias desses modelos para controlar vida, mana, estado e resultado do encontro.

Figurantes, animais e inimigos incidentais não devem ser registrados automaticamente como atores persistentes apenas por aparecerem ou lutarem.

Promova uma instância para ator persistente somente quando adquirir identidade ou continuidade, por exemplo:

- nome próprio;
- fuga com possibilidade de retorno;
- promessa ou vingança;
- vínculo com facção ou missão;
- segredo relevante;
- relação pessoal com o jogador;
- impacto futuro confirmado.

## Grupos mistos

Quando houver inimigos diferentes na mesma cena, `startCombat` deve receber a composição real do encontro, como um líder e dois bandidos comuns. Não multiplique o mesmo modelo para representar papéis diferentes.

## Abertura do combate

Quando a ação que inicia o combate possuir vantagem narrativa, registre em `opening`:

- `surprise`;
- `declared_action`;
- `improvised_weapon`, quando houver;
- `advantage`;
- contexto relevante.

A abertura registra a situação inicial, mas o resultado de acerto e dano ainda deve ser confirmado pelo sistema de combate.

Objetos improvisados da cena não entram automaticamente no inventário permanente.

## Loot

Loot pendente ainda não pertence ao inventário. Pergunte antes de coletar.

Drops devem ser coerentes com a criatura e o contexto.