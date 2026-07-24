# Sincronização da base do Codex

Este repositório usa `RalphCajazeira/Projetos_Gpt` como fonte central das instruções gerais e específicas do Codex.

Este arquivo trata apenas da **sincronização simples**, quando a fonte central já está correta.

Para uma pasta nova ainda não preparada, siga:

```text
BOOTSTRAP_PROJETO_VAZIO.md
```

Para comparar o ambiente atual, atualizar o `Projetos_Gpt` e depois alinhar o repositório local e o Projeto do ChatGPT, siga:

```text
MAINTAIN_PROJETOS_GPT.md
```

## Fonte oficial

```text
Repositório: RalphCajazeira/Projetos_Gpt
Branch: main
Base geral: geral/codex/repository-template/
Projeto específico: projetos/<slug>/codex/
Contexto compartilhado: projetos/<slug>/chatgpt/
```

## Estrutura local resultante

```text
project-root/
  AGENTS.md
  AGENTS-PROJECT.md          # quando houver slug
  BOOTSTRAP_PROJETO_VAZIO.md
  MAINTAIN_PROJETOS_GPT.md
  SYNC_FROM_PROJETOS_GPT.md
  .agents/skills/
  docs/ai/*.md
  docs/ai/project/*.md
  docs/ai/project/codex/*.md # opcional
  templates/eslint/
  scripts/bootstrap-projetos-gpt.ps1
  scripts/sync-projetos-gpt.ps1
  .projetos-gpt-sync.json
  backend/
  frontend/
```

## Responsabilidade das camadas

```text
AGENTS.md                    = regras universais do Codex
AGENTS-PROJECT.md            = regras operacionais exclusivas do projeto
BOOTSTRAP_PROJETO_VAZIO.md   = primeira instalação em pasta vazia
MAINTAIN_PROJETOS_GPT.md     = ciclo completo de manutenção das três camadas
SYNC_FROM_PROJETOS_GPT.md    = propagação simples de uma fonte central pronta
docs/ai/*.md                 = documentação geral atualizável
docs/ai/project/*.md         = identidade, regras, estado e roadmap compartilhados
docs/ai/project/codex/*.md   = documentação opcional exclusiva do Codex
```

O `AGENTS.md` deve consultar `AGENTS-PROJECT.md` quando ele existir.

## Caminhos gerenciados

A sincronização pode substituir somente:

```text
AGENTS.md
AGENTS-PROJECT.md
BOOTSTRAP_PROJETO_VAZIO.md
MAINTAIN_PROJETOS_GPT.md
SYNC_FROM_PROJETOS_GPT.md
.agents/skills/
docs/ai/*.md
docs/ai/project/*.md
docs/ai/project/codex/*.md
templates/eslint/
scripts/bootstrap-projetos-gpt.ps1
scripts/sync-projetos-gpt.ps1
.projetos-gpt-sync.json
```

Arquivos específicos são gerenciados apenas quando `-ProjectSlug` é informado.

## Conteúdo preservado

Nunca alterar automaticamente:

```text
backend/
frontend/
prisma/
infra/
código da aplicação
documentação fora do manifesto gerenciado
arquivos locais desconhecidos não registrados no manifesto
```

Os arquivos sincronizados são cópias. Mudanças duráveis devem ser feitas primeiro no `Projetos_Gpt` e depois propagadas.

## Atualização no Windows

Na raiz do repositório da aplicação:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\sync-projetos-gpt.ps1 -ProjectSlug game-gpt
```

Troque `game-gpt` pelo slug correspondente.

Sem `-ProjectSlug`, o script atualiza somente a base geral do Codex e não altera `AGENTS-PROJECT.md` nem `docs/ai/project/`.

## O que o script faz

1. exige uma working tree limpa por padrão;
2. clona temporariamente a branch `main` do `Projetos_Gpt`;
3. atualiza a base universal, incluindo os guias de bootstrap e manutenção;
4. mantém atualizados os scripts de bootstrap e sincronização;
5. copia `projetos/<slug>/codex/AGENTS-PROJECT.md` para a raiz;
6. copia as fontes Markdown de `projetos/<slug>/chatgpt/`, exceto `README.md`, para `docs/ai/project/`;
7. copia documentação opcional de `projetos/<slug>/codex/docs/` para `docs/ai/project/codex/`;
8. remove somente arquivos antigos previamente registrados como gerenciados;
9. preserva código e arquivos fora do manifesto;
10. grava o commit de origem e o manifesto em `.projetos-gpt-sync.json`.

## Pedido direto ao Codex

```text
Atualize suas instruções gerais e específicas usando exclusivamente a branch `main` do repositório `RalphCajazeira/Projetos_Gpt`.

Siga `SYNC_FROM_PROJETOS_GPT.md` e execute `scripts/sync-projetos-gpt.ps1` com o slug deste projeto.

Substitua somente os caminhos gerenciados. Preserve código, alterações do usuário e qualquer arquivo fora do manifesto.

Antes de atualizar, confirme que a working tree está limpa. Depois, informe o commit de origem, os arquivos atualizados e `git status --short`.

Não faça commit nem push sem autorização.
```

## Primeira instalação

Em pasta vazia ou quase vazia, use:

```text
BOOTSTRAP_PROJETO_VAZIO.md
scripts/bootstrap-projetos-gpt.ps1
```

O bootstrap cria a instalação inicial sem exigir uma base local prévia.

## Segurança

- bootstrap e sincronização devem ser tasks próprias;
- não sincronizar sobre working tree suja sem autorização explícita;
- não misturar com feature, bugfix, migration ou refatoração;
- não usar branch, fork ou origem diferente sem autorização;
- não fazer commit nem push automaticamente.