# Atores e Memórias

## Núcleo unificado

Personagens, NPCs, criaturas, companheiros, inimigos, comerciantes, mestres de guilda, chefes, espíritos, divindades, animais e construtos pertencem ao mesmo conceito de ator persistente.

O tipo do ator define seu papel mecânico e narrativo.

Tipos usados pelas Actions:

- npc;
- creature;
- merchant;
- guild_master;
- boss;
- spirit;
- deity;
- animal;
- construct;
- other.

O personagem do jogador também é um ator, mas é criado pelo fluxo próprio de personagem.

## Quando salvar um ator

Salve um ator quando houver:

- nome próprio;
- promessa, juramento, favor ou dívida;
- relação com missão;
- possibilidade razoável de reaparecer;
- vínculo emocional;
- loja ou serviço;
- papel em facção;
- antagonismo relevante;
- segredo;
- impacto futuro;
- relação importante com outro ator.

## Campos narrativos

Use os campos com funções diferentes:

- `description`: características relativamente permanentes;
- `context`: situação atual útil para próximas cenas;
- `notes`: observações livres;
- `appearance`: aparência;
- `personality`: traços de comportamento;
- `goals`: objetivos;
- `motivations`: razões por trás das ações;
- `fears`: medos e vulnerabilidades;
- `knowledge`: fatos que o ator conhece;
- `secrets`: fatos ocultos que não podem ser revelados sem descoberta;
- `tags`: marcadores de busca e organização;
- `first_appearance`: primeiro encontro;
- `last_appearance`: situação da aparição mais recente.

Importância:

- background;
- recurring;
- important;
- main.

## Memórias

Registre memórias quando um acontecimento deve influenciar comportamento, decisão, confiança, medo, respeito, afeto, hostilidade ou continuidade futura.

Memórias podem registrar:

- encontros;
- promessas;
- mentiras;
- favores;
- traições;
- presentes;
- combates;
- conversas;
- descobertas;
- mudanças de crença;
- dívidas;
- assuntos não resolvidos.

Use:

- `summary` para o resumo obrigatório;
- `description` para os detalhes;
- `context` para explicar por que a memória importa;
- `emotional_effect` para efeitos emocionais;
- `beliefs_changed` para mudanças de opinião;
- `promises` para compromissos;
- `unresolved_threads` para ganchos futuros.

Uma criatura ou NPC pode existir como ator antes de virar companheiro.

O Codex representa o que o personagem sabe. O ator representa o que existe no mundo. A memória representa o que aquele ator viveu ou acredita lembrar.