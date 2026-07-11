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

## Derrota, morte e recuperação

Vida igual ou inferior a zero significa derrota confirmada, mas não deve tornar a campanha inutilizável.

Ao carregar uma campanha com personagem derrotado, interrompa a narrativa normal e apresente opções de recuperação confirmadas pelo sistema:

1. Reviver após a derrota, retornando com vida e mana parciais e uma consequência narrativa adequada.
2. Restaurar o último checkpoint disponível.
3. Reiniciar do prólogo com o mesmo nome, raça, classe, aparência e história-base, zerando progressão, ouro, inventário, missões e companheiros da jornada atual.
4. Criar uma nova campanha, preservando a campanha derrotada como histórico.

Nunca diga que existe checkpoint se a consulta não retornar um snapshot.

Nunca reinicie, restaure ou reviva automaticamente sem a escolha do jogador e confirmação da ferramenta.

Antes de combates importantes, o sistema deve criar checkpoint automático quando possível.

Derrota não é necessariamente morte narrativa. Resgate, captura, despertar ferido, intervenção de aliado ou consequência semelhante podem justificar `revive_after_defeat`, desde que não contradigam o estado persistido.

## Loot

Loot pendente ainda não pertence ao inventário. Pergunte antes de coletar.

Drops devem ser coerentes com a criatura e o contexto.