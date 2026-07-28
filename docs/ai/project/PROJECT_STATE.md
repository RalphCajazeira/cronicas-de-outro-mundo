# Estado Vivo do Projeto

**Projeto:** Crônicas de Outro Mundo  
**Atualizado em:** 2026-07-27  
**Branch de integração:** `develop`  
**Baseline ao criar este documento:** `ace80762237ce7bfb7ca8b19db9d37c9bfc75fff`
**`main` de produção:** `58fa8d234a2822877c5cd06998382e8e9d092524`

## 1. Como usar este documento

Este arquivo registra o estado operacional conhecido por capacidade.

Ele não substitui:

- código e Git atuais;
- banco e serviços atuais;
- testes e CI atuais;
- regras canônicas em `RalphCajazeira/Regras-Game-GPT`.

Quando houver conflito, o ambiente e o repositório atuais prevalecem.

## 2. Vocabulário

```text
NOT_STARTED
IN_PROGRESS
IMPLEMENTED_LOCAL
INTEGRATED
DEPLOYED_STAGING
MANUALLY_VALIDATED
BLOCKED
DEPRECATED
REMOVED
```

## 3. Arquitetura atual

```text
GPT personalizado
→ Instructions + Knowledge + App MCP
→ narrativa, diálogo e interpretação

Extensão Chromium
→ frontend principal
→ botão flutuante, overlay/full-page e página própria

Backend
→ autoridade, autorização, regras e persistência

Widget do ChatGPT
→ fallback leve e diagnóstico

Actions/OpenAPI no GPT
→ legado temporário; não farão parte do GPT definitivo
```

## 4. Estado por capacidade

| Capacidade | Estado | Evidência principal | Limitações / próxima ação |
| --- | --- | --- | --- |
| Backend REST/Actions legado | `DEPLOYED_STAGING` | serviços existentes e pipeline de staging | Mantido por compatibilidade; não é a fachada principal futura do GPT. |
| Actions configuradas no GPT atual | `DEPRECATED` | configuração histórica do GPT | Remover somente na migração final para Instructions + Knowledge + App MCP. |
| Fundação de identidade e autorização | `DEPLOYED_STAGING` | PR #58, modelos `User`, `ExternalIdentity`, `CampaignMembership`, `ActorControl`, `AuditEvent` | Produção não iniciada. |
| OAuth Resource Server MCP | `MANUALLY_VALIDATED` | PR #59 e rollout da Fase 2C | Apenas staging; DCR desabilitado. |
| OAuth real do App MCP | `MANUALLY_VALIDATED` | PRs #63–#68 | Uma conta sintética e um client OAuth em staging. |
| App `Crônicas de Outro Mundo — OAuth Staging` | `MANUALLY_VALIDATED` | catálogo OAuth reindexado | App privado de staging; não é produção. |
| Contexto autenticado read-only | `MANUALLY_VALIDATED` | PR #67 | Usa fixture sintética; sem dados reais. |
| Ficha, recursos, inventário, equipamentos e habilidades no widget | `MANUALLY_VALIDATED` | PRs #69–#74 | Widget deixa de receber evolução visual grande. |
| `GameSession` e seleção persistente | `MANUALLY_VALIDATED` | PRs #75–#77 | Uma campanha/ator na fixture principal; testes cobrem múltiplos usuários/opções. |
| Ação autenticada `Observar` | `DEPLOYED_STAGING` | PRs #78–#80; backend live em `5ed97b32a10f140312517b7154d6e3fb633ecd70` | Persistência, idempotência e projeção pública prontas; validação visual do iframe não é mais requisito principal. |
| Projeção pública de `GameEvent` | `DEPLOYED_STAGING` | PR #80 | Eventos sem contrato público falham fechado. |
| Widget como frontend principal | `DEPRECATED` | decisão arquitetural de 2026-07-27 | Mantido como fallback, bootstrap e diagnóstico. |
| Fundação da extensão MV3 | `MANUALLY_VALIDATED` | PR #81; PR #82; PR #84; suíte de extensão | Shell local validado manualmente em etapa anterior; este ajuste corrige apenas suíte de validação do Render. |
| Botão flutuante + overlay + página própria | `INTEGRATED` | pacote `extension/` + testes + validação de regressão | Overlay manualmente validado em rodadas anteriores. Página própria coberta automaticamente por testes; validação manual nesta sessão não executada no navegador. |
| Game UI React compartilhada + host Vite local | `INTEGRATED` | `extension/src/app`, `extension/src/platform`, `extension/src/entries`, `extension/src/content` | Mesmo componente atende web, overlay e página própria com fixture local; checkpoint da extensão descompactada segue pendente nesta correção. |
| OAuth próprio da extensão | `NOT_STARTED` | — | Próxima fase após validação/hotfix da fundação. |
| Leitura real do backend pela extensão | `NOT_STARTED` | — | Reutilizar projeções e autorização existentes. |
| Atualização automática da extensão | `NOT_STARTED` | — | Começar por recarga após mutação/polling; evoluir para SSE ou WebSocket. |
| `Observar` executado pela extensão | `NOT_STARTED` | — | Reutilizar serviço já implantado. |
| Movimento simples | `NOT_STARTED` | — | Depende de leitura real e sincronização. |
| Uso de consumível | `NOT_STARTED` | — | Depende de projeção e mutação autorizada da extensão. |
| Habilidade simples | `NOT_STARTED` | — | Depende de contrato de ação e efeitos. |
| Primeiro encontro jogável na extensão | `NOT_STARTED` | — | Depende de movimento, ação simples e atualização automática. |
| GPT definitivo sem Actions | `NOT_STARTED` | decisão aprovada | Migrar após equivalência suficiente de MCP/extensão. |
| Produção | `NOT_STARTED` | `main` preservada | Nenhuma autorização de produção neste estado. |

## 5. Ambiente de staging conhecido

- workspace Render: `Ralph's workspace`;
- serviço: `cronicas-de-outro-mundo-staging-api`;
- branch: `develop`;
- auto-deploy: desabilitado;
- pipeline canônico entrega o SHA exato;
- Node: `22.22.0`;
- health: `/health`, `/health/ready`, `/health/version`;
- Supabase staging: projeto Virginia;
- banco: PostgreSQL;
- migrations comuns automatizadas;
- operações de staging autorizadas não exigem aprovação manual de Ralph;
- produção e `main` permanecem fora do escopo.

## 6. Segurança e isolamento comprovados

- identidade derivada do token;
- `ExternalIdentity` vinculada a `User`;
- autorização por membership e controle de ator;
- User A não acessa recursos de User B;
- `stateVersion` e idempotência em mutações;
- RLS e grants endurecidos nas tabelas sensíveis;
- projeções públicas allowlisted;
- eventos sem contrato público falham fechado;
- tokens, subjects, secrets e identificadores internos não entram nos DTOs públicos;
- extensão não lê chat, cookies ou tokens.

## 7. Dados de teste

O staging utiliza somente identidade e conteúdo sintéticos para os fluxos autenticados recentes.

Exemplos conhecidos:

- campanha: `OAuth Readonly Test`;
- personagem: `Test Adventurer`;
- itens sintéticos;
- equipamento sintético;
- habilidades sintéticas.

Não reutilizar Ralph, Kael, Elarion ou campanhas reais como fixture da extensão/OAuth.

## 8. Pendências imediatas

1. revisar, integrar e validar a migração React/Web da extensão;
2. carregar `extension/dist` manualmente no Chromium;
3. validar botão, overlay, teclado, página própria e console;
4. implementar OAuth próprio da extensão;
5. carregar contexto/ficha/inventário reais;
6. implementar atualização automática;
7. executar `Observar` pela extensão;
8. iniciar testes jogáveis incrementais.

## 9. Regras de manutenção

Todo PR que alterar uma capacidade deve:

- atualizar esta tabela; ou
- declarar que não altera o estado do produto.

Ao mudar arquitetura ou decisão transversal, atualizar também:

- `docs/ai/project/DECISIONS.md`;
- `RalphCajazeira/Regras-Game-GPT`.

Ao mudar ordem ou escopo das próximas tasks, atualizar:

- `docs/ai/project/ROADMAP.md`.

## 10. Divergências conhecidas

- documentos antigos ainda podem afirmar que o widget é o frontend principal;
- a arquitetura canônica atual usa a extensão como frontend principal;
- o roadmap histórico centrado em widget continua útil como referência de requisitos, mas não como ordem atual de entrega;
- o status `MANUALLY_VALIDATED` da extensão inclui validação manual de overlay.

## 11. Condição para primeiro teste jogável pela extensão

O primeiro teste jogável mínimo exige:

```text
extensão manualmente validada
→ OAuth próprio
→ leitura real
→ atualização automática
→ ação Observar real
```

Depois disso, movimento, consumível, habilidade e encontro serão adicionados em recortes pequenos.
