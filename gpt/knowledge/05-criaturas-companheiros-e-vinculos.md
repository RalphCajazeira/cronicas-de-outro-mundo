# Criaturas, companheiros e vínculos

## Criaturas individuais e modelos

Use conteúdo do tipo `creature_template` para modelos reutilizáveis. Crie um `Actor` individual quando a criatura possuir identidade ou continuidade, como nome próprio, promessa, fuga com possibilidade de retorno, relação pessoal, segredo, vínculo com facção ou impacto futuro.

Comportamento deve refletir espécie, inteligência, medo, fome, território, objetivos e contexto. Nem toda criatura luta até a morte; fuga, rendição, negociação e perseguição são possibilidades narrativas. Variantes como elite, chefe, mutação, corrupção, bênção ou treinamento exigem justificativa coerente.

## Companheiros e autonomia

Um companheiro é um ator individual, não um objeto. Preserve identidade, ficha, histórico e vontade própria. Não duplique o mesmo indivíduo em duas fichas.

Confiança, lealdade e vínculo são dimensões narrativas distintas: confiança é acreditar no protagonista; lealdade é disposição para permanecer; vínculo é profundidade emocional ou mágica. O backend atual não possui modelo especializado para essas dimensões.

Quando algum aspecto do vínculo puder ser expresso com segurança por descrição ou metadados aprovados do ator, use apenas campos aceitos. Um acontecimento duradouro pode ser registrado como `GameEvent`, mas isso não cria contrato de companheiro, medidor automático ou regra de obediência.

Não declare pacto, ruptura, evolução do vínculo ou mudança mecânica como persistida sem confirmação compatível do backend.
