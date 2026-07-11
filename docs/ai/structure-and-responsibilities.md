# Estrutura de Pastas e Separação de Responsabilidades

Este documento orienta o Codex a manter projetos fáceis de evoluir, revisar e refatorar com IA. Ele define uma estrutura preferida, mas não autoriza reestruturações amplas sem diagnóstico e aprovação.

## Regra principal

A estrutura deve ajudar humanos e agentes de IA a encontrar rápido:

- onde fica a regra de negócio;
- onde ficam as telas;
- onde ficam contratos/tipos/schemas;
- onde ficam integrações externas;
- onde ficam testes;
- onde ficam decisões e validações.

Comece simples. Evolua por necessidade real. Preserve o padrão existente em projetos antigos até haver plano de migração.

---

## Estrutura raiz preferida para aplicações completas

Para projetos full-stack com API separada:

```text
project-root/
  AGENTS.md
  README.md
  docs/
    ai/
      project-context.md
      architecture.md
      structure-and-responsibilities.md
      reuse-and-maintainability.md
      tech-recommendations.md
      validation.md
      decision-log.md
  backend/
  frontend/
```

Adicionar somente quando existir necessidade real:

```text
project-root/
  mobile/          # React Native/Expo quando web/PWA não atender
  infra/           # Docker, deploy, IaC, scripts de ambiente
  scripts/         # automações locais versionáveis
  e2e/             # Playwright na raiz quando cobrir fluxo full-stack
```

Evite criar pastas preventivas vazias.

---

## Responsabilidades por área

### Raiz

Responsável por coordenação do projeto:

- scripts de execução full-stack;
- Playwright/E2E quando for transversal;
- documentação global;
- instruções para agentes;
- lockfile do npm quando houver pacote na raiz.

A raiz não deve virar lugar para lógica de negócio.

### Backend

Responsável por:

- regra de negócio;
- autorização e permissões reais;
- validação crítica;
- persistência;
- transações;
- integrações externas;
- autenticação;
- webhooks;
- auditoria;
- jobs/filas;
- uploads/storage;
- eventos em tempo real originados por regra de negócio.

O backend é a fonte de verdade. O frontend nunca deve ser a única barreira de segurança.

### Frontend

Responsável por:

- experiência do usuário;
- rotas/telas;
- formulários e validação de UX;
- estado de interface;
- consumo de API;
- cache de dados com TanStack Query;
- feedback visual;
- componentes reutilizáveis.

O frontend pode esconder/desabilitar ações por permissão, mas a proteção real deve existir no backend.

### Mobile

Responsável por:

- recursos nativos quando web não atende;
- câmera;
- localização em segundo plano;
- push notification confiável;
- UX mobile instalada.

Criar `mobile/` somente quando houver requisito real para React Native/Expo.

### Banco de dados

Responsável por:

- integridade;
- relações;
- constraints;
- índices;
- histórico/auditoria quando necessário;
- migrations versionadas.

Não tratar Prisma schema apenas como detalhe técnico. Ele é parte do contrato do domínio.

---

## Backend modular recomendado

Preferir módulos por domínio/capacidade, não pastas globais por tipo técnico.

### Estrutura rasa inicial

```text
backend/src/
  app.ts
  server.ts
  config/
  shared/
  modules/
    orders/
      CreateOrderController.ts
      CreateOrderService.ts
      UpdateOrderStatusService.ts
      OrderRepository.ts
      order.routes.ts
      order.schemas.ts
      order.types.ts
      order.policy.ts
      order.test.ts
```

### Convenções de responsabilidade no backend

```text
*Controller.ts
  Camada HTTP. Lê request, chama schema/service e devolve response. Não contém regra de negócio pesada.

*Service.ts
  Caso de uso/regra de negócio. Orquestra validação de domínio, repository, transações, eventos, jobs e integrações.

*Repository.ts
  Acesso ao banco. Não contém regra de negócio de fluxo; deve ser previsível e testável.

*.routes.ts
  Registro das rotas do módulo.

*.schemas.ts
  Schemas Zod de input/output quando aplicável.

*.types.ts
  Tipos locais do módulo quando não forem derivados diretamente dos schemas.

*.policy.ts
  Regras de autorização/permissão do módulo.

*.test.ts
  Testes próximos ao módulo quando o projeto usa co-location.
```

### Quando permitir subpastas no backend

Se o módulo ficar grande demais, permitir subpastas locais:

```text
backend/src/modules/orders/
  controllers/
  services/
  repositories/
  schemas/
  policies/
  tests/
```

Só fazer isso quando houver volume real. Não migrar por estética.

### O que evitar no backend

```text
backend/src/controllers/
backend/src/services/
backend/src/repositories/
```

Essas pastas globais podem ser usadas em projetos legados, mas em projetos novos/modulares tendem a espalhar domínio e dificultar manutenção com IA.

---

## Frontend modular recomendado

Preferir organização por fluxo/tela/domínio.

### Estrutura inicial

```text
frontend/src/
  app/
    App.tsx
    router.tsx
    queryClient.ts
  shared/
    api/
    ui/
    utils/
    config/
  modules/
    orders/
      OrdersPage.tsx
      OrderDetailsPage.tsx
      OrderForm.tsx
      orderApi.ts
      orderQueries.ts
      orderMutations.ts
      orderSchemas.ts
      orderTypes.ts
```

### Convenções de responsabilidade no frontend

```text
*Page.tsx
  Página/rota. Composição de layout, hooks e componentes. Evitar regra de negócio pesada.

*Form.tsx
  Formulário do módulo. Usar React Hook Form + Zod quando for formulário relevante.

*Api.ts
  Funções cruas de chamada HTTP. Não guardar estado de UI aqui.

*Queries.ts
  Hooks de TanStack Query para leitura/cache.

*Mutations.ts
  Hooks de TanStack Query para criação/edição/ações e invalidação.

*Schemas.ts
  Schemas Zod do frontend quando necessário.

*Types.ts
  Tipos do módulo. Preferir derivar de schemas/contratos quando possível.
```

### Quando usar `_components/` e `_hooks/`

Use subpastas locais quando um módulo crescer:

```text
frontend/src/modules/orders/
  OrdersPage.tsx
  _components/
    OrderCard.tsx
    OrderStatusBadge.tsx
  _hooks/
    useOrderFilters.ts
  orderApi.ts
  orderQueries.ts
  orderMutations.ts
  orderSchemas.ts
  orderTypes.ts
```

Use `_components/` para componentes que pertencem ao módulo. Só mova para `shared/ui/` quando houver reutilização real em mais de um módulo.

---

## `shared/` não é lixeira

Use `shared/` apenas para coisas realmente compartilhadas.

Antes de colocar algo em `shared/`, o Codex deve verificar:

1. Mais de um módulo usa isso agora?
2. O nome é genérico e claro?
3. A API é estável o suficiente?
4. Não seria melhor deixar local por enquanto?

Regra prática:

```text
Usado por 1 módulo → manter local.
Usado por 2+ módulos → considerar shared.
Usado por todo app → shared/config, shared/api, shared/ui ou shared/utils.
```

---

## Contratos backend/frontend

Quando houver backend e frontend separados:

- backend valida input com Zod;
- frontend pode espelhar schemas quando fizer sentido;
- contratos importantes devem ter nomes consistentes;
- mudanças de contrato devem tocar backend, frontend e testes quando necessário;
- não alterar contrato silenciosamente.

Preferência:

```text
backend/src/modules/orders/order.schemas.ts
frontend/src/modules/orders/orderSchemas.ts
frontend/src/modules/orders/orderTypes.ts
```

Para projetos maiores, avaliar geração/compartilhamento de contratos, mas não criar pacote compartilhado cedo demais.

---

## Projetos simples

Se o projeto for apenas uma página ou protótipo:

```text
project-root/
  AGENTS.md
  docs/ai/
  frontend/
```

Não criar backend, banco, Prisma, autenticação ou Playwright até haver necessidade real.

---

## Projetos antigos/legados

Ao adicionar este kit em um projeto antigo:

1. Não reorganizar tudo automaticamente.
2. Auditar estrutura real.
3. Identificar padrões já existentes.
4. Mapear duplicações e riscos.
5. Propor migração incremental.
6. Aplicar novo padrão apenas em arquivos novos ou áreas que estiverem sendo alteradas.
7. Refatorar em etapas pequenas quando houver ganho claro.

Reestruturação ampla só deve ser proposta quando:

- o projeto é pequeno;
- os testes/validações dão segurança;
- o acoplamento atual está bloqueando evolução;
- o usuário autorizou explicitamente.

---

## Critério para o Codex decidir entre manter, adaptar ou reestruturar

```text
Manter:
- padrão existente é claro;
- mudança pedida é pequena;
- reestruturação aumentaria risco.

Adaptar:
- existe algo parecido;
- dá para melhorar sem quebrar contrato;
- nova funcionalidade pode seguir padrão próximo.

Reestruturar incrementalmente:
- há duplicação clara;
- o módulo virou difícil de manter;
- a mudança atual já toca a área afetada;
- existem validações suficientes.

Reestruturar amplamente:
- somente com diagnóstico, plano e autorização.
```

---

## Regra final

A melhor estrutura é a que reduz confusão, duplicação e acoplamento. Para IA, nomes explícitos, módulos pequenos e responsabilidades claras são mais importantes do que arquitetura sofisticada.
