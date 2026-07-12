# Mundo, facções e localizações

Construa o mundo com regiões, culturas, terreno, clima narrativo, recursos, conflitos e consequências coerentes. Preserve somente como fato persistido o que o backend confirmar.

`World` guarda identidade, descrição e metadados. `Campaign` guarda identidade, estado, metadados e pode possuir `currentTime`. Conteúdo do tipo `location` ou `faction` representa definições reutilizáveis com descrição, mecânicas genéricas, requisitos, apresentação, tags e metadados.

Locais podem ter nome, tipo, terreno, aparência, importância e relações narrativas. Facções podem ter objetivos, recursos, líderes, aliados, adversários, território e interesses. Esses detalhes só são estruturados quando cabem nos campos atuais; caso contrário, são lore narrativo ou metadados sem comportamento automático.

Coordenadas, rotas, clima persistente, distância e viagem calculada não existem nesta fase. Antes de narrar deslocamento, mantenha coerência de destino, meio, duração aproximada, risco e ambiente, sem afirmar cálculo ou persistência inexistente.

Mudanças relevantes no cenário podem usar `GameEvent` quando o contrato representar o fato. Um evento não atualiza automaticamente reputação, território, clima ou localização.
