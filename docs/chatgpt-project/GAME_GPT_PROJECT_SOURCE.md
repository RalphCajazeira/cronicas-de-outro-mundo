# Fonte consolidada do Projeto ChatGPT — Game-GPT

Atualizado em: 2026-07-15

Este documento é uma fonte de contexto para o Projeto `Game-GPT` no ChatGPT. Ele não substitui o código, o banco, o histórico Git, os contratos OpenAPI nem as evidências produzidas durante cada tarefa.

## 1. Identificação

- Produto: RPG narrativo persistente operado por ChatGPT/GPT e backend próprio.
- Nome do repositório: `RalphCajazeira/cronicas-de-outro-mundo`.
- Diretório local principal: `C:\Users\ralph\Desktop\Game_GPT`.
- Branch de integração: `develop`.
- Stack principal: Node.js 22, TypeScript, Express, Prisma, PostgreSQL, Zod, Vitest e Supertest.
- Infraestrutura registrada: Supabase para PostgreSQL remoto e Render para staging.

## 2. Objetivo do produto

Criar um RPG de fantasia persistente em que o ChatGPT conduz a narrativa, mas o backend controla e confirma o estado oficial do jogo.

O sistema deve permitir, progressivamente:

- mundos, campanhas e personagens persistentes;
- inventário, itens e equipamentos;
- habilidades, magias, aprendizado, progresso e maestria;
- NPCs importantes e companheiros;
- relacionamentos;
- missões;
- tempo, clima, coordenadas, distância e viagem;
- encontros e combate determinísticos;
- dano, recursos, efeitos, loot, XP, ouro e progressão;
- continuidade narrativa baseada em checkpoints persistidos;
- interface visual futura para ficha, inventário, habilidades, NPCs, missões e mapa.

## 3. Princípios de produto

- O estado persistido confirmado pelo backend é oficial.
- A narrativa nunca deve inventar persistência.
- Consultar antes de criar evita duplicações.
- IDs, códigos e referências devem ser determinísticos e validados.
- Operações críticas devem ser idempotentes.
- Classes são identidade narrativa por padrão, sem bônus ou requisitos automáticos.
- Não existe evolução racial automática como mecânica desejada.
- Habilidades passivas devem usar consumo zero quando o contrato exigir consumo.
- Conteúdos e vínculos de personagem devem possuir estado suficiente para o backend validar corretamente.
- NPCs, criaturas, companheiros e inimigos importantes devem possuir atributos e conteúdo mecânico quando participarem de sistemas persistentes.

## 4. Preferências narrativas do usuário

- Fantasia medieval de aventura.
- Magia alta e tecnologia pré-industrial.
- Magos, arqueiros e guerreiros.
- Humanos, elfos, anões e goblins.
- Dragões, criaturas espirituais e monstros.
- Tom épico, aventureiro e misterioso.
- Ameaças reais, sem brutalidade gratuita.
- Emojis moderados e bem posicionados.
- Cabeçalho de status do personagem quando útil.
- Quatro opções sugeridas e uma quinta opção livre para o jogador digitar.
- Informar dano, vida e consequências mecânicas quando confirmados.

## 5. Mundo e campanha de teste registrados

- `playerRef`: `ralph`.
- `playerDisplayName`: `Ralph`.
- Mundo: `Mundo Cardinal`.
- `worldRef`: `mundo-cardinal`.
- Campanha: `Crônicas do Primeiro Portal`.
- `campaignRef`: `cronicas-do-primeiro-portal`.
- Protagonista: Ralph, humano aprimorado/reencarnado, ex-engenheiro de software, inteligente, observador e com facilidade para aprender.
- Classe usada como identidade narrativa: Conjurador das Sombras/Mago de combate conforme a proposta vigente, sem bônus mecânicos automáticos.

Esse estado deve ser consultado no backend antes de ser usado como verdade em uma sessão nova, pois bancos de teste já foram apagados ou recriados durante o desenvolvimento.

## 6. Estado técnico consolidado

### 6.1 Base de API e persistência

O backend já possui uma fundação com:

- escopo determinístico por `playerRef`, `worldRef` e `campaignRef`;
- operações de descoberta de mundos e campanhas;
- `startGame` e `loadGame` idempotentes;
- registros de idempotência;
- eventos de jogo;
- definições de conteúdo e vínculos de conteúdo com atores;
- auditoria de requisições;
- contratos OpenAPI e operações protegidas.

### 6.2 Configuração de mundo e campanha

A criação rápida aprovada exige persistência transacional de:

- Player;
- World;
- Campaign;
- protagonista;
- pacotes de conteúdo inicial;
- evento de início da campanha;
- confirmação posterior via `loadGame`.

Configurações ficam em metadata versionada:

- `World.metadata.worldConfig`;
- `Campaign.metadata.campaignConfig`.

O protagonista deve suportar aparência, personalidade, origem, espécie, papel, classe narrativa, vida, mana, atributos, resistências e afinidades.

### 6.3 Fundação mecânica e encontros

Até 2026-07-15, a linha de desenvolvimento do Engine V1 avançou pelas fases de core, persistência e adaptador transacional de encontros.

PRs recentes confirmados:

- PR #23 — `feat(engine): add encounter persistence schema` — integrado em `develop`.
- PR #24 — `feat(engine): add transactional encounter adapter` — integrado em `develop`.

A Fase 1L-A adicionou a fundação persistida de encontros, incluindo entidades de encontro, participantes, operações, rolls, snapshots canônicos, hash e regras de banco.

A Fase 1L-B adicionou o adaptador transacional autoritativo com operações de criação, carregamento, envio de intenção, resolução de reação, continuação, confirmação de conclusão e cancelamento, além de:

- idempotência;
- `expectedStateVersion`;
- locks determinísticos;
- rolls lazy;
- detecção de drift;
- aplicação atômica de recursos, inventário e efeitos.

Validações reportadas no PR #24:

- Prisma validate;
- Prisma generate;
- lint;
- typecheck;
- build;
- 793 testes unitários;
- 112 testes PostgreSQL de integração;
- `git diff --check`.

### 6.4 Itens explicitamente fora da Fase 1L-B

O PR #24 registrou como fora de escopo:

- HTTP/OpenAPI;
- GPT Actions;
- deploy;
- Supabase remoto;
- XP, loot, ouro e progressão;
- consequências finais;
- limpeza de efeitos com escopo de encontro;
- frontend.

Esses itens não devem ser tratados como implementados sem uma fase posterior e evidência própria.

## 7. Incidentes e aprendizados importantes

### Passo da Brisa

Uma resposta narrativa tratou o vínculo como persistido sem confirmação suficiente. A regra atual é consultar e confiar exclusivamente no retorno atual da ferramenta. Retries exatos devem preservar payload e idempotency key quando solicitado.

### startCombat

Houve erro ao usar identificador textual inventado como `bandit_leader`. Combate deve usar referência registrada, código resolvível e conteúdo de bestiário compatível.

### Lyra

A criatura espiritual foi tratada narrativamente como importante, mas o registro persistente encontrou limitações e erros. Entidades importantes não podem ser consideradas salvas sem retorno de sucesso. Criaturas e NPCs que participam mecanicamente devem possuir atributos, recursos e habilidades coerentes.

### Continuidade narrativa

Sem checkpoint narrativo persistido, `loadGame` pode confirmar estado mecânico, mas não necessariamente reconstruir o ponto exato da história. Não inventar continuidade. Explicar essa limitação até existir solução persistente de checkpoint/resumo narrativo.

## 8. Infraestrutura registrada

### Supabase

- Projeto de staging registrado: `cronicas-de-outro-mundo-staging`.
- Região registrada: `sa-east-1`.
- Migrations e seed já foram validados em fases anteriores.
- TLS deve usar verificação completa com CA quando configurado.

Não assumir que migrations mais recentes foram aplicadas remotamente. O PR #24 declarou que a migration associada não foi aplicada em banco remoto.

### Render

- Serviço Free de staging registrado como Live em fases anteriores.
- Houve correção relacionada a dependências de desenvolvimento no build.
- Pre-deploy não estava disponível no plano Free.

Não fazer deploy nem alterar ambiente remoto sem autorização explícita.

## 9. Organização de trabalho Chat + Codex

### ChatGPT

Atua como Engenheiro de Software e líder técnico:

- mantém contexto e roadmap;
- define as tarefas;
- escreve prompts completos;
- audita relatórios e evidências;
- decide aprovação ou correção.

### Codex

Atua como executor:

- investiga o repositório;
- altera código;
- executa validações;
- cria branch, commit, push e PR quando autorizado;
- devolve relatório técnico.

A separação é intencional para preservar limites distintos e impedir que o Codex consuma contexto operacional decidindo o roadmap.

## 10. Regras para auditoria

Antes de aprovar uma tarefa, verificar conforme aplicável:

- escopo e fora de escopo;
- arquivos alterados;
- contratos e compatibilidade;
- migration e reversibilidade;
- lint;
- typecheck;
- testes unitários;
- testes de integração PostgreSQL;
- build;
- `git diff --check`;
- busca de secrets;
- estado limpo da working tree;
- hashes local e remoto;
- base e head do PR;
- ausência de force push;
- ausência de deploy ou alteração remota não autorizada.

Relatórios do Codex são evidências iniciais, não verdade automática. Quando necessário, usar GitHub, banco ou ambiente para verificar.

## 11. Próximas frentes conhecidas

As frentes abaixo permanecem conhecidas, mas a ordem exata deve ser confirmada pelo roadmap vigente e pelo estado real de `develop`:

- expor o adaptador transacional de encontros por service/HTTP/OpenAPI;
- integrar operações de encontro às ferramentas usadas pelo GPT;
- definir consequências finais e limpeza de efeitos de escopo `encounter`;
- implementar XP, loot, ouro e progressão;
- consolidar bestiário e referências de inimigos;
- fortalecer persistência de NPCs, criaturas e companheiros;
- persistir checkpoints ou resumos narrativos para continuidade;
- ampliar inventário, missões, relacionamentos, tempo, clima, localização e viagem;
- criar interface visual futura por ChatGPT App/MCP ou frontend complementar.

Não iniciar uma dessas frentes apenas por constar nesta lista. Cada fase precisa de prompt específico, escopo aprovado e condições de aceite próprias.

## 12. Manutenção desta fonte

Atualizar este documento quando ocorrer uma destas mudanças:

- merge de fase relevante;
- alteração de arquitetura;
- mudança de contrato OpenAPI;
- migration importante;
- alteração de infraestrutura;
- mudança de regras do produto;
- mudança de roadmap;
- descoberta de incidente que afete decisões futuras.

Ao atualizar, registrar a data e distinguir claramente:

- estado confirmado;
- informação histórica;
- plano futuro;
- hipótese ainda não validada.
