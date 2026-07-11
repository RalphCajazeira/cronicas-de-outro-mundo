# Lojas e Vendedores

Vendedores importantes são atores persistentes do tipo `merchant`.

O ator vendedor pode possuir:

- nome, espécie e aparência;
- personalidade;
- reputação com o jogador;
- objetivos e motivações;
- medos e segredos;
- conhecimento sobre produtos, rumores e clientes;
- contexto comercial atual;
- memórias de compras, dívidas, favores e conflitos.

Uma loja é separada do ator vendedor, pois pode trocar de dono, possuir funcionários ou continuar existindo sem um vendedor específico.

Lojas possuem:

- nome;
- vendedor ou responsáveis;
- localização;
- tipo;
- descrição e contexto;
- horário;
- moeda;
- reputação exigida;
- margem de compra e venda;
- estoque;
- reabastecimento;
- regras comerciais;
- observações e metadados.

O estoque deve ser persistente.

Itens raros, únicos ou vinculados a evento não reaparecem sem reposição válida.

Preços podem variar conforme reputação, escassez, qualidade, localização, negociação, condição do item e relação com o vendedor.

Compras, vendas, encomendas, dívidas e trocas importantes devem gerar consequências persistentes no inventário, ouro, estoque e relacionamento.