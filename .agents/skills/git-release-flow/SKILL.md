---
name: git-release-flow
description: Use antes de commit, push, merge, rebase, PR, release ou qualquer alteração de histórico Git.
---

# Skill: Git and Release Flow

## Regras

- Não fazer commit sem autorização explícita.
- Não fazer push sem autorização explícita.
- Não fazer merge/rebase/alteração de histórico sem autorização.
- Não incluir arquivos temporários, logs, dumps, uploads, screenshots, vídeos ou `.env`.

## Antes de commit

Executar ou informar impossibilidade:

```bash
git status --short
git diff --name-only
git diff --check
```

Depois de staged:

```bash
git diff --cached --name-status
git diff --cached --check
```

## Depois de commit

Informar:

- hash;
- branch;
- arquivos commitados;
- `git status --short` final.

## Antes de push

Confirmar branch, último commit e working tree limpa.
