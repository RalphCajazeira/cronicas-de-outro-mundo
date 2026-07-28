# Decisões do Projeto

**Atualizado em:** 2026-07-27

Este arquivo registra decisões que afetam múltiplas tasks, superfícies ou contratos.

## D-001 — Backend continua autoritativo

**Status:** aprovada

Decisão:

- regras, autorização, resolução e persistência pertencem ao backend;
- PostgreSQL é a fonte durável;
- nenhum frontend concede XP, altera inventário ou resolve mecânica por conta própria;
- GPT e extensão usam os mesmos serviços de aplicação por fachadas diferentes.

Consequência:

- toda mutação usa identidade derivada do token, `stateVersion`, idempotência e transação;
- projeções públicas são allowlisted;
- dados `MASTER_ONLY` nunca entram nas superfícies do jogador.

## D-002 — Extensão substitui widget como frontend principal

**Status:** aprovada

Decisão anterior:

- ChatGPT App/widget seria a interface visual principal.

Decisão atual:

```text
Extensão Chromium overlay/full-page = frontend principal
Widget do ChatGPT = fallback leve, bootstrap e diagnóstico
```

Motivo:

- widget remonta com frequência;
- carregamento e interação visual não atendem bem à experiência persistente desejada;
- extensão oferece overlay, página própria, estado visual e atualização independente da conversa.

Compatibilidade:

- OAuth, MCP, `GameSession`, projeções, idempotência e backend do widget são reutilizados;
- não remover widget agora;
- não investir em novas evoluções visuais grandes no widget.

## D-003 — GPT definitivo usa Instructions + Knowledge + App MCP

**Status:** aprovada

Decisão:

- o GPT final manterá Instructions e Knowledge;
- usará App MCP como integração oficial;
- Actions/OpenAPI serão removidas da configuração do GPT após equivalência suficiente;
- Actions podem permanecer temporariamente no backend/repositório como legado e compatibilidade.

O GPT permanece responsável por:

- narrativa;
- diálogos;
- interpretação criativa;
- criação orientada;
- escolha de tools;
- narração de resultados oficiais.

## D-004 — A extensão não espelha a conversa do ChatGPT

**Status:** aprovada

A extensão não deve:

- ler ou copiar continuamente o transcript;
- reconstruir o chat em outra UI;
- capturar cookies/tokens;
- usar APIs internas não documentadas;
- depender de seletores frágeis do composer como arquitetura principal.

A conversa continua no ChatGPT. A extensão apresenta e opera o jogo.

## D-005 — Modos da extensão

**Status:** aprovada

Modos principais:

- botão flutuante minimizado;
- overlay ocupando a área visível da página;
- página própria da extensão em aba.

Side Panel:

- opcional no futuro;
- não é requisito da fundação atual.

## D-006 — Sessão própria da extensão

**Status:** implementada em staging, pendente de checkpoint manual

A extensão terá OAuth/sessão próprios e será vinculada ao mesmo `User` interno do App MCP.

Não reutilizar:

- cookie do ChatGPT;
- token capturado da página;
- token interno do App MCP;
- segredo embutido no manifest.

Protocolo consolidado:

```text
cliente público Chromium
→ Authorization Code + PKCE S256 + state aleatório
→ redirect exato chromiumapp.org/oauth2
→ service worker troca código e possui a sessão
→ access token em memória; refresh rotativo somente em storage local restrito
→ audience /extension/session independente de /mcp-auth
→ ExternalIdentity → User ACTIVE → Player
```

O content script e o React recebem apenas estado público. A configuração e
o CORS aceitam somente o origin da extensão de staging. Sem endpoint de
revogação OAuth disponível no provedor atual, logout limpa sempre o refresh
local e o provedor controla expiração/rotação/revogação do refresh.

## D-007 — Realtime é invalidação, não fonte de verdade

**Status:** aprovada como direção; implementação pendente

Fluxo:

```text
backend confirma transação
→ publica evento pequeno
→ extensão invalida consultas
→ extensão recarrega projeções oficiais
```

Estratégia incremental:

1. recarga após mutação;
2. polling controlado;
3. SSE ou WebSocket autenticado conforme necessidade;
4. recarga integral após reconexão.

## D-008 — Staging não exige aprovação manual rotineira

**Status:** aprovada

Depois que Ralph autoriza a task:

- Codex e pipeline executam staging sem cliques adicionais;
- controles automáticos permanecem fail-closed;
- manifests, branch, SHA, dry-run, transação e postflight protegem operações sensíveis.

Ainda exigem autorização explícita:

- `main`;
- produção;
- custo/upgrade;
- dados reais;
- migration destrutiva;
- operação irreversível fora do escopo.

## D-009 — Tasks pequenas para alcançar jogabilidade

**Status:** aprovada

Estratégia:

```text
recorte pequeno
→ integração
→ teste manual
→ correção
→ próxima capacidade
```

Ordem imediata:

- fundação da extensão;
- OAuth;
- leitura real;
- atualização automática;
- Observar;
- movimento;
- consumível;
- habilidade;
- primeiro encontro jogável.

## D-010 — Manutenção documental obrigatória

**Status:** aprovada

Fontes vivas:

- `PROJECT_STATE.md` registra implementação/evidência;
- `ROADMAP.md` registra ordem executável;
- `DECISIONS.md` registra decisões transversais;
- `Regras-Game-GPT` registra produto, domínio e arquitetura-alvo.

Todo PR que muda capacidade deve atualizar o estado ou declarar que não muda o produto.

## D-011 — Render workspace correto

**Status:** aprovada

O workspace do projeto é:

`Ralph's workspace`

Não usar `Instahot` salvo evidência concreta de migração.

## D-012 — Branches

**Status:** aprovada

- `develop`: integração e staging;
- `main`: produção, preservada até autorização explícita;
- features/fixes: branches próprias;
- PRs apontam para `develop` durante esta fase.

## D-013 — Extensão não duplica regras do widget

**Status:** aprovada

Não copiar código acoplado ao App SDK apenas para acelerar.

Reutilizar quando seguro:

- contratos públicos;
- schemas independentes;
- tipos;
- conceitos visuais;
- serviços do backend.

Manter separados:

- bridge do App SDK;
- bridge da extensão;
- estado visual específico de cada host.

## D-014 — Widget congelado como fallback

**Status:** aprovada

Novas alterações no widget devem se limitar a:

- segurança;
- regressão;
- compatibilidade compartilhada;
- manutenção mínima.

Mapa, combate, comércio, treino e novas experiências visuais serão priorizados na extensão.

## D-015 — Sem produção nesta etapa

**Status:** aprovada

Até nova autorização:

- `main` permanece inalterada;
- produção não recebe deploy;
- dados reais não entram em fixtures;
- toda validação nova usa staging e identidades sintéticas.

## D-016 — Game UI React compartilhada e host web local

**Status:** aprovada

Decisão:

```text
GameApp React única
→ Vite web local para desenvolvimento/HMR
→ overlay MV3 no Shadow DOM
→ page.html da extensão
```

Os componentes não chamam `chrome.*`; diferenças de host vivem em adapters de
plataforma. O host web não é produto publicado e usa apenas fixture sintética
local, sem backend, OAuth ou dados reais.

## D-017 — Rollout automático de staging fail-closed

**Status:** aprovada

Para mudanças de backend autorizadas em `develop`, o CI/CD aplica migrations,
faz deploy do SHA exato somente após CI verde e executa health, readiness e
smokes. Falhas fecham o fluxo. Mudanças exclusivas de extensão não alteram
`backend/` nem `render.yaml` e, portanto, não disparam esse rollout.
