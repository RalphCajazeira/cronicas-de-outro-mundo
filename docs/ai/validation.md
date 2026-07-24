# Validação, Evidências, Commit e Push

## Regra principal

Use comandos reais do projeto. Não invente scripts.

Antes de rodar um script, confira `package.json`, documentação ou instruções do projeto quando isso ainda não estiver confirmado no contexto da mesma task.

Na continuação da mesma task, não releia arquivos por rotina. Reconfirme apenas o que puder ter mudado, estiver incerto ou for necessário para a próxima etapa.

## Validação proporcional ao risco

### Risco baixo

- validação localizada;
- `git diff --check`;
- script diretamente afetado, quando existir.

### Risco moderado

- lint;
- typecheck;
- testes unitários ou de integração do módulo;
- build quando a mudança puder afetá-lo.

### Risco alto

- todas as validações aplicáveis;
- integração PostgreSQL quando houver banco;
- contratos e compatibilidade;
- E2E ou CI quando fizerem parte do escopo;
- revisão de migration e reversibilidade.

### Risco crítico

- validações completas aplicáveis;
- cenários negativos e de falha;
- idempotência, concorrência, rollback ou compensação;
- evidência de ambiente e dados;
- revisão explícita de segurança e efeitos externos;
- nenhuma operação remota ou destrutiva sem autorização.

## ESLint

Para projetos JavaScript/TypeScript, ESLint é a validação padrão de qualidade de código.

Preferir:

```text
eslint.config.js ou eslint.config.mjs
```

Scripts recomendados quando aplicável:

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix"
  }
}
```

Em monorepo, cada pacote pode ter seu próprio `lint`, e a raiz pode orquestrar.

Em projeto legado, adicionar ESLint primeiro com regras recomendadas e baixo risco. Endurecer regras em etapas posteriores.

## Validações comuns

Quando existirem:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## Projetos com backend/frontend

Quando existirem scripts por pasta:

```bash
npm run lint --prefix backend
npm run typecheck --prefix backend
npm run test --prefix backend
npm run build --prefix backend

npm run lint --prefix frontend
npm run typecheck --prefix frontend
npm run test --prefix frontend
npm run build --prefix frontend
```

Não executar comandos inexistentes. Diagnosticar os scripts reais antes de substituir ou inventar comandos.

## E2E

Playwright deve ser usado para fluxos críticos, não para tudo.

Antes de rodar E2E, verificar:

- banco de teste;
- fixtures;
- serviços necessários;
- variáveis de ambiente;
- custo de tempo;
- se o escopo exige E2E;
- se a execução pode produzir efeito externo.

## Falhas e condições de parada

Pare a sequência de validações quando uma falha tornar as próximas etapas inválidas.

Não continue para commit, push, deploy ou migration remota quando houver:

- teste obrigatório falhando;
- working tree inesperadamente suja;
- arquivo inesperado no diff;
- secret ou configuração ausente;
- risco de dados;
- contrato incompatível;
- efeito externo não autorizado;
- migration destrutiva sem confirmação.

Relate a condição de parada e o último estado confirmado.

## Retry

Não repetir automaticamente operação com efeito externo.

Antes de retry, classificar:

- falha transitória;
- falha determinística;
- efeito possivelmente aplicado;
- estado desconhecido.

Em retry exato, preservar payload, parâmetros e chave de idempotência quando aplicável.

Não alterar silenciosamente dados para “fazer passar”.

## Contrato de evidência

Para cada validação executada, informar quando aplicável:

```text
Comando: ...
Resultado: passou | falhou | bloqueado
Exit code: ...
Quantidade de testes: ...
Duração relevante: ...
Observação: ...
```

Não afirmar que uma validação passou se ela não foi executada na task atual ou se a única evidência for um relatório antigo.

Se uma validação não for executada, informar o motivo.

## Critérios de aceite

A entrega deve mapear os critérios de aceite:

```text
- [x] critério atendido com evidência
- [ ] critério pendente e motivo
```

Uma tarefa é `concluída` somente quando todos os critérios obrigatórios estiverem atendidos.

Quando houver pendência obrigatória, usar `parcialmente concluído`, `bloqueado` ou `falhou`.

## Antes de commit

Nunca commit sem autorização explícita.

Antes de pedir autorização ou preparar commit:

```bash
git status --short
git diff --name-only
git diff --check
```

Também confirmar:

- arquivos esperados e inesperados;
- ausência de secrets;
- escopo limpo;
- validações exigidas pelo risco;
- critérios de aceite.

Depois de autorização:

```bash
git add -A
git status --short
git diff --cached --name-status
git diff --cached --check
git commit -m "mensagem"
```

Depois do commit:

```bash
git rev-parse HEAD
git branch --show-current
git show --name-status --format="" HEAD
git status --short
```

Informe hash completo quando o fluxo exigir comparação local/remota.

## Antes de push

Nunca push sem autorização explícita.

Confirmar:

```bash
git status --short
git branch --show-current
git log -1 --oneline
```

Só fazer push se:

- branch e commit estiverem corretos;
- working tree estiver limpa;
- não houver force push não autorizado;
- o remoto e a base estiverem corretos.

Depois do push, quando aplicável, compare o hash local e remoto.

## O que nunca deve entrar no commit

- `.env` real;
- secrets;
- dumps de banco;
- logs;
- screenshots;
- vídeos;
- uploads locais;
- arquivos temporários;
- artefatos de build não versionados pelo projeto;
- lockfile de outro package manager.

## Formato final

```text
Estado: concluído | parcialmente concluído | bloqueado | falhou

Validações executadas:
- ...

Validações não executadas:
- ... motivo ...

Critérios de aceite:
- [x] ...
- [ ] ...

Git:
- branch: ...
- commit: ...
- remoto: ...
- working tree: ...

Riscos e pendências:
- ...
```

Não transformar sucesso parcial em conclusão total.