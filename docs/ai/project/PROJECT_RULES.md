# Regras Específicas — Game-GPT / Crônicas de Outro Mundo

Atualizado em: 2026-07-24

Estas regras complementam a governança geral. Elas são específicas do Game-GPT e nunca substituem o estado atual confirmado pelo backend, banco, repositório ou contratos vigentes.

## Autoridade do estado de jogo

- O backend persistido é a fonte oficial para o estado dinâmico do jogo.
- Narrativa, memória do chat e arquivos de contexto não substituem confirmação de persistência.
- Nunca afirmar que personagem, mundo, campanha, conteúdo, vínculo, item, habilidade, missão, NPC ou progresso foi salvo sem retorno atual de sucesso.
- Consultar antes de criar para evitar duplicações.
- Quando o banco tiver sido apagado ou recriado, não restaurar estado por suposição narrativa.

## Idempotência, retry e referências

- Operações críticas devem ser idempotentes.
- Em retry exato, preservar payload, parâmetros e a mesma chave de idempotência, sem alterar silenciosamente a proposta.
- Após sucesso, executar consulta de confirmação quando o contrato exigir.
- IDs, códigos e referências devem ser determinísticos, registrados e validados.
- Não inventar identificadores textuais como substituto de entidades registradas.
- Combate e encontros devem usar referências resolvíveis e conteúdo mecânico compatível.

## Conteúdo e atores

- Classes são identidade narrativa por padrão; não concedem bônus, requisitos ou vantagens automáticas sem regra mecânica aprovada.
- Não usar evolução racial automática como mecânica.
- Habilidades passivas devem usar consumo zero quando o contrato exigir esse campo.
- Habilidades, magias e itens devem preencher os campos necessários para validar custo, efeito, requisitos e apresentação.
- NPCs, criaturas, inimigos e companheiros importantes devem possuir atributos, recursos e conteúdo mecânico coerentes quando participarem de sistemas persistentes.
- Posse física, conhecimento de conteúdo e progressão não devem ser tratados como a mesma coisa.

## Continuidade narrativa

- `loadGame` confirma estado mecânico, mas não garante o ponto narrativo exato enquanto não houver checkpoint ou resumo narrativo persistido.
- Sem checkpoint confirmado, não inventar continuidade.
- O jogador controla falas, pensamentos e decisões importantes do protagonista.
- O narrador não deve escolher automaticamente pelo personagem.
- Em modo aventura, apresentar a cena, consequências confirmadas e aguardar a ação do jogador.
- Em configuração ou criação, fazer perguntas em etapas curtas e preferencialmente uma por vez.

## Autonomia e GPT Actions

- As 20 operações atuais do OpenAPI são rotinas escopadas do jogo ou leituras e declaram explicitamente `x-openai-isConsequential: false`.
- Esse flag controla o cartão de aprovação da plataforma; não amplia autoridade nem substitui autenticação, escopo, schemas fechados, idempotência, versões otimistas, locks, transações ou cálculo autoritativo do backend.
- Depois de uma intenção clara, encadear etapas técnicas rotineiras sem confirmações textuais redundantes e reutilizar o estado retornado pela operação anterior.
- Manter confirmação conversacional para exclusão, morte ou perda permanente, gasto raro ou irreversível, mudança importante de conceito, tema sensível e descarte relevante de progresso.
- Corrigir uma vez um payload acionável com nova chave quando a intenção não mudar. Repetir payload e chave idênticos somente para replay ou falha transitória autorizada.
- Nunca fazer retry automático de `UNAUTHORIZED`, `NOT_FOUND`, conflito de versão, erro de integridade ou input ainda inválido.

## Encontros e resolução por beat

- `manageEncounter` é a única Action pública de encontros; o fluxo granular continua disponível como fallback.
- Preferir `resolve_beat` para uma decisão significativa, usando somente ações, custos, alvos e bloqueios projetados pela cápsula autoritativa da cena.
- O GPT envia intenção, plano curto ou política permitida; o backend gera rolls, valida autoridade, calcula resultados, persiste o checkpoint e deriva a terminalidade.
- Parada técnica por orçamento pode continuar com nova versão e nova chave. Parada de decisão devolve o controle ao jogador.
- Fuga é executada em etapas legais de zona; `out_of_range` não remove o participante nem implica derrota, morte ou consequência terminal.
- `wait` e ações genéricas derivadas são temporais e não produzem dano ou efeito mecânico sem profile autoritativo.
- Resolução automática não concede morte, XP, ouro, loot, recompensa ou perda permanente fora das fases que implementarem explicitamente essas consequências.

## Interface narrativa

Quando adequado:

- usar título e emojis moderados;
- mostrar status relevante do personagem;
- oferecer quatro opções numeradas e uma quinta opção livre;
- informar dano, vida, mana, custos, loot e mudanças de estado somente quando confirmados;
- não comentar instruções do Ralph entre colchetes, salvo impossibilidade, ambiguidade relevante ou conflito de regra.

## Incidentes que viraram regra

### Passo da Brisa

Um vínculo foi tratado narrativamente como persistido sem confirmação suficiente. Usar exclusivamente o retorno atual da operação ou consulta; não promover `learning` para `known` sem persistência confirmada.

### Identificador de inimigo

O uso de identificador textual inventado causou erro em combate. Usar código ou referência registrada no bestiário e resolvível pelo backend.

### Lyra

Uma criatura espiritual importante foi mantida na narrativa sem persistência concluída. Entidades importantes só são consideradas salvas após retorno de sucesso e devem ter ficha mecânica suficiente antes de participar de sistemas autoritativos.

## Relação com o GPT narrativo

- Instructions, Knowledge e Actions do GPT narrativo `Crônicas de Outro Mundo` são artefatos separados e devem ser atualizados em fase própria.
- Não assumir que o GPT ao vivo está alinhado com `develop` sem auditoria e teste atuais.
- Não publicar configuração parcial nem misturar contratos legados e novos sem consolidação editorial e técnica.
