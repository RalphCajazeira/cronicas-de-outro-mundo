# Fundação de identidade e autorização — Fase 2B

## Estado e limites

Esta fase adiciona somente o modelo persistente e serviços internos de identidade,
autorização e auditoria. OAuth, validação JWT/JWKS, rotas autenticadas, tools MCP
reais e vínculo automático de contas ainda não estão implementados. REST,
Actions/OpenAPI e o proof mode do App continuam usando seus contratos atuais.

O frontend principal futuro do jogador é o widget dentro do ChatGPT. O ChatGPT
atua como narrador, intérprete e criador orientado; o backend permanece a
autoridade para identidade interna, autorização, regras e persistência.

## Identidade e relação com o domínio legado

`ExternalIdentity` resolve uma identidade somente pela tupla exata
`(issuer, subject)`. Email é atributo mutável, nunca identificador ou chave de
vínculo. A tabela não armazena access token, refresh token, authorization code,
cookie, senha ou client secret.

`User` representa a conta autenticável. `Player` continua sendo o perfil global
de jogador que possui seus `World`s, enquanto personas e personagens são
`Actor`s dentro de uma `Campaign`. O domínio atual cria ou reutiliza um único
`Player` global por referência e permite vários atores; por isso a relação
escolhida é opcional um-para-um nos dois sentidos:

- `Player.userId` é nullable durante o expand, preservando todos os Players
  legados sem backfill inferido;
- o índice unique impede dois Players ligados ao mesmo User;
- um User pode existir antes de receber um Player;
- múltiplas identidades externas podem apontar para o mesmo User.

Uma necessidade futura de múltiplos perfis de jogador por conta é uma mudança de
produto e schema. Ela deve remover a unique por migration aditiva antes de
qualquer vínculo incompatível; não deve reutilizar `Actor` como conta nem
inferir ownership a partir de nomes, emails ou referências legadas.

## Ciclo de vida e revogação

`User.status`, `suspendedAt` e `deletedAt` são protegidos por check constraint.
O fluxo normal de exclusão é soft delete (`DELETED`); suspensão e exclusão são
rejeitadas tanto na resolução de identidade quanto na autorização.

`CampaignMembership` possui uma linha por `(campaignId, userId)`.
`ActorControl` possui uma linha por `(actorId, userId)`. Em ambos os casos,
revogar e conceder novamente significa atualizar a mesma linha, limpando
`revokedAt` e restaurando o estado/permissão deliberado. Cada transição deve
gerar `AuditEvent`; as tabelas de grant representam o estado atual, não um
ledger histórico. Um grant de ator nunca substitui membership ativa.

Hard delete é operação administrativa excepcional:

- identidades, memberships e controles são removidos por cascade;
- `Player.userId` volta a null;
- `AuditEvent` é preservado e suas FKs tornam-se null, reduzindo dados pessoais;
- exclusão de Campaign ou Actor também preserva os eventos por `SET NULL`.

## Política de autorização

Toda entrada parte de `userId` derivado de um principal externo já verificado.
IDs enviados por widget ou modelo nunca estabelecem identidade. A consulta de
ator é filtrada simultaneamente por `userId`, `campaignId` e `actorId` e carrega
o membership correspondente na mesma consulta. O serviço falha fechado para:

- membership ausente, revogado ou com role insuficiente;
- User suspenso, deletado ou com marcadores incoerentes;
- controle ausente, revogado ou insuficiente;
- ator de outra campanha ou de outro usuário;
- `OBSERVER` tentando `CONTROL`.

`Actor.role` é exclusivamente narrativo e nunca concede privilégios. Os erros
públicos de autorização usam `FORBIDDEN` e mensagem genérica; detalhes estáveis
ficam apenas em `auditCode`, sem revelar campanha, ator, owner ou usuário alheio.
Inconsistência retornada pelo repository é erro interno de integridade.

As factories dos repositories aceitam `Prisma.TransactionClient`. Na futura
tool mutável, resolução de contexto, autorização, leitura de `stateVersion`,
mutação de domínio e `AuditEvent` devem usar a mesma transação. A checagem não
deve ser executada antes da transação nem reutilizada depois dela, evitando
TOCTOU.

## Auditoria e idempotência futura

`AuditEvent` aceita somente metadata plana, primitiva, allowlisted e pequena:
até 20 entradas, strings de até 200 caracteres e JSONB físico de até 4096 bytes.
Chaves desconhecidas, objetos, arrays, quebras de linha, emails, tokens JWT ou
Bearer e connection strings são rejeitados. Não registrar headers, cookies,
payload narrativo, prompts, ficha completa ou secrets. `requestId` e `traceId`
permitem correlação sem copiar conteúdo.

Retenção, anonimização programada e acesso operacional aos eventos serão
definidos antes do primeiro rollout autenticado. Até lá, nenhuma integração
runtime grava essa tabela.

A idempotência global não muda nesta fase. Tools autenticadas deverão usar
namespace composto por `userId`, operação/tool, `campaignId` quando aplicável,
`idempotencyKey` e `stateVersion`, preservando a chave em retries exatos.

## RLS, privilégios e rollout

As cinco novas tabelas habilitam RLS sem policies para `anon` ou
`authenticated` e revogam explicitamente privilégios de PUBLIC, `anon`,
`authenticated` e `service_role`. A revogação de `service_role` é necessária
porque esse papel normalmente possui `BYPASSRLS` no Supabase. Não há `FORCE ROW
LEVEL SECURITY`: o proprietário Prisma dedicado continua operando, como nas
migrations existentes.

Antes do rollout, confirmar em metadata que:

1. a migration inédita continua sendo a décima terceira;
2. a conexão de migration cria as tabelas com owner `cronicas_staging_app`;
3. a role runtime é owner, tem `CREATE`/`USAGE`, não é superuser nem `BYPASSRLS`;
4. PUBLIC, `anon`, `authenticated` e `service_role` não têm grants nas novas
   tabelas;
5. RLS está ligado, não forçado e não existem policies públicas.

Se owner ou default ACL divergir, parar antes de ligar funcionalidade e preparar
uma migration corretiva explícita. O rollback normal é reverter a aplicação e
manter schema aditivo/RLS. Remover tabelas, enums ou `Player.userId` perderia
estado e exige autorização destrutiva separada; não é rollback operacional.

## Próxima fase

A próxima fase é OAuth somente em staging: discovery/metadata, validação de
issuer, audience, assinatura, expiração e scopes, seguida de vínculo controlado
da identidade externa. Nenhuma tool de dados reais deve ser exposta antes de
existirem principal validado, User ativo, membership, RLS/ACL verificados e
auditoria segura.
