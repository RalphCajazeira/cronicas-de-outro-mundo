# Template de Task para Codex

Use este modelo quando precisar montar prompt manualmente.

## Nova task

```text
Você está no projeto:
[CAMINHO_DO_PROJETO]

Antes de alterar qualquer coisa, leia:
- AGENTS.md
- docs/ai/project-context.md, se existir
- docs/ai/reuse-and-maintainability.md
- [docs específicos da tarefa]

Objetivo:
[descrever objetivo]

Contexto:
[descrever o que já se sabe]

Escopo permitido:
- [arquivos/áreas permitidas]

Escopo proibido:
- Não faça commit.
- Não faça push.
- Não altere .env real.
- Não rode comandos destrutivos.
- Não instale dependências sem justificar e pedir autorização.
- Não mexa fora do escopo sem explicar necessidade.

Tarefa:
1. Diagnostique rapidamente o estado atual.
2. Procure código existente semelhante antes de criar novo.
3. Explique o plano.
4. Implemente a menor mudança segura.
5. Rode validações compatíveis com os scripts existentes.
6. Entregue resumo.

Entrega final:
- resumo;
- arquivos alterados;
- validações executadas;
- validações não executadas e motivo;
- riscos;
- git status --short;
- próximo passo sugerido.
```

## Continuação da mesma task

```text
Continue nesta mesma task usando o contexto já carregado.

Se o contexto estiver incompleto, longo, incerto ou se o escopo mudou, releia:
- AGENTS.md
- [docs específicos]

Objetivo agora:
[descrever próximo passo]

Importante:
- Não faça commit.
- Não faça push.
- Não altere arquivos fora do escopo deste ajuste.
- Preserve alterações existentes do usuário.

Tarefa:
1. Use o diagnóstico/contexto anterior.
2. Faça somente o próximo passo solicitado.
3. Rode validações compatíveis.
4. Entregue resumo com arquivos alterados e git status --short.
```
