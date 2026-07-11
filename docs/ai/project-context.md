# Contexto do projeto — Crônicas de Outro Mundo

## Classificação e objetivo

Projeto de RPG narrativo reiniciado como nova versão, com o sistema anterior arquivado. O objetivo atual é oferecer uma API segura e reproduzível para estado de mundos, campanhas, atores e conteúdo mecânico, consumida futuramente pelo GPT e por um frontend.

## Decisões aprovadas

- npm, Node.js, TypeScript, Express, Zod, PostgreSQL e Prisma.
- `backend/` é a camada principal; `frontend/` só será criado em fase própria.
- Prisma Migrate é a única autoridade do novo schema.
- Supabase é inicialmente apenas provedor PostgreSQL hospedado.
- Frontend e GPT nunca acessam Prisma, tabelas ou credenciais privilegiadas diretamente.
- O sistema antigo não será migrado automaticamente.

## Implementação atual

- API somente de leitura com healthcheck e módulos de atores, personagens e conteúdo.
- Chave interna temporária `x-rpg-key` em `/api/v1`.
- Schema inicial, migration offline e seed de desenvolvimento idempotente.

## Decisões pendentes

- Autenticação pública, identidade e autorização por usuário.
- Política de CORS, rate limit, auditoria e observabilidade antes de deploy.
- Estratégia final de deploy e configuração de conexão Supabase.

## Fases futuras

Frontend React, integração GPT, combate, inventário físico, comércio, equipamentos por slot, efeitos, lojas, facções, relações, memórias detalhadas, viagens, clima e snapshots.

## Segurança

Não há credenciais de usuário no modelo `Player`. Nenhum secret deve ser versionado ou registrado. Banco remoto não é alterado automaticamente, migrations não rodam no startup e o backend é a única fronteira autorizada para acesso privilegiado.
