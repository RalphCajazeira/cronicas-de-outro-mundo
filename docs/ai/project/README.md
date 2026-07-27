# Contexto Vivo do Projeto

Este diretório contém o contexto operacional atual de **Crônicas de Outro Mundo**.

## Documentos

- [`PROJECT_STATE.md`](PROJECT_STATE.md): capacidades, evidências, ambientes e limitações.
- [`ROADMAP.md`](ROADMAP.md): ordem atual das próximas tasks.
- [`DECISIONS.md`](DECISIONS.md): decisões transversais e mudanças arquiteturais.
- [`CURRENT_STATE.md`](CURRENT_STATE.md): caminho antigo preservado como redirecionamento.

## Separação de responsabilidades

```text
RalphCajazeira/Regras-Game-GPT
→ regras, produto, arquitetura-alvo e decisões canônicas

RalphCajazeira/cronicas-de-outro-mundo
→ código, banco, testes, rollout e estado realmente implementado
```

## Prioridade

Quando houver conflito:

1. ambiente, banco e serviço atual;
2. Git e arquivos atuais;
3. testes, build e CI atuais;
4. estes documentos vivos;
5. regras canônicas;
6. relatórios anteriores;
7. memória e hipóteses.

## Manutenção

Todo PR que altera capacidade, rollout ou arquitetura deve atualizar o documento correspondente ou declarar explicitamente que não altera estado de produto.