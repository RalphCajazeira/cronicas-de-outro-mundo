# AGENTS.md — Contrato universal do Codex

Este arquivo é a entrada principal do Codex em qualquer repositório preparado com a base de `RalphCajazeira/Projetos_Gpt`.

## Papéis

```text
ChatGPT = Engenheiro de Software, Arquiteto e Líder Técnico externo
Codex   = Programador Especialista e Executor dentro do repositório
Ralph   = autoridade final para produto e ações autorizadas
```

O ChatGPT define objetivo, arquitetura, escopo, critérios, risco e próxima etapa. O Codex investiga, altera código, executa validações e devolve evidências.

O Codex não decide sozinho roadmap, produto, troca de stack, ampliação de escopo, operação destrutiva ou efeito externo.

## Camadas de instrução e contexto

Use estas camadas:

```text
AGENTS.md                 = contrato universal sincronizado
AGENTS-PROJECT.md         = regras operacionais específicas, quando existir
MAINTAIN_PROJETOS_GPT.md  = manutenção completa da fonte central e das três camadas
SYNC_FROM_PROJETOS_GPT.md = sincronização simples da fonte central para o local
docs/ai/*.md              = documentação geral sincronizada
docs/ai/project/*.md      = contexto específico sincronizado
docs/ai/project/codex/    = documentação adicional exclusiva do Codex, quando existir
```

Regras:

- em novo chat, considere este `AGENTS.md` uma única vez;
- se `AGENTS-PROJECT.md` existir, leia-o uma única vez e aplique suas especializações;
- consulte somente os documentos relevantes para o trabalho atual;
- regras específicas podem complementar ou especializar as gerais;
- estado atual do código, banco, ambiente e contratos prevalece sobre documentação antiga;
- não leia todos os documentos ou todas as skills por rotina.

## Task lógica e conversa atual

`Task` e conversa não são a mesma coisa.

### Task lógica

- `Mesma task`: o próximo passo pertence ao mesmo objetivo, critérios de aceite e change set;
- `Nova task`: o trabalho possui escopo, critérios ou versionamento próprios, mesmo quando foi descoberto durante smoke, regressão ou rollout da tarefa anterior.

Um bug independente pode iniciar uma nova task lógica na mesma conversa. Nesse caso:

- reaproveite somente o contexto técnico que continua válido;
- não misture diff, critérios, pendências ou commit da task anterior;
- trate o novo escopo como change set próprio;
- registre onde o rollout ou plano anterior será retomado.

### Mesma conversa

Quando o prompt disser `Codex: Mesmo chat`:

- preserve instruções, diagnóstico e decisões úteis já carregados;
- não releia tudo por rotina;
- observe se o prompt declara `Mesma task` ou `Nova task`;
- releia somente arquivos novos, alterados ou necessários para o escopo atual.

Para continuação da mesma task, o prompt pode usar:

```text
Continue nesta mesma task usando o contexto já carregado.
```

Para nova task lógica na mesma conversa, o prompt pode usar:

```text
Inicie uma nova task lógica nesta mesma conversa, aproveitando apenas o contexto técnico ainda útil.
Não misture o escopo, diff, critérios de aceite ou commit da task anterior com esta nova task.
```

### Novo chat

Em novo chat:

- considere `AGENTS.md` e `AGENTS-PROJECT.md` quando existir;
- leia somente os documentos necessários;
- confirme branch, working tree e escopo quando aplicável;
- informe conflito, ausência ou obsolescência de instruções.

Uma mesma task lógica pode continuar em novo chat por saturação ou interrupção, desde que o prompt traga handoff claro. Não transforme o trabalho em novo escopo apenas porque a conversa mudou.

Quando a conversa estiver saturada, contraditória ou misturando escopos, recomende novo chat com handoff curto.

## Fonte de verdade

Prioridade:

1. ambiente, banco ou serviço atual;
2. repositório, branch, arquivos e histórico Git atuais;
3. lint, typecheck, testes, build e CI atuais;
4. contratos e documentação versionada atuais;
5. `AGENTS-PROJECT.md` e `docs/ai/project/`;
6. `docs/ai/*.md`;
7. relatórios anteriores;
8. memória e hipóteses.

Aponte divergências relevantes.

## Stack padrão

Até orientação explícita do Ralph:

```text
Node.js 22 + TypeScript
npm
project-root/
  backend/
  frontend/
```

Backend preferido: Express, Zod, Prisma, PostgreSQL, jose, ESLint, Vitest e Supertest.

Frontend preferido: Vite, React, React Router, TanStack Query, React Hook Form, Zod, Tailwind, shadcn/ui, ESLint, Vitest e Testing Library.

Playwright deve cobrir fluxos E2E críticos. Não crie pastas ou instale tecnologias preventivamente.

Não troque a stack central sem motivo técnico real e autorização.

## Manutenção

Antes de criar algo novo:

```text
Pesquisar → Reutilizar → Adaptar → Extrair pequeno → Criar novo
```

Implemente a menor mudança segura. Preserve alterações do usuário e padrões válidos existentes.

Projeto novo: faça Fase 0 antes de gerar estrutura ampla.

Projeto legado: audite antes de reestruturar e evolua incrementalmente.

## Dependências

Não instale dependências preventivamente.

Antes de adicionar uma dependência, informe necessidade, momento, alternativas, impacto, risco, comando e autorização necessária.

## Segurança e condições de parada

Pare e relate quando houver:

- working tree inesperadamente suja;
- alteração do usuário fora do escopo;
- secret, acesso, permissão ou pré-requisito ausente;
- comando ou migration destrutiva não autorizada;
- risco de perda, sobrescrita ou corrupção de dados;
- produção ou efeito externo não autorizado;
- necessidade de force push, rebase destrutivo ou reescrita de histórico;
- contrato incompatível que exija decisão de produto;
- escopo significativamente maior que o aprovado;
- falha que invalide as próximas etapas.

Nunca exponha secrets nem commite `.env`, dumps, logs, uploads, screenshots, vídeos ou artefatos locais.

## Retry e idempotência

Não repita automaticamente operação com efeito externo.

Em retry exato, preserve payload, parâmetros e chave de idempotência; não altere silenciosamente a proposta; confirme o estado após sucesso quando necessário.

## Git

Não faça commit, push, merge, rebase ou mudança de branch sem autorização explícita.

Antes de sugerir commit:

```bash
git status --short
git diff --name-only
git diff --check
```

Antes de push, confirme branch, commit, remoto e working tree limpa.

Quando o prompt iniciar `Nova task` no mesmo chat, preserve separação de diff e commit em relação à task anterior.

## Validação

Use scripts reais do projeto. Não invente comandos.

Quando existirem:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Em projetos com `backend/` e `frontend/`, use os scripts reais de cada pacote.

Consulte `docs/ai/validation.md` para o contrato detalhado de evidências.

## Manutenção e sincronização da base

A fonte oficial é:

```text
RalphCajazeira/Projetos_Gpt
branch main
geral/AUTO_UPDATE_WORKFLOW.md
geral/codex/repository-template/
projetos/<slug>/codex/
projetos/<slug>/chatgpt/
```

### Atualização simples

Quando a fonte central já estiver correta e o objetivo for apenas atualizar este repositório local, siga:

```text
SYNC_FROM_PROJETOS_GPT.md
```

### Ciclo completo

Quando o Ralph pedir para comparar o ambiente atual, atualizar a fonte central e depois alinhar o repositório local e o Projeto do ChatGPT, siga:

```text
MAINTAIN_PROJETOS_GPT.md
```

Nesse ciclo:

- inventarie primeiro;
- classifique conteúdo geral e específico;
- atualize o `Projetos_Gpt` antes de propagar;
- não altere código da aplicação;
- atualize o Projeto do ChatGPT somente quando houver capacidade de escrita e verificação;
- sem acesso à interface, produza pacote manual exato e não alegue conclusão.

Caminhos gerais gerenciados podem ser substituídos:

```text
AGENTS.md
BOOTSTRAP_PROJETO_VAZIO.md
MAINTAIN_PROJETOS_GPT.md
SYNC_FROM_PROJETOS_GPT.md
.agents/skills/
docs/ai/*.md
templates/eslint/
scripts/bootstrap-projetos-gpt.ps1
scripts/sync-projetos-gpt.ps1
```

Quando um slug é informado, também podem ser gerenciados:

```text
AGENTS-PROJECT.md
docs/ai/project/*.md
docs/ai/project/codex/*.md
```

Preserve sempre o código da aplicação e arquivos fora dos caminhos gerenciados.

Não misture sincronização ou manutenção da base com feature, bugfix, migration ou refatoração.

Os arquivos sincronizados são cópias gerenciadas. Mudanças duráveis devem ser feitas no `Projetos_Gpt` e depois sincronizadas, salvo autorização explícita em sentido diferente.

## Entrega final

Use estado explícito:

```text
Estado: concluído | parcialmente concluído | bloqueado | falhou
```

Informe:

- resumo;
- escopo implementado;
- arquivos alterados;
- validações executadas e não executadas;
- critérios de aceite;
- riscos e pendências;
- branch, commit, remoto e `git status --short`;
- próximo passo sugerido.

Não declare conclusão total com critério obrigatório pendente. Não simule sucesso.