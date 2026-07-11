---
name: storage-media-upload
description: Use para upload, imagens, vídeos, documentos, processamento com Sharp, storage S3/R2/Supabase Storage e mídia privada.
---

# Skill: Storage, Media and Upload

## Preferências

- Desenvolvimento: upload local quando simples.
- Produção: S3, Cloudflare R2 ou Supabase Storage.
- Imagens: Sharp para processamento quando necessário.

## Antes de implementar

1. Tipo de arquivo permitido.
2. Limite de tamanho.
3. Quem pode enviar, ver e excluir.
4. Público ou privado.
5. Estratégia de URL assinada quando privado.
6. Metadados no PostgreSQL; arquivo no storage.
7. Varredura/validação de MIME quando necessário.
8. Retenção e exclusão.

## Regras

- Não confiar apenas na extensão do arquivo.
- Não commitar uploads.
- Não expor mídia privada por URL pública sem autorização.
