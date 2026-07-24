# Manutenção completa do ambiente GPT + Codex

Use este arquivo quando o Ralph pedir para **avaliar, atualizar e sincronizar todo o ambiente** deste projeto com `RalphCajazeira/Projetos_Gpt`.

Este fluxo é mais amplo que `SYNC_FROM_PROJETOS_GPT.md`:

```text
SYNC_FROM_PROJETOS_GPT.md = somente propaga a fonte central para o repositório local
MAINTAIN_PROJETOS_GPT.md   = compara ambiente atual, atualiza a fonte central e depois propaga para local e ChatGPT
```

## Fonte oficial

```text
Repositório: RalphCajazeira/Projetos_Gpt
Branch final: main
Fluxo geral: geral/AUTO_UPDATE_WORKFLOW.md
```

## Escopo autorizado quando o pedido do Ralph solicitar o ciclo completo

Você pode:

- inventariar instruções e fontes atuais do repositório local;
- inventariar o Projeto do ChatGPT correspondente quando tiver acesso;
- comparar tudo com o `Projetos_Gpt`;
- criar, atualizar e remover arquivos de configuração no `Projetos_Gpt` dentro das camadas corretas;
- criar branch, commit, push e PR no `Projetos_Gpt`;
- fazer merge no `Projetos_Gpt` somente quando houver autorização explícita no pedido e todas as validações estiverem limpas;
- instalar ou sincronizar a base local do Codex;
- atualizar Instruções e Fontes do Projeto no ChatGPT quando a ferramenta ou interface permitir.

Você não pode misturar nesta task:

- feature, bugfix ou refatoração da aplicação;
- alteração de banco ou migration;
- deploy;
- mudança de infraestrutura;
- exposição de secrets;
- commit ou push da aplicação sem autorização própria.

## Etapa 1 — Identificação e capacidade

Determine:

- repositório local da aplicação;
- branch atual e branch de integração;
- slug em `Projetos_Gpt`;
- Projeto correspondente no ChatGPT;
- acesso disponível ao GitHub, sistema de arquivos e Projeto do ChatGPT.

Se o slug não existir, crie a estrutura mínima:

```text
projetos/<slug>/
  README.md
  chatgpt/
    README.md
  codex/
    README.md
    AGENTS-PROJECT.md
```

Crie outros arquivos somente quando houver conteúdo real.

## Etapa 2 — Inventário local

Analise somente os arquivos relevantes para agentes e contexto:

```text
AGENTS.md
AGENTS-PROJECT.md
AGENTS*.md
.agents/
.codex/
docs/ai/
SYNC_FROM_PROJETOS_GPT.md
MAINTAIN_PROJETOS_GPT.md
scripts de sincronização
README, roadmap, decisões e arquitetura relevantes
.projetos-gpt-sync.json
```

Identifique:

- conteúdo geral reutilizável;
- conteúdo exclusivo do projeto;
- personalizações locais ainda válidas;
- duplicações;
- arquivos obsoletos;
- caminhos que não podem ser substituídos.

## Etapa 3 — Inventário do Projeto do ChatGPT

Quando houver acesso direto:

- leia o campo **Instruções do Projeto**;
- liste as fontes atuais;
- preserve conteúdo específico útil ainda não centralizado;
- identifique instruções duplicadas ou antigas;
- não altere ainda: primeiro atualize a fonte central.

Sem acesso direto, registre a limitação e prepare instruções manuais exatas no final.

## Etapa 4 — Comparação com a fonte central

Clone ou atualize `RalphCajazeira/Projetos_Gpt` e siga:

```text
geral/AUTO_UPDATE_WORKFLOW.md
geral/chatgpt/KNOWLEDGE_MAINTENANCE.md
```

Compare:

```text
Local universal         ↔ geral/codex/
Local específico        ↔ projetos/<slug>/codex/
Contexto compartilhado  ↔ projetos/<slug>/chatgpt/
Projeto do ChatGPT      ↔ geral/chatgpt/ + projetos/<slug>/chatgpt/
```

Classifique toda mudança antes de escrever. Não promova regra exclusiva para `geral/` apenas por conveniência.

## Etapa 5 — Atualização da fonte central

Atualize primeiro o `Projetos_Gpt`:

- `geral/chatgpt/` para regras reutilizáveis do ChatGPT;
- `geral/codex/` para regras reutilizáveis do Codex;
- `projetos/<slug>/chatgpt/` para produto, domínio, estado, roadmap e decisões;
- `projetos/<slug>/codex/` para regras operacionais exclusivas do executor.

Regras:

- atualizar antes de criar;
- remover somente conteúdo duplicado, obsoleto, vazio ou substituído;
- preservar histórico útil;
- não copiar relatórios brutos;
- não registrar hipótese como fato;
- revisar o diff e buscar secrets.

## Etapa 6 — Git da fonte central

Preferir branch dedicada e PR.

O ciclo completo pode fazer merge quando o pedido do Ralph autorizar explicitamente e:

- o diff estiver limitado a configuração e documentação;
- os caminhos estiverem corretos;
- não houver secrets;
- scripts e manifestos estiverem coerentes;
- não houver conflito com mudanças externas.

Depois do merge, use o commit final de `main` como origem das sincronizações.

## Etapa 7 — Instalação ou sincronização local

### Base ausente

Copie `geral/codex/repository-template/` para a raiz e execute o script com o slug.

### Base presente

Execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\sync-projetos-gpt.ps1 -ProjectSlug <slug>
```

Depois revise:

```bash
git status --short
git diff --name-only
git diff --check
```

Verifique especialmente:

```text
AGENTS.md
AGENTS-PROJECT.md
MAINTAIN_PROJETOS_GPT.md
SYNC_FROM_PROJETOS_GPT.md
docs/ai/
docs/ai/project/
.agents/skills/
.projetos-gpt-sync.json
```

Não altere código da aplicação durante esta etapa.

## Etapa 8 — Atualização do Projeto no ChatGPT

Quando houver capacidade de escrita, configure usando a `main` final:

### Instrução

```text
geral/chatgpt/PROJECT_INSTRUCTIONS.txt
```

### Fontes gerais

```text
geral/chatgpt/GENERAL_SOURCE.md
geral/chatgpt/MODEL_SELECTION.md
geral/chatgpt/EXECUTION_GOVERNANCE.md
geral/chatgpt/KNOWLEDGE_MAINTENANCE.md
```

### Fontes específicas

Use somente os arquivos indicados em:

```text
projetos/<slug>/chatgpt/README.md
```

Remova versões antigas ou duplicadas gerenciadas, preserve fontes deliberadamente externas e confirme que a configuração foi salva.

Sem capacidade de escrita, entregue o conteúdo e a lista exata para atualização manual. Não alegue que o Projeto foi alterado.

## Etapa 9 — Validação final

Confirme coerência entre:

```text
Projetos_Gpt/main
repositório local
Projeto do ChatGPT
```

O relatório deve incluir:

- slug e repositórios;
- inventário encontrado;
- alterações gerais e específicas;
- branch, PR, merge e commit central;
- commit usado na sincronização local;
- arquivos locais atualizados;
- estado da working tree;
- Instruções e Fontes finais do Projeto do ChatGPT;
- conteúdo preservado;
- bloqueios e ações manuais.

Nunca declare conclusão total quando o Projeto do ChatGPT ou a `main` central não tiverem sido efetivamente atualizados.