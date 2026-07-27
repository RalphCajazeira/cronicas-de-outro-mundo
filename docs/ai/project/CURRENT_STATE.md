# Estado Atual — Compatibilidade

**Atualizado em:** 2026-07-27

Este caminho é preservado para compatibilidade com prompts e referências anteriores.

A fonte viva atual é:

[`PROJECT_STATE.md`](PROJECT_STATE.md)

Use também:

- [`ROADMAP.md`](ROADMAP.md) para a ordem executável;
- [`DECISIONS.md`](DECISIONS.md) para decisões transversais.

## Motivo da mudança

O documento anterior misturava:

- arquitetura centrada no widget;
- GPT Actions como fachada principal;
- baselines antigas;
- funcionalidades integradas, implantadas e apenas planejadas.

A arquitetura atual é:

```text
GPT personalizado
→ Instructions + Knowledge + App MCP
→ narrativa e interpretação

Extensão Chromium
→ frontend principal
→ overlay/full-page e página própria

Backend
→ autoridade, regras e persistência

Widget
→ fallback e diagnóstico

Actions no GPT
→ legado temporário
```

## Regra

Não atualizar este arquivo com uma segunda cópia do estado.

Toda mudança futura deve atualizar:

- `PROJECT_STATE.md` quando mudar capacidade ou evidência;
- `ROADMAP.md` quando mudar ordem ou escopo das próximas tasks;
- `DECISIONS.md` quando mudar arquitetura ou decisão transversal.