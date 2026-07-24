# Fonte do Projeto — Game-GPT / Crônicas de Outro Mundo

Atualizado em: 2026-07-24

Este arquivo complementa as fontes gerais do repositório `Projetos_Gpt`. Ele descreve somente o produto, o domínio e as preferências próprias do Game-GPT. Estado técnico mutável fica em `CURRENT_STATE.md`; tarefas futuras ficam em `ROADMAP.md`.

## Identificação

- Produto: RPG narrativo persistente conduzido pelo ChatGPT com backend próprio e autoritativo.
- Repositório da aplicação: `RalphCajazeira/cronicas-de-outro-mundo`.
- Diretório local principal: `C:\Users\ralph\Desktop\Game_GPT`.
- Branch de integração: `develop`.
- Projeto técnico no ChatGPT: `Game_GPT`.
- GPT narrativo de staging: `Crônicas de Outro Mundo — Staging`.

## Objetivo do produto

Criar uma experiência de RPG de fantasia em que o ChatGPT conduz narrativa, personagens e escolhas, enquanto o backend registra e confirma o estado oficial do mundo, campanha, atores, conteúdo e sistemas mecânicos.

O produto deve evoluir para suportar de forma persistente e verificável:

- mundos, campanhas e protagonistas;
- atributos, vida, mana, resistências e afinidades;
- habilidades, magias, aprendizado, progresso e maestria;
- inventário, itens, equipamentos, peso e consumíveis;
- NPCs importantes, criaturas, inimigos e companheiros;
- relacionamentos e missões;
- encontros e combate determinísticos;
- recursos, custos, dano, cura, efeitos e estados ativos;
- loot, XP, ouro, recompensas e progressão;
- tempo, clima, localização, coordenadas, distância e viagem;
- checkpoints ou resumos narrativos persistidos;
- interface visual futura para ficha, inventário, habilidades, missões, NPCs e mapa.

## Direção narrativa preferida

- fantasia medieval de aventura;
- magia alta;
- tecnologia pré-industrial;
- magos, arqueiros e guerreiros;
- humanos, elfos, anões e goblins;
- dragões, criaturas espirituais e monstros;
- tom épico, aventureiro e misterioso;
- ameaças e consequências reais, sem brutalidade gratuita;
- emojis moderados e bem posicionados;
- cabeçalho de status do personagem quando útil;
- quatro opções sugeridas e uma quinta opção livre para o jogador escrever;
- informar dano, vida, custos e consequências mecânicas quando estiverem confirmados.

## Configuração de teste conhecida

Esses dados identificam o cenário de teste mais usado, mas devem ser consultados no backend antes de serem tratados como estado existente:

- `playerRef`: `ralph`;
- `playerDisplayName`: `Ralph`;
- mundo: `Mundo Cardinal`;
- `worldRef`: `mundo-cardinal`;
- campanha: `Crônicas do Primeiro Portal`;
- `campaignRef`: `cronicas-do-primeiro-portal`;
- protagonista: Ralph, humano aprimorado e reencarnado, ex-engenheiro de software, inteligente, observador e com facilidade para aprender;
- classe narrativa usada nas propostas: Conjurador das Sombras ou Mago de Combate, sem bônus mecânico automático.

Bancos de teste já foram apagados ou recriados. A existência atual desse mundo, campanha ou personagem nunca deve ser inferida apenas por este documento.

## Limites desta fonte

Este arquivo não substitui banco de dados, resposta atual do backend, contratos OpenAPI, código, migrations, estado da branch `develop`, testes atuais ou fontes de Knowledge do GPT narrativo.

Quando houver divergência, prevalece o estado atual confirmado conforme a hierarquia definida nas fontes gerais.
