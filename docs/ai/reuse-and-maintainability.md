# Reuso e Manutenibilidade

## Regra principal

Antes de criar algo novo, procure algo existente.

A ordem padrão é:

```text
Pesquisar → Reutilizar → Adaptar → Extrair pequeno → Criar novo.
```

## Checklist antes de criar arquivo novo

- Existe componente parecido?
- Existe hook parecido?
- Existe service parecido?
- Existe schema Zod parecido?
- Existe tipo/DTO/contrato parecido?
- Existe repository/helper/util parecido?
- Existe rota/controller/service de módulo semelhante?
- Existe teste que mostre padrão esperado?
- Existe convenção de nome no projeto?

## Quando reutilizar

Reutilize quando:

- a intenção é a mesma;
- a API é compatível;
- a diferença é configurável sem gambiarra;
- o reuso reduz duplicação sem esconder regra de negócio.

## Quando adaptar

Adapte quando:

- o arquivo existente é quase igual;
- a mudança melhora o padrão geral;
- os usos atuais continuam claros;
- os testes/validações cobrem comportamento.

## Quando extrair

Extraia função/componente/helper quando:

- a duplicação já apareceu pelo menos duas vezes;
- o nome da abstração é óbvio;
- os casos de uso são realmente iguais;
- a extração reduz complexidade.

Não extraia só para “prever futuro”.

## Quando criar novo

Crie novo quando:

- não existe equivalente;
- reusar deixaria o código confuso;
- adaptar quebraria responsabilidade existente;
- a regra de negócio é diferente;
- o novo arquivo tem nome e responsabilidade claros.

## Anti-padrões

Evitar:

- `utils.ts` gigante;
- `helpers.ts` sem domínio;
- componentes genéricos demais;
- services com muitas responsabilidades;
- hooks que misturam API, UI e regra de negócio;
- schemas duplicados sem motivo;
- tipos frontend divergindo do backend sem decisão documentada;
- criação de pasta nova para cada arquivo;
- refatoração ampla escondida dentro de feature pequena.

## Refactor seguro

Refatoração deve preservar comportamento, salvo quando a tarefa pedir mudança funcional.

Para refactor grande:

1. Diagnosticar.
2. Propor plano em etapas.
3. Fazer uma etapa por vez.
4. Rodar validações.
5. Não misturar com feature nova.
