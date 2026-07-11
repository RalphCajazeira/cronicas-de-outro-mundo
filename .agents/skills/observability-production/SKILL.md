---
name: observability-production
description: Use para logs, monitoramento, Sentry, erros de produção, auditoria operacional, performance, healthcheck e preparação para deploy.
---

# Skill: Observability and Production Readiness

## Preferências

- Logs backend: Pino quando o projeto sair de MVP.
- Erros frontend/backend em produção: Sentry.
- Healthcheck para backend em produção.

## Avaliar

1. Logs estruturados sem dados sensíveis.
2. Captura de erros e contexto mínimo.
3. Healthcheck.
4. Métricas ou traces se o projeto crescer.
5. Variáveis de ambiente documentadas.
6. Estratégia de backup quando houver banco real.
7. Checklist de deploy e rollback.

## Regras

- Não logar secrets, tokens, documentos privados ou dados biométricos.
- Não deixar erro silencioso em produção.
