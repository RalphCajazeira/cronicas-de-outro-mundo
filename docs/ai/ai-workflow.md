# AI Workflow — GPT gerencia, Codex executa

## Papéis

```text
ChatGPT Project:
- faz triagem;
- decide estratégia;
- pergunta o mínimo necessário;
- cria prompts para Codex;
- analisa respostas do Codex;
- decide próximo passo.

Codex:
- lê AGENTS.md e docs/ai;
- diagnostica no repositório;
- altera arquivos;
- roda validações;
- entrega resumo técnico.
```

## Fluxo básico

```text
Ralph descreve objetivo no ChatGPT Project
→ GPT classifica: novo, existente com kit, legado, continuação
→ GPT gera prompt para Codex
→ Codex executa ou diagnostica
→ Ralph cola resposta no GPT
→ GPT decide ajuste, validação, commit, push ou encerramento
```

## Nova task do Codex

Em nova task, o prompt deve pedir leitura de:

```text
AGENTS.md
```

E docs específicos conforme o caso:

```text
docs/ai/project-context.md
docs/ai/architecture.md
docs/ai/reuse-and-maintainability.md
docs/ai/validation.md
docs/ai/security-and-sensitive-features.md
docs/ai/legacy-migration.md
```

Não pedir leitura de todos os documentos se a task for simples.

## Continuação da mesma task

Se o contexto já estiver carregado, o prompt deve dizer:

```text
Continue nesta mesma task usando o contexto já carregado.
```

Pedir releitura apenas se:

- o contexto ficou longo;
- o escopo mudou;
- a tarefa mudou de área;
- houve risco de confusão;
- o Codex parece estar seguindo regra desatualizada.

## Diagnóstico primeiro

Peça diagnóstico sem alteração quando:

- o problema é vago;
- envolve muitos arquivos;
- pode mexer em banco/migration;
- envolve segurança, autenticação, pagamento, documentos, localização, biometria, CI/E2E ou deploy;
- é projeto legado;
- pode exigir reestruturação.

## Implementação direta

Pode implementar direto quando:

- o escopo é pequeno e claro;
- a área afetada é conhecida;
- já existe diagnóstico suficiente;
- é ajuste pequeno em tarefa atual;
- repetir diagnóstico atrasaria a entrega.

## Evitar loop infinito

Não ficar em ciclo eterno de diagnóstico. Depois que houver causa, arquivos, riscos e plano suficientes, avance para implementação ou validação.

## Encerramento

Se o Codex entregou arquivos alterados, validações, git status e escopo limpo, o GPT pode dizer que a task está encerrada ou seguir para commit/push, conforme autorização.
