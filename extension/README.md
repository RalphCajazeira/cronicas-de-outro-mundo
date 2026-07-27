# Extensão Chrome — Crônicas de Outro Mundo

## Decisão canônica

```text
Extensão overlay/full-page = frontend principal
Widget = fallback leve e diagnóstico
GPT = narrativa e interpretação
Backend = autoridade futura para regras, autenticação, autorização e persistência
```

Esta fundação MV3 não se conecta ao backend. Ela apresenta exclusivamente uma
fixture sintética local e não lê, observa ou altera conversas, composer,
cookies, tokens, armazenamento da página ou APIs internas do ChatGPT.

## Modos

- **Minimizado:** botão flutuante “Abrir Crônicas”.
- **Overlay:** shell sobre a área visível da página, fechado por botão ou `Escape`.
- **Página própria:** o comando abre `page.html` em uma aba da extensão, usando o mesmo shell.

O content script é declarado estaticamente e limita-se a `chatgpt.com` e
`chat.openai.com`. Ele monta um único host com Shadow DOM aberto e um reset
local; não altera estilos globais nem interpreta o DOM da conversa.

## Permissões e segurança

| Item | Decisão |
| --- | --- |
| `storage` | Persiste somente posição do botão, última visualização, aba ativa e preferência visual. |
| `tabs` | Não solicitado; `tabs.create` abre a página sem conceder leitura de tabs. |
| Hosts | Somente `https://chatgpt.com/*` e `https://chat.openai.com/*`. |
| `web_accessible_resources` | Não necessário: o shell é bundle local e não expõe assets ao host. |
| CSP | `script-src 'self'; object-src 'self'; base-uri 'self';`. |

Não há `<all_urls>`, cookies, `webRequest`, history, clipboard, downloads,
native messaging, debugger ou `scripting`. O service worker não mantém timers,
rede, OAuth ou estado de jogo; ele só valida mensagens internas, gerencia as
preferências visuais e abre a página própria.

## Estrutura e hosts

`src/app/GameApp.tsx` é a única UI do jogo. Ela atende os modos `web`,
`overlay` e `extension-page`; `src/platform/` concentra as diferenças entre
armazenamento local do navegador e APIs Chrome. Componentes React não chamam
`chrome.*` diretamente.

O content script apenas cria o host, o Shadow DOM, o root e monta React. A
página própria monta a mesma aplicação em `page.html`. No host web, a mesma
aplicação usa somente `localStorage` para preferências visuais e não precisa de
extensão, backend, OAuth ou CORS remoto.

## Desenvolvimento web com HMR

```powershell
npm run dev:web --prefix extension
```

O Vite informa o endereço local (normalmente `http://127.0.0.1:5173`). Use-o
como ambiente principal para inspecionar a UI, React DevTools, responsividade e
HMR. O build web é isolado em `extension/dist-web/`:

```powershell
npm run build:web --prefix extension
npm run preview:web --prefix extension
```

Não há publicação web nesta fase.

## Build da extensão

```powershell
npm install --prefix extension
npm run build:extension
npm run validate:extension-manifest
```

O resultado carregável fica em `extension/dist/`. Para testar no Chromium:

1. Abra `chrome://extensions`.
2. Ative o modo de desenvolvedor.
3. Escolha **Carregar sem compactação** e selecione `extension/dist`.
4. Abra uma página compatível do ChatGPT e use “Abrir Crônicas”.

Para um ZIP local temporário, use `npm run package:local --prefix extension`.
O ZIP e `dist/` são ignorados pelo Git.

## Limitações e próximas fases

As telas Mapa e Combate são intencionalmente indisponíveis. Não existe OAuth,
login, API, MCP, tempo real, polling, ficha real, inventário real ou ação de
jogo. Fases seguintes podem introduzir OAuth da extensão, uma projeção
read-only autorizada pelo backend, atualização em tempo real e a primeira ação
real idempotente — cada uma com contrato e autorização próprios.
