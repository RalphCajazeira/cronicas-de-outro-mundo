# AI Workflow — GPT gerencia, Codex executa

## Papéis

```text
ChatGPT Project:
- faz triagem;
- classifica risco;
- escolhe modelo e esforço;
- classifica Mesma task ou Nova task;
- decide Mesmo chat ou Novo chat do Codex;
- define estratégia;
- pergunta o mínimo necessário;
- cria prompts;
- analisa evidências;
- decide próximo passo.

Codex:
- segue AGENTS.md, AGENTS-PROJECT.md e docs relevantes;
- diagnostica no repositório;
- altera arquivos;
- roda validações;
- respeita condições de parada;
- entrega estado e evidências.
```

## Fluxo básico

```text
Ralph descreve objetivo no ChatGPT Project
→ GPT classifica projeto e risco
→ GPT escolhe modelo e esforço
→ GPT classifica o escopo lógico da task
→ GPT escolhe a conversa do Codex
→ GPT gera prompt
→ Codex executa ou diagnostica
→ Ralph traz a resposta ao GPT
→ GPT aprova, pede correção, registra bloqueio ou segue para validação/commit/push
```

## Duas decisões independentes

```text
Task: [Mesma task | Nova task]
Codex: [Mesmo chat | Novo chat]
```

- `Task` indica continuidade ou separação do escopo técnico, critérios de aceite, diff e versionamento.
- `Codex` indica se o prompt deve continuar na conversa atual ou iniciar outra.

Combinações válidas:

```text
Mesma task + Mesmo chat
Nova task + Mesmo chat
Nova task + Novo chat
Mesma task + Novo chat
```

## Mesma task

Use quando o próximo passo continua o mesmo objetivo e o mesmo change set:

- implementação após diagnóstico;
- correção causada pela mudança atual;
- ajuste pós-revisão do mesmo PR;
- validação, commit, push ou conclusão do mesmo escopo.

## Nova task

Use quando houver escopo ou versionamento próprios:

- feature ou bug independente;
- causa diferente da mudança anterior;
- novos critérios de aceite;
- outro commit ou change set;
- tarefa anterior já encerrada ou integrada.

Um bug descoberto em smoke ou rollout pode ser `Nova task` quando apenas revelou um defeito independente.

## Mesmo chat do Codex

Use quando o contexto carregado ajuda sem contaminar o novo escopo:

- mesmos arquivos, arquitetura ou ambientes;
- problema descoberto no rollout atual;
- conversa organizada;
- separação clara de diff e commit.

### Mesma task no mesmo chat

Use:

```text
Continue nesta mesma task usando o contexto já carregado.
Não releia AGENTS.md, AGENTS-PROJECT.md ou a documentação por rotina.
Releia apenas se houver mudança, conflito, perda de contexto ou detalhe necessário ausente.
```

Informe apenas:

- o que mudou;
- próximo objetivo;
- novas restrições;
- novas validações;
- condição de parada específica.

### Nova task no mesmo chat

Use:

```text
Inicie uma nova task lógica nesta mesma conversa, aproveitando apenas o contexto técnico ainda útil.
Não misture o escopo, diff, critérios de aceite ou commit da task anterior com esta nova task.
```

Defina novo objetivo, escopo, critérios, validações e estratégia de commit próprios.

## Novo chat do Codex

Use quando:

- assunto distante ou independente;
- conversa longa, saturada ou contraditória;
- Codex misturando escopos;
- contexto antigo induzindo decisões erradas;
- handoff limpo for mais seguro.

### Nova task em novo chat

O prompt deve pedir uma única vez para localizar e seguir:

```text
AGENTS.md
AGENTS-PROJECT.md, quando existir
```

E consultar somente os docs pertinentes, por exemplo:

```text
docs/ai/project-context.md
docs/ai/architecture.md
docs/ai/reuse-and-maintainability.md
docs/ai/validation.md
docs/ai/security-and-sensitive-features.md
docs/ai/legacy-migration.md
```

Não pedir leitura de toda a documentação sem necessidade.

### Mesma task em novo chat

Use quando a conversa anterior saturou ou foi interrompida, mas o objetivo lógico ainda é o mesmo.

O handoff deve conter:

- objetivo;
- estado confirmado;
- decisões;
- arquivos relevantes;
- mudanças já realizadas;
- validações;
- critérios pendentes;
- próxima ação;
- branch, PR ou commit relacionado.

## Releitura seletiva

Pedir releitura somente se:

- o prompt estiver em novo chat;
- a nova task tocar arquivos ainda não analisados;
- houver conflito ou dúvida real;
- arquivo de instrução tiver mudado;
- o Codex demonstrar perda de contexto;
- o estado do repositório puder ter mudado externamente.

## Diagnóstico primeiro

Peça diagnóstico sem alteração quando:

- problema vago;
- muitos arquivos;
- banco ou migration;
- segurança, autenticação, pagamento, documentos, localização, biometria, CI/E2E ou deploy;
- projeto legado;
- possível reestruturação.

## Implementação direta

Pode implementar direto quando:

- escopo pequeno e claro;
- área afetada conhecida;
- diagnóstico suficiente;
- ajuste pequeno do escopo atual;
- novo bug independente já possui causa e solução delimitadas;
- repetir diagnóstico não reduz risco.

## Estratégia por fases

```text
Diagnóstico ambíguo: Sol + Alto
Implementação delimitada: Terra + Médio
Validação/commit/push: Luna + Leve
```

Reavalie separadamente modelo, esforço, risco, task lógica e conversa do Codex.

## Evitar loop infinito

Depois que houver causa, arquivos, riscos e plano suficientes, avance para implementação ou validação.

Não crie novo prompt quando a task já estiver aprovada e encerrada.

## Encerramento

O GPT deve declarar:

```text
Aprovado
Correção necessária
Bloqueado por decisão ou acesso
Parcialmente concluído
```

O Codex deve declarar:

```text
Estado: concluído | parcialmente concluído | bloqueado | falhou
```

Relatório do Codex é evidência inicial, não verdade automática.