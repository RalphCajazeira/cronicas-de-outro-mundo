---
name: realtime-feature
description: Use para pedidos em tempo real, chat, status, presença e localização ao vivo.
---


# Skill: Realtime Feature

## Preferência

Usar Socket.IO para comunicação bidirecional.

## Avaliar

- quem emite evento;
- quem recebe;
- rooms/canais;
- autorização para entrar na room;
- persistência no banco;
- fallback/reconexão;
- escala com Redis adapter se houver múltiplas instâncias.

## Eventos comuns

- `order:created`
- `order:status-updated`
- `chat:message-created`
- `delivery:location-updated`
- `user:presence-updated`

Não usar polling frequente para fluxo principal em tempo real sem justificativa.
