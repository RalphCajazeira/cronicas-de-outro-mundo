# Migração de Projetos Antigos/Legados

## Regra principal

Não reestruture tudo automaticamente.

Primeiro descubra o estado real. Depois proponha plano incremental.

## Auditoria inicial sem alteração

Quando este kit for adicionado a um projeto antigo, a primeira task do Codex deve ser somente leitura.

Diagnosticar:

- stack;
- package manager;
- scripts;
- estrutura de pastas;
- banco/ORM;
- validação;
- autenticação;
- testes;
- duplicações;
- riscos;
- arquivos sensíveis;
- padrões existentes;
- oportunidades de migração.

## Estratégias possíveis

### Migração gradual

Padrão recomendado.

- Preservar comportamento atual.
- Corrigir/reestruturar apenas áreas tocadas por novas tarefas.
- Criar docs/ai sem mover código desnecessariamente.
- Evitar PRs gigantes.

### Reestruturação ampla

Só considerar quando:

- projeto é pequeno;
- não está em produção;
- testes ou validação manual são viáveis;
- arquitetura atual bloqueia manutenção;
- usuário autorizou explicitamente;
- plano de rollback está claro.

## Como migrar gradualmente

1. Adicionar `AGENTS.md` e `docs/ai`.
2. Auditar projeto.
3. Preencher `project-context.md`.
4. Documentar arquitetura atual.
5. Padronizar validações.
6. Em cada feature nova, procurar padrões existentes.
7. Quando encontrar duplicação, propor extração pequena.
8. Atualizar `decision-log.md` para decisões relevantes.

## O que evitar

- Reescrever sistema sem necessidade.
- Trocar stack por preferência.
- Introduzir dependências novas durante refactor sem justificativa.
- Misturar feature, bugfix e migração estrutural grande.
- Quebrar rotas/contratos existentes sem plano.
