# Crônicas de Outro Mundo

Nova plataforma do RPG narrativo **Crônicas de Outro Mundo**. O runtime ativo é uma API Node.js + TypeScript em `backend/`; a implementação Supabase/GPT Actions anterior foi descontinuada e removida do repositório.

## Arquitetura ativa

- Express expõe a API HTTP e Zod valida configuração e entradas.
- Prisma Client 7 acessa PostgreSQL pelo adapter oficial `@prisma/adapter-pg`; Prisma Migrate é a única autoridade do novo schema.
- Supabase pode hospedar o PostgreSQL, mas somente o backend recebe credenciais privilegiadas.
- `x-rpg-key` protege temporariamente `/api/v1`; `/health`, `/health/ready` e `/openapi.json` são públicos e não revelam infraestrutura.
- O GPT usa a API Node para leitura e persistência; o frontend continua adiado e sempre chamará o backend.

## Estrutura

```text
backend/                  API, Prisma, seed e testes
gpt/                      OpenAPI, instruções e Knowledge ativos
docs/ai/                  contexto, arquitetura e decisões ativas
render.yaml               Blueprint nativo Node, sem Docker
```

## Preparação no Windows/PowerShell

```powershell
npm install
npm install --prefix backend
Copy-Item backend/.env.example backend/.env
```

Preencha o `.env` local sem versioná-lo. `DATABASE_URL` é a conexão de runtime, `DIRECT_URL` é reservada para migrations, `RPG_API_KEY` é a chave interna temporária e `PUBLIC_BASE_URL` será a URL HTTPS pública usada no OpenAPI servido.

```powershell
npm run prisma:generate
npm run dev
```

## Validação

```powershell
npm test                  # suíte rápida: unitários + HTTP em memória
npm run test:unit         # equivalente explícito da suíte rápida
npm run test:integration  # recria somente game_gpt_test, migra, semeia e testa
npm run test:all          # suíte rápida + integração
npm run prisma:validate
npm run lint
npm run typecheck
npm run build
```

### Estratégia de testes do backend

- Unitários validam schemas Zod, configuração, segurança, services e transformações sem PostgreSQL ou Prisma real.
- HTTP usa Supertest sobre o app Express em memória, com repositories injetados; `server.ts` não é importado, nenhuma porta é aberta.
- Integração usa o fluxo real Express → services → repositories → Prisma → PostgreSQL somente quando migration, seed, query, constraint, índice ou relação são relevantes.

O PostgreSQL local deve estar em execução. Desenvolvimento usa `game_gpt_dev`; testes de integração usam exclusivamente `game_gpt_test`. Docker e banco remoto não fazem parte desse fluxo. No `.env` ignorado, `TEST_DATABASE_URL`, `TEST_DIRECT_URL` e `TEST_RPG_API_KEY` podem definir a configuração de teste. Se as URLs de teste forem omitidas, a automação deriva `game_gpt_test` apenas de uma URL local existente e ainda aplica todas as proteções. Nunca documente ou versione valores reais.

A preparação recusa produção, host diferente de `localhost`/`127.0.0.1`, banco diferente de `game_gpt_test`, URL igual a `DATABASE_URL` e destinos conhecidos como Supabase ou Render. Em caso de falha, nenhum SQL destrutivo é iniciado e a URL não é exibida.

No Windows/PowerShell, se a integração não iniciar, confirme que o serviço PostgreSQL está ativo, que o usuário local pode criar bancos e que as variáveis estão no `backend/.env`. Execute o comando pela raiz ou por `npm run test:integration --prefix backend`; não use `server.ts` nem inicie a API manualmente. Testes manuais endpoint a endpoint são exceção para investigação focal, não o fluxo normal de validação.

Para preparar uma migration offline a partir do schema, sem aplicar ao banco:

```powershell
$env:DATABASE_URL='postgresql://user:password@localhost:5432/placeholder'
npx --prefix backend prisma migrate diff --from-empty --to-schema backend/prisma/schema.prisma --script
```

A migration inicial já está versionada em `backend/prisma/migrations/`. Nenhuma migration ou seed foi aplicado remotamente. O seed de desenvolvimento pode ser executado conscientemente com `npm run prisma:seed --prefix backend` apenas contra um banco seguro configurado.

### Banco local de desenvolvimento

O banco PostgreSQL local `game_gpt_dev` existe, recebeu a migration inicial e o seed de desenvolvimento. Ele não contém dados de produção. As credenciais permanecem exclusivamente na configuração local ignorada pelo Git.

## API GPT v1 e idempotência

O contrato oficial ativo é `gpt/openapi.json` e também é servido em `GET /openapi.json`. A API carrega campanha, lista/cria/atualiza atores, cria definições de conteúdo, gerencia vínculos/progressão e registra eventos. Escritas usam `idempotencyKey`; a reserva, a mudança e a resposta são persistidas na mesma transação em `IdempotencyRecord`. Repetição idêntica devolve a resposta salva e reutilização incompatível retorna `409`.

Para configurar o GPT no navegador, siga `gpt/README.md` depois que a API estiver publicada e validada.

## Produção futura: GitHub → Render → Supabase

`render.yaml` prepara um serviço web Node nativo, build/start reproduzíveis, auto-deploy desligado e health check em `/health/ready`. Antes de sincronizar o Blueprint, escolha a branch de produção e o plano. O `preDeployCommand` aplica `prisma migrate deploy`; como esse recurso exige serviço pago, em plano sem suporte execute conscientemente `npm run prisma:migrate:deploy` como tarefa one-off com `DIRECT_URL` antes do primeiro deploy.

No Supabase, crie futuramente um usuário PostgreSQL específico para Prisma com senha forte gerada. Use `DATABASE_URL` no runtime (Supavisor Session mode quando apropriado) e `DIRECT_URL` para migrations. Guarde URLs e `RPG_API_KEY` somente como secrets do Render. A migration incremental habilita RLS sem policies para `anon`/`authenticated` e revoga acesso desses papéis condicionalmente, preservando proprietário/migration role. Não desligue a Data API nem altere objetos legados por esse fluxo.

O usuário usado em `DIRECT_URL` deve aplicar as migrations e permanecer proprietário das tabelas da plataforma Node; `DATABASE_URL` deve autenticar esse mesmo papel. Como não há `FORCE ROW LEVEL SECURITY`, o proprietário opera intencionalmente sem policies, enquanto papéis não proprietários ficam bloqueados na ausência delas. Não configure o runtime com `anon`, `authenticated` ou outro papel sem propriedade/bypass deliberado.

Prisma Migrate não gera down migration automática. Para rollback de aplicação, reverta o código e prefira uma migration corretiva posterior. Reverter esta migration no banco exigiria desabilitar RLS nas oito tabelas e remover `IdempotencyRecord`; essa remoção apaga o histórico de idempotência e só pode ocorrer após backup e decisão explícita. Em produção, o rollback seguro padrão é preservar a tabela e os controles de acesso.

## Escopo atual e próximas fases

Existem health/readiness, leituras normalizadas e persistência mínima do GPT. Ainda não existem frontend, autenticação pública, combate avançado, inventário físico, buffs/debuffs, comércio, lojas, viagens, CORS, rate limit ou observabilidade externa. Antes do deploy, ainda é necessário escolher branch/plano/região no Render, criar credencial Prisma no Supabase, definir secrets, revisar backup/rollback e executar a migration remota em janela controlada.
