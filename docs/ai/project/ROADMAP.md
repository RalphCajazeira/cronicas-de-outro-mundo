# Roadmap Executável do Projeto

**Atualizado em:** 2026-07-27  
**Branch de integração:** `develop`

## 1. Objetivo imediato

Colocar o jogo em teste manual real pela extensão, com entregas verticais pequenas e correções rápidas baseadas no uso.

```text
fundação da extensão
→ OAuth
→ leitura real
→ atualização automática
→ primeira ação real
→ testar
→ corrigir
→ ampliar jogabilidade
```

## 2. Política de execução

- uma task lógica por objetivo e change set;
- PR pequeno quando houver separação técnica real;
- implementar, integrar e validar antes de ampliar;
- bugs causados pela task permanecem na mesma task;
- bugs independentes viram nova task;
- staging opera sem cliques manuais depois de autorização da task;
- `main`, produção, custo e operações destrutivas exigem autorização explícita;
- atualizar `PROJECT_STATE.md` a cada mudança de capacidade.

## 3. Roadmap atual

### EXT-1B — Hotfix e validação da fundação

**Estado:** `IN_PROGRESS`

Objetivo:

- corrigir dependências da extensão no build Render;
- corrigir focus trap no Shadow DOM;
- remover controles inertes na página própria;
- responder e resolver threads do PR #81;
- carregar `extension/dist` manualmente no Chromium.

Critérios:

- CI verde;
- build Render limpo compatível;
- Tab/Shift+Tab contidos no overlay;
- Escape fecha e devolve foco;
- página própria sem botões inertes;
- botão/overlay/página validados no ChatGPT web;
- console sem erro.

Fora de escopo:

- OAuth;
- backend;
- realtime;
- ação real.

### EXT-2A — UI React compartilhada e host web local

**Estado:** `IMPLEMENTED_LOCAL`

Objetivo:

- usar uma única `GameApp` React em web local, overlay e página própria;
- desenvolver pelo host Vite com HMR;
- manter fixture local e a fundação MV3 sem OAuth ou backend;
- isolar APIs Chrome em adapters de plataforma.

Critérios:

- web local sem APIs Chrome;
- overlay no Shadow DOM com root React único e cleanup;
- página própria sem controles inertes;
- testes React, build web e build MV3 verdes;
- checkpoint manual de `extension/dist` no Chromium após integração.

Fora de escopo:

- OAuth;
- backend;
- leitura ou ações reais;
- publicação web.

### EXT-2B — OAuth próprio da extensão

**Estado:** `INTEGRATED` — checkpoint manual pendente

Objetivo:

- autenticar a extensão sem usar cookies ou tokens do ChatGPT;
- vincular a identidade ao mesmo `User` interno do App MCP;
- armazenar a sessão com segurança;
- suportar refresh, logout e revogação.

Critérios:

- PKCE;
- um client apropriado ou extensão segura do modelo atual, após auditoria;
- nenhuma credencial no manifest;
- User suspenso/revogado falha fechado;
- expiração recuperável;
- User A não acessa User B.

Checkpoint restante:

- recarregar `extension/dist` com a nova permissão `identity`;
- concluir login interativo em staging e confirmar convergência entre overlay
  e página própria;
- testar reinício do service worker, logout e novo login.

Fora de escopo:

- leitura de ficha;
- realtime;
- ações.

### EXT-3 — Contexto read-only real

**Estado:** `NOT_STARTED`

Objetivo:

- substituir fixture local por projeções reais do backend;
- carregar Resumo, Ficha, Inventário, Equipamentos, Habilidades e continuidade.

Critérios:

- reutilizar serviços atuais;
- paginação;
- loading, vazio e erro;
- sem `MASTER_ONLY`;
- sem UUID interno desnecessário;
- reload reconstrói pelo backend;
- nenhuma mutação.

### EXT-4 — Atualização automática

**Estado:** `NOT_STARTED`

Objetivo:

- manter a extensão sincronizada com mudanças vindas do GPT/MCP ou da própria extensão.

Estratégia:

1. recarga após mutação;
2. polling controlado como fallback;
3. SSE ou WebSocket autenticado;
4. invalidação por `sessionVersion` e áreas alteradas.

Critérios:

- reconexão com backoff;
- recarga oficial após reconectar;
- evento perdido não deixa estado divergente;
- canal não vira fonte de verdade;
- deploy/restart recuperável.

### EXT-5 — Observar pela extensão

**Estado:** `NOT_STARTED`

Objetivo:

- executar `performAuthenticatedObservation` pelo frontend principal;
- mostrar resultado oficial;
- atualizar `lastAction` e versão;
- refletir mudanças automaticamente;
- disponibilizar resultado ao GPT para narração.

Critérios:

- idempotência;
- clique duplo protegido;
- conflito recuperável;
- retry apenas de transporte com mesma chave;
- bloqueio/rejeição exigem reload ou nova tentativa deliberada;
- HP, Mana, SP e inventário inalterados.

### GAME-1 — Movimento simples

**Estado:** `NOT_STARTED`

Objetivo:

- carregar localização pública;
- listar destinos válidos;
- mostrar prévia;
- confirmar deslocamento;
- persistir localização e tempo quando aplicável.

Fora de escopo inicial:

- mapa tático;
- pathfinding complexo;
- encontro aleatório avançado.

### GAME-2 — Consumível simples

**Estado:** `NOT_STARTED`

Objetivo:

- selecionar consumível;
- prever efeito;
- confirmar;
- aplicar exatamente um consumo;
- atualizar inventário e recursos.

Critérios:

- item narrativo não consumível;
- quantidade e posse revalidadas;
- idempotência;
- conflito;
- projeção pública segura.

### GAME-3 — Habilidade simples

**Estado:** `NOT_STARTED`

Objetivo:

- selecionar habilidade autorizada;
- escolher alvo simples;
- aplicar custo e efeito;
- persistir evento;
- atualizar recursos;
- gerar aprendizagem quando aplicável.

Começar fora de encontro ou em cenário controlado.

### GAME-4 — Primeiro encontro jogável

**Estado:** `NOT_STARTED`

Objetivo:

- um personagem;
- um inimigo;
- janela de decisão;
- movimento simples;
- ataque básico;
- habilidade simples;
- fim do encontro;
- loot mínimo;
- retomada após interrupção.

Critérios:

- `NEXT_PLAYER_DECISION`;
- mapa simples;
- resolução autoritativa;
- atualização automática;
- idempotência;
- conflito;
- nova conversa/aba recupera estado.

## 4. Depois do primeiro ciclo jogável

Ordem aproximada, sujeita a testes:

1. equipamentos mutáveis;
2. comércio;
3. treino;
4. progressão por uso;
5. Cansaço e sono;
6. mapa de exploração;
7. combate tático por ticks;
8. loot completo;
9. relações e companheiros;
10. missões;
11. crafting;
12. painel administrativo;
13. criação inicial completa;
14. GPT definitivo sem Actions.

## 5. Migração do GPT definitivo

Somente após equivalência suficiente:

- preservar backup da configuração atual;
- revisar Instructions;
- revisar Knowledge;
- remover Actions da configuração do GPT;
- conectar somente App MCP;
- instruir uso da extensão;
- validar criação, retomada, narrativa e mecânica;
- manter rollback até aprovação.

## 6. Critérios para considerar o jogo testável

### Teste visual

```text
fundação validada
→ OAuth
→ leitura real
→ extensão atualiza sem recarregar manualmente toda hora
```

### Teste jogável mínimo

```text
Observar
→ movimento
→ consumível ou habilidade
→ primeiro encontro
```

### Não exigir antes do primeiro teste

- mapa final;
- combate completo;
- comércio completo;
- crafting;
- progressão final;
- produção;
- publicação da extensão na loja.

## 7. Backlog descoberto durante testes

Todo problema novo deve virar Issue quando:

- não foi causado pela task atual;
- exige commit próprio;
- muda produto;
- amplia escopo;
- precisa priorização.

Classificações sugeridas:

```text
type: bug | feature | change | removal | technical-debt
area: extension | backend | oauth | mcp | gameplay | combat | inventory | progression | security
```

## 8. Dependências críticas

- backend e `develop` saudáveis;
- Node 22.22.0;
- staging OAuth sintético;
- `GameSession` e projeções atuais;
- extensão com permissões mínimas;
- pipeline não deve implantar backend em mudanças apenas da extensão;
- build Render deve continuar instalando todo workspace chamado pelo build raiz.

## 9. Atualização deste arquivo

Atualizar quando:

- uma task entrar em andamento;
- uma task for integrada;
- uma capacidade for bloqueada;
- a ordem mudar;
- uma decisão arquitetural alterar dependências;
- surgir nova prioridade a partir de teste manual.

O estado detalhado por capacidade vive em `PROJECT_STATE.md`.
