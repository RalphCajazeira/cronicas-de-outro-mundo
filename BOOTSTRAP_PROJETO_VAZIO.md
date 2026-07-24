# Bootstrap de projeto vazio — Codex + ChatGPT

Use este arquivo somente quando a pasta local estiver vazia ou quase vazia e ainda não possuir a base gerenciada pelo `Projetos_Gpt`.

Para projeto existente com código ou configuração relevante, use `MAINTAIN_PROJETOS_GPT.md`.

## Fonte autoritativa

```text
RalphCajazeira/Projetos_Gpt
branch main
geral/BOOTSTRAP_NEW_PROJECT_WORKFLOW.md
```

## Objetivo

Preparar três camadas antes de iniciar a implementação:

```text
Projetos_Gpt/main
pasta local do Codex
Projeto correspondente no ChatGPT
```

## Fluxo

1. Confirme que a pasta está vazia ou contém apenas arquivos iniciais sem implementação.
2. Determine nome, slug, objetivo, caminho local e nome do Projeto no ChatGPT.
3. Crie ou atualize primeiro `projetos/<slug>/` no repositório central.
4. Finalize a alteração central em branch/PR e use o commit final da `main`.
5. Execute o script de bootstrap para instalar a base local e a camada específica.
6. Crie e configure o Projeto no ChatGPT com a instrução universal e as fontes corretas.
7. Valide que as três camadas usam a mesma versão central.

## Instalação local

O script oficial está em:

```text
geral/codex/repository-template/scripts/bootstrap-projetos-gpt.ps1
```

Exemplo executado a partir de uma cópia temporária do `Projetos_Gpt`:

```powershell
powershell -ExecutionPolicy Bypass -File .\geral\codex\repository-template\scripts\bootstrap-projetos-gpt.ps1 -TargetRoot "C:\caminho\do\projeto" -ProjectSlug "meu-projeto" -InitializeGit
```

O script:

- recusa sobrescrever uma instalação gerenciada existente;
- pode inicializar Git local;
- instala a base universal do Codex;
- instala `AGENTS-PROJECT.md` quando existir;
- copia as fontes específicas para `docs/ai/project/`;
- grava `.projetos-gpt-sync.json`;
- não cria código, banco, deploy ou dependências de produto;
- não faz commit nem push.

## Projeto no ChatGPT

Configure com:

```text
Instruções:
geral/chatgpt/PROJECT_INSTRUCTIONS.txt

Fontes gerais:
geral/chatgpt/GENERAL_SOURCE.md
geral/chatgpt/MODEL_SELECTION.md
geral/chatgpt/EXECUTION_GOVERNANCE.md
geral/chatgpt/KNOWLEDGE_MAINTENANCE.md

Fontes específicas:
conforme projetos/<slug>/chatgpt/README.md
```

Sem acesso de escrita à interface do ChatGPT, entregue o pacote manual completo e não alegue criação ou atualização.

## Restrições

- não implementar a aplicação nesta task;
- não instalar dependências preventivamente;
- não criar pastas vazias de backend ou frontend sem decisão da Fase 0;
- não criar remoto GitHub da aplicação sem autorização;
- não fazer commit ou push da aplicação;
- não expor secrets;
- não usar outra origem além da `main` central sem autorização.