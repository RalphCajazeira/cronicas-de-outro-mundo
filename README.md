# Crônicas de Outro Mundo

Nova plataforma do RPG narrativo **Crônicas de Outro Mundo**. O runtime ativo é uma API Node.js + TypeScript em `backend/`; a versão Supabase/GPT Actions anterior está preservada, sem uso automático, em `legacy/supabase-gpt-v1/`.

## Arquitetura ativa

- Express expõe a API HTTP e Zod valida configuração e entradas.
- Prisma Client 7 acessa PostgreSQL pelo adapter oficial `@prisma/adapter-pg`; Prisma Migrate é a única autoridade do novo schema.
- Supabase pode hospedar o PostgreSQL, mas somente o backend recebe credenciais privilegiadas.
- `x-rpg-key` protege temporariamente `/api/v1`; `/health` é público.
- O frontend e a integração do GPT serão adicionados em fases próprias e sempre chamarão o backend.

## Estrutura

```text
backend/                  API, Prisma, seed e testes
docs/ai/                  contexto, arquitetura e decisões ativas
legacy/supabase-gpt-v1/   referência histórica, fora do runtime
```

## Preparação no Windows/PowerShell

```powershell
npm install
npm install --prefix backend
Copy-Item backend/.env.example backend/.env
```

Preencha o `.env` local sem versioná-lo. `DATABASE_URL` é a conexão de runtime, `DIRECT_URL` é reservada para migrations e `RPG_API_KEY` é a chave interna temporária.

```powershell
npm run prisma:generate
npm run dev
```

## Validação

```powershell
npm run prisma:validate
npm run lint
npm run typecheck
npm test
npm run build
```

Para preparar uma migration offline a partir do schema, sem aplicar ao banco:

```powershell
$env:DATABASE_URL='postgresql://user:password@localhost:5432/placeholder'
npx --prefix backend prisma migrate diff --from-empty --to-schema backend/prisma/schema.prisma --script
```

A migration inicial já está versionada em `backend/prisma/migrations/`. Nenhuma migration ou seed foi aplicado remotamente. O seed de desenvolvimento pode ser executado conscientemente com `npm run prisma:seed --prefix backend` apenas contra um banco seguro configurado.

### Banco local de desenvolvimento

O banco PostgreSQL local `game_gpt_dev` existe, recebeu a migration inicial e o seed de desenvolvimento. Ele não contém dados de produção. As credenciais permanecem exclusivamente na configuração local ignorada pelo Git.

## Escopo atual e próximas fases

Existem healthcheck e leituras normalizadas de atores, personagens e conteúdo. Ainda não existem frontend, autenticação pública, combate, inventário físico, comércio, CORS, rate limit ou observabilidade de produção. Essas decisões devem ser tratadas antes do deploy.
