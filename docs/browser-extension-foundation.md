# Fundação da extensão Chromium (Manifest V3)

## Arquitetura de produto

```text
GPT personalizado → Instructions + Knowledge + App MCP → narrativa e interpretação
Extensão → frontend principal → botão flutuante + overlay + página própria
Backend → regras, identidade, autorização e persistência autoritativas
Widget → fallback leve e diagnóstico
```

O shell da extensão é uma superfície nova e isolada em `extension/`. A UI vive
uma única vez em `GameApp` React e é montada pelos três hosts. Ela não
reutiliza código do `widget/`, pois aquele pacote é acoplado ao App SDK do
ChatGPT. Ambos podem compartilhar no futuro apenas contratos públicos e
projeções autorizadas pelo backend, quando existir uma necessidade real.

## Contextos e comunicação

```text
GameApp React compartilhada
  ├─ host web local (Vite + HMR)
  ├─ content script (host ChatGPT) → Shadow DOM → launcher + overlay
  └─ page.html → página própria

content script e page
  └─ mensagens tipadas ↔ service worker

service worker
  ├─ chrome.storage.local → preferências visuais
  └─ chrome.tabs.create → page.html

page.html
  └─ mesmo shell + mensagens tipadas ↔ service worker
```

As mensagens aceitas são `OPEN_OVERLAY`, `CLOSE_OVERLAY`, `MINIMIZE`,
`OPEN_PAGE`, `GET_PREFERENCES`, `SAVE_PREFERENCES` e `PING`. O service worker
rejeita objetos fora desse schema fechado. A página hospedeira não participa
desse canal e não há listener de `postMessage`.

## Isolamento, permissões e CSP

O content script é estático, executa no mundo isolado padrão e monta um único
host `#cronicas-extension-root` com Shadow DOM. Seus estilos vivem dentro da
raiz e não há CSS global injetado. Ele apenas cria host, ShadowRoot e root para
montar React; não contém regras visuais. O script não consulta transcript,
composer, cookies, storage da página, tokens, rede ou APIs internas.

| Controle | Configuração |
| --- | --- |
| Manifest | V3 |
| Permissão | Somente `storage` |
| Hosts | `chatgpt.com` e `chat.openai.com` por HTTPS |
| CSP das páginas | `script-src 'self'; object-src 'self'; base-uri 'self';` |
| Recursos web acessíveis | Nenhum |
| Rede/OAuth | Nenhuma |

`tabs` não é solicitado: a extensão somente usa `chrome.tabs.create` para
abrir a própria página e não lê URLs, título ou conteúdo de abas. Permissões
invasivas, host amplo, OAuth, backend e tempo real são fases separadas.

## UX e acessibilidade

O overlay ocupa a viewport com `position: fixed` e possui scroll interno. O
botão tem label, tooltip, estado expandido e foco visível. Ao abrir, o foco vai
para Fechar; `Escape`, Fechar e Minimizar restauram o foco ao launcher. Um
loop de Tab opera apenas enquanto o overlay está aberto e pode ser desfeito por
`Escape`, evitando que o host fique permanentemente preso.

O shell é responsivo entre 320 px e desktop amplo, respeita
`prefers-reduced-motion`, usa controles nativos e expõe mudanças de aba em uma
região `aria-live`. Mapa e Combate indicam explicitamente que ainda não estão
disponíveis.

## Dados e limitações

`DEMO_CHARACTER` é uma fixture TypeScript local, limitada a recursos,
atributos, três itens, um equipamento e três habilidades sintéticas. Ela não é
estado oficial e `chrome.storage.local` guarda apenas preferências visuais:
posição do botão, último modo, aba ativa e preferência de movimento.

Não há persistência mecânica, dados reais, tokens, identidade, OAuth, API,
MCP, WebSocket, SSE, polling ou ação real. Uma futura integração deverá derivar
o usuário exclusivamente da identidade verificada pelo backend e respeitar
`GameSession`, seleção autorizada e projeções read-only já documentadas.

## Ambientes

O host web local Vite é o ambiente principal de desenvolvimento rápido. Ele
monta a mesma `GameApp` sem APIs Chrome e persiste somente preferências visuais
em armazenamento local do navegador. Não é produto publicado, não usa backend,
OAuth, CORS remoto, segredo ou dados reais. `npm run dev:web --prefix
extension` oferece HMR; `build:web` produz somente `extension/dist-web/`.

`PlatformAdapter` mantém chamadas Chrome dentro da camada de plataforma: o
adapter web não depende da extensão, e o adapter da extensão reutiliza as
mensagens e preferências visuais existentes. A página própria omite controles
sem ação válida.

Nesta fundação o pacote é deliberadamente igual nos ambientes locais, staging
e produção futura: não há URL de backend, segredo ou configuração privada no
manifest. O desenvolvimento local usa a pasta `dist/` carregada como extensão
descompactada. Staging e produção futura deverão introduzir somente uma
configuração pública, revisada e versionada para apontar ao backend autorizado;
nunca tokens, client secrets ou URLs privadas no manifest.

## Validação e carga local

Os testes unitários cobrem fixture, preferências, schema de mensagens e modos.
Os testes DOM com jsdom cobrem reinjeção sem duplicação, Shadow DOM, preservação
do DOM hospedeiro, abertura/fechamento/minimização, `Escape`, foco e shell de
página própria. A integração em Chromium com uma página fixture local continua
um teste manual de carregamento descompactado, pois não há Playwright instalado
no monorepo.

```powershell
npm run lint:extension
npm run typecheck:extension
npm run test:extension
npm run build:extension
npm run validate:extension-manifest
```

Depois de `npm run build:extension`, carregue `extension/dist` como extensão
descompactada em `chrome://extensions`. Não é necessário instalar
permanentemente no navegador de Ralph para esta fundação.

## OAuth próprio da extensão — Extensão 2B

A extensão é um cliente OAuth público independente do App MCP. O fluxo é
Authorization Code com PKCE S256: o service worker gera state e verifier,
abre chrome.identity.launchWebAuthFlow, valida o callback exato de
chrome.identity.getRedirectURL('oauth2') e troca o código sem client secret.
Tokens nunca entram no DOM, content script ou mensagens React.

O service worker retém access token somente em memória. Antes de qualquer
leitura ou gravação de credencial, ele restringe `chrome.storage.local` a
`TRUSTED_CONTEXTS`; se isso falhar, encerra a recuperação de sessão. Para
sobreviver à suspensão MV3, somente o refresh token rotativo é mantido nesse
storage; state, code e verifier vivem apenas durante a transação. Logout e
refresh inválido removem a credencial local. O provedor atual não expõe um
endpoint OAuth de revogação para este cliente público; a expiração curta do
access token e a rotação/revogação de refresh do provedor limitam a sessão.
A UI recebe apenas `PublicAuthState`.

O backend publica configuração pública sem segredo em /extension/oauth-config
e protege /extension/session com audience própria, distinta de /mcp-auth. A
configuração exige client allowlisted, redirect Chromium exata, issuer/JWKS,
scopes mínimos e CORS limitado ao origin exato da extensão. A policy OAuth
existente mapeia o client da extensão para essa audience; não há migration
adicional.

O manifest adiciona somente identity e o host HTTPS exato do backend staging.
O host web continua em estado desconectado determinístico e não chama
chrome.* nem OAuth real.

Depois de cada mudança de sessão o worker publica somente
`AUTH_STATE_CHANGED` com `PublicAuthState`; overlay e página própria se
inscrevem no evento e também consultam `AUTH_GET_STATE` ao montar. A mensagem
é validada de forma estrita e não comporta token, código ou cabeçalho.
