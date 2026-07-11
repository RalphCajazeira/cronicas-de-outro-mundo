# Segurança e Funcionalidades Sensíveis

Consulte este arquivo antes de implementar autenticação, pagamento, documento assinado, reconhecimento facial, biometria, localização, upload privado, chat, dados financeiros ou dados pessoais sensíveis.

## Princípios

- Backend valida regra crítica.
- Frontend apenas melhora experiência; não protege regra sensível sozinho.
- Não expor secrets.
- Não registrar dados sensíveis em log.
- Não salvar dado sensível sem finalidade clara.
- Documentar retenção, exclusão e acesso.
- Preferir menor dado necessário.

## Autenticação

Antes de implementar, decidir:

- provedores;
- senha local ou OAuth;
- cookie httpOnly ou token;
- refresh token;
- expiração;
- logout;
- reset de senha;
- verificação de e-mail;
- proteção CSRF/CORS;
- auditoria de login;
- revogação de sessão.

Preferência para OAuth/JWT/JWKS/OIDC:

```text
jose
```

## Pagamentos

Nunca confiar apenas no retorno do frontend.

Fluxo mínimo:

1. backend cria intenção/cobrança;
2. provedor processa;
3. provedor chama webhook;
4. backend valida assinatura do webhook;
5. backend atualiza status no banco;
6. frontend consulta status no backend.

Guardar histórico financeiro e eventos recebidos.

## Assinatura de documentos

Não tratar checkbox simples como assinatura sem trilha de auditoria.

Guardar:

- hash do documento;
- documento/versionamento;
- usuário;
- data/hora;
- IP;
- user agent;
- aceite explícito;
- evidências;
- evento de auditoria.

## Reconhecimento facial e biometria

Dado biométrico é sensível.

Antes de implementar:

- definir finalidade;
- obter consentimento;
- permitir alternativa manual quando necessário;
- decidir retenção/exclusão;
- definir onde processar;
- proteger armazenamento;
- auditar acessos;
- avaliar prova de vida/liveness;
- revisar LGPD e riscos legais.

Para sistema de ponto, considerar começar com selfie + geolocalização + auditoria antes de reconhecimento automático.

## Geolocalização

Guardar apenas o necessário:

- latitude;
- longitude;
- precisão;
- timestamp;
- origem;
- usuário;
- contexto do evento.

Para rastreamento ao vivo, deixar claro quando começou, quando termina e quem pode ver.

## Upload privado

- Validar tipo/tamanho.
- Sanitizar nome.
- Processar imagem com segurança.
- Guardar arquivo em storage externo em produção.
- Guardar metadados no banco.
- Proteger acesso com autorização backend.
- Não servir arquivo privado por URL pública permanente sem decisão.

## Chat

- Definir retenção de mensagens.
- Evitar salvar dados sensíveis desnecessários.
- Registrar timestamps e participantes.
- Validar autorização para acessar conversa.

## Auditoria

Ações críticas devem gerar audit log:

- login sensível;
- alteração de permissão;
- pagamento;
- assinatura;
- alteração de ponto;
- exclusão de dados;
- mudança de status crítico;
- alteração de documento.
