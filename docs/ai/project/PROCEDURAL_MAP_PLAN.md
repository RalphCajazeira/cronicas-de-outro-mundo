# Plano de Implementação — Mapa Procedural 2D

**Estado:** `PLANNED`  
**Issue:** #87 — Mapa procedural 2D inicial com React + SVG  
**Fonte canônica:** `RalphCajazeira/Regras-Game-GPT/docs/25-mapa-procedural-2d-svg-evolucao-visual.md`

## 1. Decisão atual

O primeiro mapa visual do jogo será implementado na `GameApp` React compartilhada usando SVG, sem instalar Phaser preventivamente.

```text
GameApp React
→ host web local
→ overlay da extensão
→ página própria

SVG
→ formas, cores, textos, linhas e marcadores
```

O objetivo inicial é validar domínio, UX, geração, persistência e interação. Pixel art, tilesets e engine 2D entram somente quando houver necessidade comprovada.

## 2. Resultado visual esperado

A primeira versão pode representar:

- cidade ou vila como região colorida;
- casas como retângulos;
- guilda, ferreiro, taverna, loja e templo como retângulos nomeados;
- estrada como linha ou faixa;
- rio como faixa azul;
- ponte como faixa cruzando o rio;
- jogador, NPCs e inimigos como marcadores simples;
- seleção por clique e painel de detalhes.

Exemplos:

```text
[ Guilda dos Aventureiros ]
[ Ferreiro de Arden ]
[ Taverna Lua Dourada ]
```

A informação não pode depender apenas de cor. Texto, símbolos, bordas ou padrões devem complementar a codificação visual.

## 3. Escalas

### Regional

- cidades;
- vilas;
- rios;
- estradas;
- florestas;
- montanhas;
- ruínas;
- dungeons;
- locais descobertos.

### Local

- ruas;
- lotes;
- casas;
- serviços;
- portões;
- pontes;
- NPCs;
- entradas e interações.

### Tática

- personagens;
- inimigos;
- obstáculos;
- alcance;
- movimento;
- áreas de efeito.

O primeiro recorte deve priorizar a escala local.

## 4. Geração

A geração deve ser determinística por:

```text
worldSeed
+ generatorVersion
+ região/chunk
+ parâmetros públicos
```

Fluxo inicial:

```text
seed
→ terreno base
→ rio
→ estrada principal
→ ponte no cruzamento
→ área urbana
→ praça ou eixo central
→ lotes
→ estruturas obrigatórias
→ casas restantes
→ validação de acessibilidade
```

Regras iniciais:

- guilda próxima de praça, portão ou eixo principal;
- ferreiro próximo de estrada e zona de serviço;
- taverna próxima de praça, portão ou guilda;
- toda estrutura pública possui entrada e rota acessível;
- ponte é criada quando uma rota válida cruza água.

## 5. Modelo conceitual

Não acoplar o domínio ao SVG.

Entidades candidatas:

```text
WorldMap
MapRegion
MapChunk
Settlement
MapStructure
Route
River
Bridge
PointOfInterest
MapMutation
ExplorationState
```

A mesma estrutura de domínio poderá ser renderizada futuramente por sprites, tiles ou Phaser.

## 6. Persistência

O backend permanece autoritativo.

A seed produz a base reproduzível. O banco persiste mudanças:

- ponte destruída ou reconstruída;
- casa construída;
- loja fechada;
- floresta queimada;
- baú saqueado;
- estrada bloqueada;
- local descoberto;
- cidade expandida.

Para mapas maiores, carregar somente chunks necessários à posição e à visão autorizada do jogador.

## 7. Papel do GPT

O GPT declara intenção narrativa e propriedades semânticas, não coordenadas arbitrárias.

Exemplo:

```json
{
  "locationType": "VILLAGE",
  "theme": "ribeirinha",
  "importance": "minor",
  "near": "current-player-region"
}
```

O backend escolhe posição válida, materializa o local, persiste e publica a projeção. O GPT narra o resultado oficial.

## 8. Ordem de implementação

### MAP-1 — Mock React + SVG

- fixture local;
- mapa pequeno;
- formas, cores e nomes;
- seleção por clique;
- painel de detalhes;
- mesmo resultado no host web e na extensão.

### MAP-2 — Gerador determinístico

- seed fixa;
- uma vila/cidade;
- rio;
- estrada;
- ponte;
- lotes;
- Guilda dos Aventureiros;
- Ferreiro;
- Taverna;
- casas;
- testes de determinismo.

### MAP-3 — Movimento e interação

- localização atual;
- destino;
- prévia de rota;
- confirmação;
- tempo e eventos;
- atualização oficial.

### MAP-4 — Backend e chunks

- contratos públicos;
- persistência;
- mutations;
- descoberta;
- reconstrução após reload;
- concorrência e idempotência.

### MAP-5 — Escalas regional/local/tática

- transições entre escalas;
- viagem regional;
- exploração local;
- encontro tático.

### MAP-6 — Evolução visual

```text
SVG
→ ícones
→ sprites simples
→ tilesets
→ Phaser quando necessário
```

## 9. Dependências de roadmap

Esta frente não é a próxima task imediata.

Executar preferencialmente depois de:

1. correções finais da migração React;
2. OAuth próprio da extensão;
3. leitura real do backend;
4. atualização automática;
5. primeira ação real;
6. movimento simples ou contrato de localização.

Um protótipo MAP-1 estritamente local pode ser antecipado quando ajudar a validar UX sem atrasar as dependências acima.

## 10. Critérios para Phaser

Considerar Phaser quando houver necessidade comprovada de:

- câmera complexa;
- milhares de tiles;
- animações;
- colisão em tempo real;
- spritesheets;
- movimentação contínua;
- efeitos visuais;
- combate tático animado;
- gerenciamento de cenas.

Não instalar Phaser apenas por expectativa futura.

## 11. Primeiro critério de aceite

Com uma seed fixa, gerar e renderizar:

- mapa pequeno;
- cidade ou vila;
- estrada;
- rio;
- ponte;
- Guilda dos Aventureiros;
- Ferreiro;
- Taverna;
- casas;
- nomes legíveis;
- seleção por clique;
- nenhuma dependência de arte externa;
- renderização idêntica nos hosts web e extensão.

## 12. Fora de escopo inicial

- pixel art final;
- mapa 3D;
- Phaser;
- pathfinding complexo;
- geração continental completa;
- combate tático completo;
- editor administrativo completo;
- autoridade mecânica no frontend.
