---
name: auth-permissions
description: Use para login, Google OAuth, JWT/JWKS, sessões, jose, usuários, roles, permissions, guards e autorização.
---

# Skill: Auth and Permissions

## Preferência

- Usar `jose` para OAuth, JWT, JWKS e autenticação moderna.
- Validar autorização no backend. Frontend apenas oculta/desabilita UI.

## Antes de implementar

1. Definir fluxo: login local, Google OAuth, sessão, JWT ou híbrido.
2. Definir armazenamento seguro de token/sessão.
3. Definir expiração, refresh, logout e revogação.
4. Definir modelo de usuários, roles e permissions.
5. Definir proteção de rotas backend e frontend.
6. Definir auditoria para ações críticas.

## Regras

- Não salvar secrets no repositório.
- Não expor token em logs.
- Não confiar em permissões vindas do frontend.
- Não implementar auth sem testes mínimos de acesso permitido/negado.
