# Prova local do ChatGPT App

Esta prova implementa o fluxo visual:

```text
widget MCP Apps
→ ferramenta MCP
→ identidade e gateway fixture no backend
→ structuredContent público
→ atualização visual
```

Ela não configura OAuth, HTTPS público, ChatGPT Developer Mode, banco, campanha real ou deploy.

## Dependências

Backend:

```powershell
npm install --save-exact @modelcontextprotocol/sdk@1.29.0 @modelcontextprotocol/ext-apps@1.7.5 --prefix backend
```

Widget:

```powershell
npm install --save-exact @modelcontextprotocol/sdk@1.29.0 @modelcontextprotocol/ext-apps@1.7.5 zod@4.4.3 --prefix widget
npm install --save-dev --save-exact esbuild@0.28.1 typescript@6.0.3 vitest@4.1.10 --prefix widget
```

- `@modelcontextprotocol/sdk`: servidor e cliente Streamable HTTP.
- `@modelcontextprotocol/ext-apps`: helpers de recurso UI, bridge padrão e comunicação do widget.
- `esbuild`: bundle HTML autocontido sem Vite ou framework.
- Zod, TypeScript e Vitest mantêm o padrão já usado pelo backend.

React é peer opcional de `ext-apps` e não foi instalado. O SDK inclui `jose` transitivamente, mas esta prova não importa nem usa OAuth/JWT.

Referências oficiais:

- [Servidor MCP](https://developers.openai.com/plugins/build/mcp-server)
- [UI do ChatGPT](https://developers.openai.com/plugins/build/chatgpt-ui)
- [MCP Apps](https://modelcontextprotocol.io/extensions/apps/build)
- [Conectar e testar](https://developers.openai.com/plugins/deploy/connect-chatgpt)

## Construir

Na raiz:

```powershell
npm run build:chatgpt-app
```

Para executar somente as validações MCP/widget:

```powershell
npm run validate:mcp
```

## Iniciar a prova local

Use a configuração local existente do backend e execute:

```powershell
npm run dev:chatgpt-app
```

Abra:

```text
http://localhost:3000/chatgpt-app-preview
```

`3000` é o valor padrão do backend. Use o valor de `PORT` já configurado no ambiente local quando ele for diferente.

O host local:

1. abre uma sessão MCP Streamable HTTP em `/mcp`;
2. chama `loadGameContext`;
3. lê `ui://game/home/v2.html`;
4. monta o widget em iframe isolado;
5. encaminha chamadas do widget ao MCP pela bridge oficial.

O botão **Conectar conta** chama `connectFixtureAccount` sem identificador de jogador. A identidade fica somente na sessão MCP em memória.

Para demonstrar uma conta conectada sem campanha retomável, abra uma nova sessão em:

```text
http://localhost:3000/chatgpt-app-preview?scenario=without-resume
```

O parâmetro escolhe apenas o cenário de demonstração no host local. Ele não contém nem seleciona `playerId`, ator, mundo ou campanha.

## MCP Inspector

Com o backend em execução:

```powershell
npx --yes @modelcontextprotocol/inspector@1.0.0 --cli http://localhost:3000/mcp --transport http --method tools/list
```

Para usar a interface do Inspector:

```powershell
npx --yes @modelcontextprotocol/inspector@1.0.0
```

Selecione Streamable HTTP e informe:

```text
http://localhost:3000/mcp
```

O Inspector valida ferramentas, schemas, recursos e resultados. A prova visual completa usa o host local porque ele implementa a bridge MCP Apps do iframe.

Na validação desta prova em Windows, o comando `tools/list` retornou corretamente as duas ferramentas e seus schemas, mas o processo do Inspector 1.0.0 encerrou depois com uma asserção interna do libuv. Os testes com o cliente oficial do SDK validam o mesmo transporte sem esse erro de encerramento; convém repetir o Inspector em uma versão posterior antes do teste externo.

## Estados fixture

- Nova sessão: `DISCONNECTED`.
- `connectFixtureAccount` sem argumentos: `CONNECTED_FIXTURE` com campanha retomável.
- `connectFixtureAccount` com `scenario: "WITHOUT_RESUME"`: conectado sem campanha retomável.
- Production: a ferramenta fixture não é registrada e os adapters recusam construção, exceto quando `CHATGPT_APP_PROOF_MODE=true` estiver configurado explicitamente para a prova pública de staging.

As fixtures não acessam Prisma, `gpt.repository.ts`, `game_gpt_dev`, Supabase ou serviços remotos.

## Mock, integração local e integração real

- **Mock:** jogador, mundo e campanha definidos pelo `FixtureGameContextGateway`.
- **Integração local:** widget, bridge, transporte MCP, ferramenta, sessão e DTO são reais.
- **Integração real:** ainda pendente; requer OAuth, identidade persistente, autorização e um gateway read-only do backend.

## Limitações atuais

- Nenhum dado é persistido.
- “Continuar” mostra apenas uma prévia pública.
- “Novo Jogo” mostra apenas opções visuais.
- Uma reinicialização do backend remove todas as sessões fixture.
- O endpoint HTTPS público de staging continua pendente de deploy autorizado.
- Não foi testado dentro do ChatGPT.

## Teste posterior dentro do ChatGPT

Uma task separada deverá:

1. decidir entre deploy temporário e túnel HTTPS autorizado;
2. expor `/mcp` por HTTPS;
3. validar o endpoint no MCP Inspector;
4. habilitar Developer Mode em uma conta/workspace compatível;
5. adicionar a URL HTTPS completa terminada em `/mcp`;
6. revisar ferramentas e metadata descobertas;
7. abrir uma conversa nova e chamar `loadGameContext`;
8. registrar screenshots, console e comportamento de remontagem;
9. remover o endpoint/túnel temporário ao concluir.

Esses passos têm efeito externo e exigem autorização específica.
