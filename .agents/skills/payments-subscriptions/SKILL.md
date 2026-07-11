---
name: payments-subscriptions
description: Use para pagamentos, marketplace, checkout, assinaturas, webhooks, ledger financeiro, split, comissões e reembolso.
---

# Skill: Payments and Subscriptions

## Princípios

- Pagamento é funcionalidade sensível.
- Confirmação de pagamento deve acontecer por webhook no backend.
- Não liberar acesso/assinatura apenas pelo retorno do frontend.
- Registrar histórico financeiro/auditoria.

## Antes de implementar

1. Definir provedor: Stripe, Mercado Pago, Pagar.me, Asaas, Iugu ou outro.
2. Definir modelo: compra única, assinatura, marketplace, split, comissão.
3. Definir estados financeiros.
4. Definir webhooks e idempotência.
5. Definir reconciliação e tratamento de falhas.
6. Definir testes de fluxo aprovado, pendente, recusado e cancelado.

## Entrega

- provider escolhido e motivo;
- eventos webhook necessários;
- tabelas/modelos afetados;
- riscos e validações.
