# GPT ativo — Crônicas de Outro Mundo

Esta pasta contém os artefatos oficiais do GPT personalizado. A API Node e o OpenAPI ativo definem as capacidades técnicas; Knowledge orienta comportamento e narrativa sem ampliar o contrato do backend.

## Prioridade das fontes

1. resposta atual do backend;
2. estado persistente confirmado;
3. `instructions.md`;
4. arquivos ativos de `knowledge/`;
5. inferência narrativa.

Uma conversa antiga, inferência ou regra histórica nunca prevalece sobre o retorno atual da Action.

## Knowledge oficial

Envie ao GPT todos e somente estes arquivos:

1. `01-narrativa-e-continuidade.md` — controle do protagonista, modos, apresentação e continuidade;
2. `02-atores-conteudo-e-progressao.md` — capacidades atuais de Actor, ContentDefinition, ActorContent e GameEvent;
3. `03-limites-mecanicos.md` — fronteiras atuais e sistemas adiados;
4. `04-fontes-de-poder-classes-magias-e-talentos.md` — coerência de poderes e sua representação por conteúdo;
5. `05-criaturas-companheiros-e-vinculos.md` — criaturas individuais, autonomia e vínculos narrativos;
6. `06-mundo-faccoes-e-localizacoes.md` — construção de mundo e persistência disponível;
7. `07-missoes-npcs-e-relacionamentos.md` — objetivos e relações sem prometer subsistemas inexistentes;
8. `08-memorias-conhecimento-e-codex.md` — eventos, conhecimento privado e níveis de certeza;
9. `09-fichas-e-coerencia-mecanica.md` — ficha real de atores e limites de cálculo.

Os arquivos em `legacy/supabase-gpt-v1/` são somente referência histórica e nunca devem ser enviados ao GPT ativo. O corpus atual consolida princípios narrativos úteis do legado, sem Edge Functions, RPCs, tabelas, campos ou operationIds antigos.

## Categorias de capacidade

- **Persistência estruturada atual:** modelos e campos expostos pelo backend e pelo OpenAPI.
- **Persistência genérica atual:** JSON e eventos usados dentro do contrato, sem atribuir semântica automática inexistente.
- **Regra narrativa:** orientação de narração que não promete armazenamento.
- **Sistema futuro ou adiado:** conceito útil que não deve ser apresentado como implementado.

## Configuração no editor

1. validar a API publicada e seu `GET /openapi.json`;
2. importar o OpenAPI servido, cujo `servers` usa `PUBLIC_BASE_URL`;
3. configurar API key no header `x-rpg-key`, sem copiar o valor para arquivos;
4. colar integralmente `instructions.md`;
5. enviar somente os nove arquivos oficiais de Knowledge;
6. testar health, readiness, carga de estado e leituras antes de qualquer escrita;
7. em staging vazio, validar `loadGame` ausente, configuração e `startGame` antes de criar NPCs ou conteúdo;
8. provocar um `INVALID_INPUT` sem persistência e confirmar uma única correção guiada.

`gpt/openapi.json` usa um domínio de exemplo no repositório; o backend publicado injeta a origem HTTPS real. O GPT nunca acessa Supabase, Prisma ou PostgreSQL diretamente.

## Manutenção

Antes de adicionar ou alterar Knowledge:

1. revisar schema Prisma, schemas HTTP e OpenAPI atuais;
2. escolher um domínio existente antes de criar novo arquivo;
3. distinguir persistência estruturada, genérica, narrativa e sistema futuro;
4. evitar duplicação e contradições entre arquivos;
5. rejeitar nomes de operações ou contratos que não existam no OpenAPI atual;
6. manter o corpus conciso e com no máximo dez arquivos, salvo necessidade justificada.
