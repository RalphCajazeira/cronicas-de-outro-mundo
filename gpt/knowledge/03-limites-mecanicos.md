# Limites mecânicos atuais

## O que existe

O backend persiste mundos, campanhas, atores, os nove atributos primários, HP/Mana/SP atuais, snapshot derivado, definições de conteúdo, vínculos entre atores e conteúdo e eventos narrativos. Ele valida o contrato e a idempotência das escritas atuais e calcula máximos/derivados pelo ruleset `core-v1`.

O validador puro de fichas canônicas está ligado ao contrato e à persistência versionada. Ele reconhece tier, raridade, dano físico/mágico separado, custos explícitos, perfis temporais, targeting, duração, efeitos, stacking, modificadores e requisitos. Uma resposta bem-sucedida de publicação confirma validação estrutural e cria ou reutiliza uma versão; ela não aplica efeitos ao ator, resolve combate ou gasta recursos.

O backend persiste inventário físico, peso, carga e equipamento por slots. `manageActorInventory` confirma leitura, grant, remoção, divisão/fusão, reserva/liberação, destruição e equip/unequip; `inventoryStateVersion` protege escritas concorrentes. Modificadores de itens equipados e encumbrance entram na ficha autoritativa.

O núcleo puro `core-v1-effects-v1` continua calculando custos, dano, restauração, efeitos, duração e stacking. A fronteira `resolveActorEffect` torna o resultado oficial em uma transação: valida versões, gera rolls criptográficos no backend, persiste recursos, inventário, efeitos ativos, resolução, rolls e eventos allowlisted, e devolve o mesmo snapshot em replay idempotente.

O backend também publica o orquestrador persistente `manageEncounter` sobre o núcleo `core-v1-encounter-v1`. A operação preferencial `resolve_beat` recebe uma intenção de alto nível com até três componentes, internaliza timeline, reações, ações de aliados/inimigos e conclusão, e persiste um checkpoint atômico. O fluxo granular antigo permanece como fallback técnico. O cliente usa `expectedStateVersion` e nunca fornece rolls ou resultados mecânicos. Pela Action, participantes precisam ser atores persistidos na Campaign; participantes efêmeros não são aceitos.

Ações comuns (`move`, `defend`, `protect`, `prepare`, `intercept`, `assist`, `flee`, `observe`, `interact`, `improvise`) não dependem de habilidade com o mesmo nome. Uma habilidade conhecida pode melhorar ou habilitar uma execução específica, mas sua ausência não transforma a intenção em ataque ou magia. Ataque, magia e item usam refs confirmadas. Componentes podem ser aceitos, condicionais ou rejeitados com motivo; listas acima de três são inválidas.

## Encontros com poucas chamadas

`manageEncounter create` possui dois modos. O modo `assisted` recebe grupos de atores do party, hostis e neutros, objetivo, preferência de distância, protegidos e contexto ambiental curto. O backend deriva lados distintos, relações bilaterais e zonas canônicas, valida que exista uma primeira ação utilizável ou um caminho de aproximação e persiste tudo atomicamente. O modo `explicit` anterior continua disponível como fallback técnico; nele, lados e zonas continuam sendo responsabilidade de quem chama.

Toda resposta atual traz `scene` schema v2, a cápsula mecânica autoritativa do checkpoint. Ela reúne objetivo, lifecycle, participantes, relações, zonas, recursos, efeitos ativos, ameaças, movimentos, reações e as ações já projetadas. Ataques expõem `inventoryEntryRef`; magias expõem `contentRef`; itens expõem quantidade e consumo. Cada ação inclui custo, alcance, alvos válidos, compatibilidade de mão, `canUse` e blockers quando existirem. O catálogo detalhado fica com atores controláveis; NPCs recebem contagens fechadas por categoria, ameaças, estado e perfil tático. `catalogProjection=partial` informa atores/categorias resumidos e ações bloqueadas omitidas, sem fazer ausência por compactação parecer ausência mecânica. Toda ação utilizável do protagonista é preservada. A projeção de conteúdo e inventário usa leituras em lote para todos os participantes, não uma consulta por ação. Reutilize a cápsula enquanto a `stateVersion` não mudar.

O plano manual/assistido continua limitado a três componentes e usa exatamente o mesmo pipeline autoritativo de `resolve_beat`. Cada componente pode ter uma condição fechada `when`: ator opcional, recurso `hp|mana|sp`, comparação percentual acima/abaixo e percentual 0–100. A condição é avaliada no snapshot do início do beat. Se falsa, o fallback permitido é somente `skip` ou `defend`; sem fallback, equivale a `skip`. Não há repetição, código, expressão arbitrária ou loop livre. Se todas as etapas estiverem condicionadas e nenhuma puder executar, o backend rejeita sem escrita e pede uma etapa incondicional ou fallback.

No modo automático, `resolve_beat` recebe `policy` em vez de `intent`. A política define `until_decision|until_terminal|bounded`, estratégia, objetivo, prioridade/alvos, protegidos, seis beats por padrão, máximo de 12 e conservação de recursos. O default seguro não usa consumíveis comuns ou raros, habilidade limitada nem fuga; preserva 50% de mana/SP e para antes de HP crítico. A mesma transação, locks, rolls e ledger do beat existente resolvem os beats; não existe um segundo motor. Autoridade e catálogo são carregados uma vez, o estado evolui em memória, consumo/disponibilidade são atualizados localmente e a cápsula pública é montada uma vez ao final.

Uma parada `technical` significa apenas que o orçamento fechado acabou: o GPT deve usar a nova `stateVersion`, criar nova `idempotencyKey` e continuar sem perguntar. Uma parada `decision` devolve `requiresPlayerDecision=true`, motivo e alternativas e deve ser apresentada ao jogador. Terminal confirma outcome pelo finalizador já existente. Mudança de versão/autoridade, ação indisponível, HP do ator/protegido abaixo do limite, gasto raro proibido, decisão narrativa e candidato terminal impedem automação indevida. O backend não automatiza morte, perda permanente, loot ou recompensa.

Limites atuais: seis beats automáticos por padrão e 12 no máximo, três componentes por beat, quatro NPCs processados por beat, 32 eventos públicos e alvo de 256 ações detalhadas. As metas internas da cápsula são 64 KiB no encontro comum e 128 KiB com oito participantes; o hard cap público é 256 KiB UTF-8. Trinta segundos continua apenas como timeout extremo. Os contadores e budgets de queries limitam trabalho sem depender de teste frágil de milissegundos. `processedEventCount`, `visibleEventCount` e `eventsTruncated` deixam explícito quando o timeline foi resumido; o ledger, atores que agiram e deltas finais continuam considerando toda a execução. Replay com o mesmo payload e chave devolve o mesmo checkpoint sem novo roll, custo, consumo ou consequência.

## O que permanece adiado

Não existem de forma estruturada nesta fase:

- criação de participante efêmero pela Action de encontros;
- concessão automática de XP, level-up, loot, ouro, progressão, morte ou recompensa material ao concluir encontro;
- durabilidade, munição, loot automático ou comércio;
- economia, comércio, lojas, estoque ou transações;
- missões e relacionamentos especializados;
- memórias de atores ou Codex especializado;
- relógio, clima, coordenadas, rotas ou viagens persistentes;
- saves narrativos livres e recuperação especializada de campanha fora do checkpoint mecânico por beat;
- recursos customizados persistidos e morte/ressurreição automática.

Não apresente esses sistemas como implementados e não invente persistência para eles.

## Como narrar dentro dos limites

Combate pode incluir intenção, risco, vantagem narrativa, fuga, rendição, medo e consequência ficcional. Fora de encontro, conteúdo self, single target e weapon attack pode ser resolvido por `resolveActorEffect`; dentro de encontro, use `manageEncounter resolve_beat`. O GPT descreve a intenção e pode sugerir tática de NPC, mas hit, crítico, dano, mitigação, custo, roll e outcome pertencem ao backend. Narre somente participantes, `transitionSummary`, `beatSummary` e consequências confirmadas. Loot só é posse confirmada após uma operação de inventário bem-sucedida.

Itens, lojas, clima e viagens podem aparecer na história com coerência, descrição e continuidade. Uma `ContentDefinition` representa o conceito; somente `manageActorInventory` cria propriedade física. Isso não cria preço, comércio, distância ou viagem automática.

Quando `manageEncounter` confirmar conclusão ou cancelamento, `consequencesSummary` é a única fonte narrativa para outcome, mudanças de status, contagem de efeitos de encontro removidos e evento persistente. `defeated` é incapacidade, não morte; cura persistida de HP zero para valor positivo pode restaurar `active`. Falha não encerra nem autoriza avanço narrativo, cancelamento não é vitória e replay não concede nova consequência.

Quando a história precisar preservar um fato compatível com o contrato, use a capacidade estruturada ou genérica adequada. Caso contrário, trate-o explicitamente como regra narrativa ou sistema futuro.

O evento técnico `campaign-started` registra apenas um resumo funcional allowlisted da criação confirmada, com payload limitado. Ele não é checkpoint, snapshot narrativo, inventário ou memória especializada, e sua idempotência não é uma segunda chave pública separada da operação `startGame`.

Estado deste artefato: a resolução por beat está operacional no staging. As mudanças locais de autonomia e classificação das Actions desta task ainda dependem de revisão e publicação manual no GPT Builder.
