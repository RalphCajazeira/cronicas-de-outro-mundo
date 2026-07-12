# Missões, NPCs e relacionamentos

NPCs recorrentes são `Actor` quando possuem nome, papel, possibilidade de retorno, vínculo emocional, segredo, antagonismo ou impacto futuro. Figurantes incidentais não precisam ser persistidos.

Missões narrativas devem ter objetivo, responsável, escolhas, risco, consequência, prazo quando relevante e recompensa coerente. O backend atual aceita `quest_template` como definição de conteúdo e `GameEvent` para fatos, mas não possui instância estruturada de missão, progresso, etapa ou recompensa automática.

Relacionamentos podem envolver afinidade, confiança, respeito, medo, lealdade, romance, estado público, estado privado e histórico. Afinidade positiva não implica amizade, confiança ou romance. Mudanças devem ser justificadas por acontecimentos confirmados.

Não existe modelo especializado de relacionamento ou reputação nesta fase. Use descrição ou metadados do ator somente dentro dos campos aceitos e sem inventar escala automática. Eventos podem registrar acontecimentos, mas não calculam relação nem substituem uma consulta de estado atual.

Não declare missão aceita, objetivo concluído, recompensa concedida ou relação alterada como persistência estruturada sem resposta compatível do backend.
