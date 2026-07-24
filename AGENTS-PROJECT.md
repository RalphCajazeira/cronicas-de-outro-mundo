# AGENTS-PROJECT.md — Game-GPT / Crônicas de Outro Mundo

Este arquivo complementa o `AGENTS.md` universal. Ele contém somente regras operacionais específicas deste projeto.

## Identificação

- Repositório: `RalphCajazeira/cronicas-de-outro-mundo`.
- Diretório local principal: `C:\Users\ralph\Desktop\Game_GPT`.
- Branch de integração: `develop`.
- Produto: RPG narrativo persistente com backend autoritativo e integração com GPT.

## Contexto específico local

Quando forem relevantes para a task, consulte:

```text
docs/ai/project/PROJECT_SOURCE.md
docs/ai/project/PROJECT_RULES.md
docs/ai/project/CURRENT_STATE.md
docs/ai/project/ROADMAP.md
```

Em nova task, leia este arquivo uma única vez e somente os documentos específicos necessários. Em continuação da mesma task, preserve o contexto já carregado e não releia tudo por rotina.

Esses arquivos são cópias sincronizadas do `Projetos_Gpt`. Trate-os como contexto gerenciado. Não os edite localmente para registrar estado novo, salvo autorização explícita; reporte as mudanças confirmadas para posterior atualização da fonte central.

## Regras autoritativas do produto

- O backend persistido é a fonte oficial do estado dinâmico do jogo.
- Narrativa, memória do chat e documentação não substituem retorno atual do backend ou banco.
- Consulte antes de criar entidades ou vínculos para evitar duplicações.
- Não invente IDs, códigos ou referências; use referências registradas e resolvíveis.
- Em retry exato, preserve payload, parâmetros e chave de idempotência.
- Após escrita crítica, confirme o estado quando o contrato exigir.
- Classes são identidade narrativa por padrão; não adicione bônus mecânicos automáticos sem regra aprovada.
- Não introduza evolução racial automática.
- NPCs, criaturas, inimigos e companheiros relevantes precisam de atributos, recursos e conteúdo mecânico coerentes quando participarem de sistemas persistentes.

## Continuidade e integração GPT

- `loadGame` não garante continuidade narrativa exata sem checkpoint ou resumo persistido.
- Não trate Instructions, Knowledge, Actions ou GPT publicado como alinhados com `develop` sem auditoria atual.
- Atualização de GPT, deploy, migration remota e banco staging são fases próprias e exigem autorização explícita.
- Não publique configuração parcial nem misture contrato legado e contrato novo sem consolidação.

## Gate de fases

- Não avance para a próxima fase enquanto a fase atual não estiver implementada, validada e auditada.
- Use `docs/ai/project/CURRENT_STATE.md` para o baseline conhecido e `ROADMAP.md` para a sequência planejada, confirmando fatos mutáveis no Git, contratos e ambientes.
- Não misture HTTP/OpenAPI local, staging/GPT e consequências de encontro em uma única task sem autorização explícita.
- Trate código integrado, código implantado no staging e configuração publicada no GPT Builder como estados independentes.
- No rollout da resolução automática, valide separadamente integridade terminal, replay, fuga em etapas e ações `wait` sem efeito mecânico antes de atualizar o GPT Builder.

## Regras de branch e efeitos externos

- Trabalhe a partir do estado correto de `develop`, criando branch específica quando autorizado pelo prompt.
- Não aplique migrations remotas, não faça deploy e não altere o GPT ao vivo sem autorização explícita.
- Não trate banco remoto ou staging como atualizado sem evidência.
- Preserve a separação entre core puro, persistência, HTTP/OpenAPI e integração GPT conforme a arquitetura vigente.
- Preserve exatamente 20 `operationId`s enquanto o contrato público vigente mantiver uma única Action `manageEncounter`.
- Não altere a classificação `x-openai-isConsequential` sem nova auditoria completa das operações e proteções do backend.

## Entrega específica

Além do contrato geral de entrega, informe quando aplicável:

- fase do roadmap afetada;
- contratos OpenAPI alterados ou preservados;
- migrations criadas, validadas e onde foram aplicadas;
- impacto em Actions, Knowledge ou GPT ao vivo;
- estado confirmado de `develop`;
- itens explicitamente mantidos fora de escopo.
