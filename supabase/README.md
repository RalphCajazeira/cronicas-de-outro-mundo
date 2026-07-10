# Supabase

Esta pasta documenta a infraestrutura persistente do projeto.

## Projeto

- Nome: `isekai-rpg-db`
- Região: `sa-east-1`
- OpenAPI: `https://whrsjzmjceyvrjulxksq.supabase.co/functions/v1/rpg-openapi`

## Edge Functions

- `rpg-gpt`
- `rpg-combat`
- `rpg-world`
- `rpg-progression`
- `rpg-openapi`

## Segurança

Nunca versionar:

- service role key;
- chave `x-rpg-key`;
- tokens;
- senhas;
- arquivos `.env`.

As migrations futuras devem ser incrementais e nunca devem alterar retroativamente migrations já aplicadas.
