---
name: reuse-before-create
description: Use antes de criar arquivos, componentes, services, hooks, schemas, types ou módulos para evitar duplicação e reaproveitar padrões existentes.
---


# Skill: Reuse Before Create

Use esta skill sempre que a tarefa puder criar algo novo.

## Processo obrigatório

1. Busque por nomes semelhantes e padrões existentes.
2. Leia arquivos próximos do domínio afetado.
3. Verifique se já existe componente/service/schema/hook/helper/repository reutilizável.
4. Se existir algo parecido, prefira adaptar ou reutilizar.
5. Se a duplicação for real, extraia uma abstração pequena e nomeada pelo domínio.
6. Crie novo apenas quando a responsabilidade for realmente nova.

## Entrega

Informe no resumo:

- o que foi procurado;
- o que foi reutilizado;
- por que algo novo foi necessário, se criou.
