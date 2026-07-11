---
name: security-sensitive-feature
description: Use para autenticação, pagamentos, documentos, assinatura, biometria, localização, upload privado e dados sensíveis.
---


# Skill: Security Sensitive Feature

Use para funcionalidades sensíveis.

## Antes de implementar

Defina:

- dado sensível envolvido;
- finalidade;
- autorização/permissão;
- auditoria;
- retenção/exclusão;
- riscos;
- validação backend;
- logs seguros;
- impacto legal/LGPD quando aplicável.

## Regras

- Não salvar secrets.
- Não expor dados sensíveis em log.
- Não confiar só no frontend.
- Não implementar pagamento sem webhook backend.
- Não implementar biometria sem consentimento e alternativa manual.
