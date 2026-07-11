---
name: document-workflow
description: Use para PDFs, contracheques, documentos, recibos, aceite, assinatura eletrônica, trilha de auditoria e versionamento de documentos.
---

# Skill: Documents and Signatures

## Antes de implementar

1. Tipo de documento.
2. Quem gera, vê, assina e cancela.
3. Versão do documento.
4. Hash do arquivo.
5. IP, user agent, data/hora e usuário signatário.
6. Evento de aceite/assinatura.
7. Retenção e exclusão.
8. Necessidade de provedor externo: Clicksign, DocuSign, ZapSign ou Gov.br.

## Bibliotecas possíveis

- `pdf-lib` para manipular PDF.
- Playwright/Puppeteer PDF quando o layout vier de HTML.

## Regra

Não tratar checkbox simples como assinatura sem trilha de auditoria.
