---
name: mobile-app
description: Use quando houver necessidade de aplicativo mobile, React Native, Expo, câmera, localização em segundo plano, push notification ou experiência nativa.
---

# Skill: Mobile App

## Preferência

Usar React Native + Expo quando web/PWA não atender.

## Criar `mobile/` apenas quando houver necessidade real de:

- câmera;
- localização em segundo plano;
- push notification confiável;
- experiência nativa;
- biometria/selfie;
- uso frequente em campo.

## Antes de implementar

1. Confirmar se web responsivo/PWA basta.
2. Definir comunicação com backend existente.
3. Definir autenticação compartilhada.
4. Definir permissões nativas necessárias.
5. Definir estratégia de build/distribuição.
6. Evitar duplicar regra de negócio no app.

## Regras

- Backend continua fonte de verdade.
- Mobile não deve conter secrets.
