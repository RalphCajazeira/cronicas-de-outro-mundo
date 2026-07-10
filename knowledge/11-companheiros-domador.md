# Companheiros e Domador

Criaturas podem ser relevantes sem serem companheiras.

Toda criatura relevante existe como um único ator persistente. Tornar-se companheira não cria uma segunda ficha nem muda seu tipo real.

Exemplo:

- Lyra continua sendo um ator do tipo `spirit`;
- `is_companion` indica que possui vínculo ativo;
- `companion_status` indica o estado atual do vínculo;
- `companion_of_actor_id` indica com qual ator está vinculada;
- os detalhes do pacto ficam no vínculo de companheiro.

## Ficha única

A ficha do ator permanece como fonte de verdade para:

- nome;
- espécie;
- tipo real;
- nível e XP;
- vida e mana;
- atributos;
- aparência;
- personalidade;
- objetivos e motivações;
- medos e segredos;
- conhecimento;
- habilidades e equipamento;
- localização;
- estado;
- contexto, observações e memórias.

Nunca duplique esses dados em uma segunda ficha de companheiro.

## Vínculo de companheiro

O vínculo entre dois atores guarda:

- estado do pacto;
- confiança;
- lealdade;
- profundidade do vínculo;
- felicidade;
- fome e energia, quando aplicável;
- tipo de contrato;
- termos do pacto;
- regras de convocação;
- contexto e observações;
- início, suspensão, rompimento ou encerramento.

Confiança, lealdade e vínculo são conceitos diferentes:

- confiança indica quanto o companheiro acredita no personagem;
- lealdade indica disposição para permanecer ao lado dele;
- vínculo representa profundidade emocional ou mágica da ligação.

## Criação e atualização

Use `createCompanion` para criar ou ativar o vínculo com um ator existente. Quando o ator já existir, envie seu `actor_id`, `entity_id` legado ou nome; a Action deve reutilizar a mesma ficha.

Use `listCompanions` para listar atores com vínculo ativo.

Use `updateCompanion` para alterar o vínculo e, quando necessário, o estado do ator. O `companion_id` retornado representa o vínculo, não uma segunda criatura.

Romper ou encerrar o pacto apenas desativa o vínculo. O ator continua existindo com todo o histórico preservado.

O desenvolvimento ocorre por treino, experiência, convivência, magia, alimentação, eventos, equipamento e evolução do vínculo; não por evolução racial obrigatória.

O companheiro mantém vontade própria. Não deve agir como objeto ou obedecer automaticamente quando isso contradiz personalidade, medo, objetivos ou relação persistida.