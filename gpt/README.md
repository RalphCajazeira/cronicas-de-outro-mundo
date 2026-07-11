# GPT ativo — Crônicas de Outro Mundo

Esta pasta contém os artefatos atuais do GPT personalizado. Ela substitui, para novas configurações, os contratos preservados em `legacy/supabase-gpt-v1/`; o legado continua apenas como referência histórica.

## Arquivos para configurar no navegador

1. Publique e valide a API Node em uma etapa futura.
2. Configure `PUBLIC_BASE_URL` com a URL HTTPS pública do serviço.
3. Abra `GET /openapi.json` no serviço e importe o JSON em **Actions** do editor do GPT.
4. Configure a autenticação da Action como API key no header `x-rpg-key`, usando o mesmo secret mantido no Render.
5. Cole `instructions.md` nas instruções do GPT.
6. Envie somente os arquivos textuais de `knowledge/` para Knowledge.
7. Teste `checkHealth`, `checkReadiness` e `loadGame` antes de permitir escritas.

Nunca copie uma chave para arquivos versionados. O `gpt/openapi.json` usa um domínio de exemplo; o endpoint servido substitui `servers` por `PUBLIC_BASE_URL`.

## Contrato e limites

- `openapi.json` é a fonte oficial ativa e possui menos de 30 operações.
- O backend persiste e valida; o GPT narra e solicita operações.
- Esta fase não possui combate avançado, inventário físico, buffs/debuffs, lojas, viagens ou autenticação pública.
- Não edite o GPT nem faça deploy a partir desta pasta automaticamente.
