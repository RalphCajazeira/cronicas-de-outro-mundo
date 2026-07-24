# Recomendações Técnicas por Cenário

Este arquivo é uma prateleira de tecnologias. Não instale tudo preventivamente.

Antes de adicionar qualquer tecnologia, o Codex deve justificar necessidade, alternativas, impacto e pedir autorização, salvo se o prompt já autorizou.

## Base preferida para sistemas completos

```text
Frontend:
- Vite
- React
- React Router
- TanStack Query
- React Hook Form
- Zod
- Tailwind CSS
- shadcn/ui
- ESLint com flat config
- Vitest
- Testing Library

Backend:
- Node.js
- TypeScript
- Express
- Prisma
- PostgreSQL
- Zod
- jose para OAuth/JWT/JWKS
- ESLint com flat config
- Vitest
- Supertest

Raiz:
- npm
- concurrently quando houver backend + frontend
- Playwright para E2E crítico
```

## Qualidade de código e lint

Padrão para projetos JavaScript/TypeScript:

```text
ESLint com flat config
```

Preferências:

```text
Base JS/TS: eslint + @eslint/js + typescript-eslint
Node/backend: globals quando necessário
React/Vite: eslint-plugin-react-hooks e eslint-plugin-react-refresh
React opcional: eslint-plugin-react quando o projeto precisar de regras JSX/React além dos hooks
```

Regras:

- ESLint deve entrar cedo em projeto novo JavaScript/TypeScript.
- Em projeto legado sem lint, adicionar ESLint em task própria e pequena antes de grandes refactors.
- Não misturar instalação/configuração de ESLint com feature de negócio, salvo autorização explícita.
- Usar `eslint.config.js` ou `eslint.config.mjs` no formato flat config.
- Adicionar script `lint` no `package.json` do escopo afetado.
- Não ativar regras extremamente rígidas de uma vez em projeto legado; começar com configuração recomendada e endurecer gradualmente.
- Se o projeto já usa outro linter ou formatter, diagnosticar antes de trocar.

## Banco e ORM

Padrão:

```text
PostgreSQL + Prisma
```

Só avaliar Drizzle/Kysely quando houver motivo real: SQL muito específico, performance, controle fino de query ou requisito técnico claro.

## Autenticação

```text
OAuth/JWT/JWKS/OIDC: jose
Senha local simples: bcryptjs ou argon2, conforme decisão do projeto
Next.js com provedores prontos: avaliar Auth.js
```

Antes de implementar auth, decidir:

- sessão vs token;
- cookie httpOnly vs armazenamento no cliente;
- refresh token;
- expiração;
- logout;
- proteção CSRF/CORS;
- provedores;
- auditoria.

## Tempo real

```text
Socket.IO
```

Usar para:

- pedido novo em tempo real;
- status de pedido;
- chat;
- presença online;
- localização ao vivo;
- painel administrativo em tempo real.

Se for apenas servidor → cliente, Server-Sent Events pode ser avaliado.

Em múltiplas instâncias, usar adapter Redis.

## Filas e jobs

```text
BullMQ + Redis
```

Usar para:

- envio de e-mail;
- processamento de imagem;
- geração de PDF;
- webhooks;
- retries;
- relatórios demorados;
- notificações.

Não executar tarefa demorada dentro da request HTTP.

## Cache, sessão e rate limit distribuído

```text
Redis
```

Adicionar quando houver fila, cache real, múltiplas instâncias, sessão compartilhada, locks ou presença.

## E-mail

Preferência inicial:

```text
Resend
```

Alternativas:

```text
Amazon SES, SendGrid, Mailgun
```

E-mail transacional não crítico deve ir para fila.

## WhatsApp/SMS

Usar API oficial ou provedor confiável:

```text
WhatsApp Business Cloud API, Twilio, Zenvia, Take Blip
```

Não usar automação não oficial.

## Pagamentos e assinaturas

Avaliar conforme país/modelo:

```text
Stripe, Mercado Pago, Pagar.me, Asaas, Iugu
```

Regra obrigatória:

```text
Pagamento nunca deve depender só do retorno do frontend.
Confirmação de status financeiro deve passar por webhook backend.
```

## Upload, imagens e arquivos

Desenvolvimento:

```text
Multer + Sharp
```

Produção:

```text
Cloudflare R2, Amazon S3, Supabase Storage
```

Guardar metadados no banco e arquivo no storage.

## PDF, documentos e relatórios

```text
pdf-lib para manipulação simples
Puppeteer ou Playwright PDF quando o layout vier de HTML
exceljs para Excel
CSV simples para exportação leve
```

Relatórios demorados devem usar fila.

## Assinatura de documentos

MVP:

```text
Assinatura eletrônica simples com trilha de auditoria
```

Guardar:

- hash do documento;
- usuário;
- data/hora;
- IP;
- user agent;
- aceite explícito;
- versão do documento;
- arquivo assinado ou evidência.

Para maior robustez:

```text
Clicksign, DocuSign, ZapSign, Gov.br quando aplicável
```

## Reconhecimento facial

Tratar como dado biométrico sensível.

Possibilidades:

```text
Web: MediaPipe ou face-api.js, conforme caso
Mobile: Expo/React Native + câmera
Produção crítica: serviço especializado com liveness/prova de vida
```

Começar, quando possível, com selfie + auditoria antes de biometria automática.

## Geolocalização e entrega

Web com navegador aberto:

```text
Geolocation API + Socket.IO
```

App em segundo plano:

```text
React Native + Expo + Expo Location
```

Mapas:

```text
Leaflet/OpenStreetMap para mapa simples
Google Maps/Mapbox para rotas, ETA, geocoding e distância
```

## Mobile

Preferência:

```text
React Native + Expo
```

Criar `mobile/` apenas quando web/PWA não atender, por exemplo:

- localização em segundo plano;
- câmera/biometria;
- push confiável;
- experiência nativa importante;
- uso offline.

## Push notifications

Web:

```text
Web Push API
```

Mobile Expo:

```text
Expo Notifications
```

## Busca

Começar com PostgreSQL full-text search.

Escalar para:

```text
Meilisearch, Typesense, OpenSearch/Elasticsearch
```

quando busca virar parte central do produto.

## Observabilidade

```text
Pino para logs backend
Sentry para erros em produção
OpenTelemetry quando sistema crescer e precisar tracing
```

## Permissões

Começar com RBAC no banco:

```text
roles, permissions, role_permissions, user_permissions
```

Avaliar CASL apenas se regras ficarem complexas.

Backend sempre valida permissão crítica.

## Multitenancy

Se houver múltiplas empresas/lojas/clientes:

- decidir `tenantId` cedo;
- garantir isolamento no backend;
- criar índices adequados;
- testar vazamento entre tenants;
- documentar modelo em `architecture.md`.

## Feature flags

Adicionar apenas quando houver necessidade de liberar recursos gradualmente.

Possíveis caminhos:

```text
flags no banco, Unleash, LaunchDarkly
```
