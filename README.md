# Conway's Game of Life

Simulação do Jogo da Vida de Conway (B3/S23) no navegador, feita para rodar **milhões de células a ~60 fps**: HTML + JavaScript (ES modules) + WebGL2, com a simulação inteira executando em shader (ping-pong textures), sem dependências externas e sem desenhar célula por célula na CPU.

![Gosper glider gun rodando com HUD de fps/gen por segundo](assets/demo.gif)

![Screenshot: toolbar, gun emitindo gliders e HUD](assets/screenshot.png)

## Rodando localmente

Os ES modules exigem HTTP (não funciona abrindo o `index.html` via `file://`):

```bash
python3 -m http.server 8000
# abra http://localhost:8000/
```

Qualquer servidor estático serve (`npx serve`, `php -S`, etc.). Não há build, bundler ou dependência de runtime.

### Parâmetros de URL

| Parâmetro | Efeito |
|---|---|
| `?size=2048` | Tamanho do grid (potência de 2, limitado por `min(4096, MAX_TEXTURE_SIZE)`). Padrão: 1024. |
| `?sps=30` | Gerações por segundo iniciais (1–120 via slider; o parâmetro é o valor de carga). |
| `?seed=demo` | Estado inicial determinístico (PRNG mulberry32 com seed fixa). `?seed=<n>` usa o inteiro informado. Sem parâmetro: grid vazio. |

## Controles

| Controle | Ação |
|---|---|
| **Play / Pause** | Liga/desliga o stepping automático do loop. |
| **Step** | Avança exatamente 1 geração (estando pausado). |
| **Speed** | Slider de gerações por segundo (1–120). Escalar puro — nenhuma alocação por frame. |
| **Grid** | Troca o tamanho do grid (1024/2048/4096). Realoca texturas/FBOs **uma única vez, fora do loop**, e reseta o estado. Opções acima de `min(4096, MAX_TEXTURE_SIZE)` ficam ocultas. |
| **Clear** | Zera o grid — um único upload `texSubImage2D` de um buffer zero pré-alocado. |
| **Randomize** | Preenche ~50% das células — preenche um buffer reutilizado e faz um único upload. |
| **Paint: on/off** | Alterna entre pintar e pan. Roda do mouse (zoom) funciona nos dois modos. |
| **Brush** | Tamanho do pincel (1–64 → raio). |
| **Pattern** | `Brush` pinta células; `Glider`/`Blinker`/`Gosper gun` dão o padrão inteiro no clique. Colocação é envolvida no toro (a borda direita continua na esquerda). |
| **Arrastar** | Pan (com pintura desligada) ou pintura contínua (com pintura ligada). |
| **Zoom** | Roda do mouse, centrado no cursor. |

## Validação (fidelidade da regra)

```bash
npm install   # só playwright-core, dev-dependency do harness
npm test
```

O harness (`tests/run.js`, Playwright + Chromium headless) roda **52 verificações** (os 49 testes originais, intocados, + 3 da Stage 6) e imprime PASS/FAIL por critério, com exit code ≠ 0 em falha. Ele valida:

- **Fidelidade bit-a-bit contra uma referência CPU da B3/S23**: blinker, block, glider (interior e **atravessando a costura do toro**), e Gosper gun por 60 gerações.
- **Golden do Gosper gun** (valores canônicos, não só CPU-vs-GPU): população **36/41/46** nas gerações 0/30/60 em grid 128², e os offsets exatos dos gliders emitidos (fixados no teste, derivados da referência CPU e conferidos contra as populações canônicas).
- Câmera: zoom mantém o ponto sob o cursor, pan com delta exato, resize preserva/redimensiona a vista.
- Interações: pintura em duas posições de câmera distintas, wrap nas costuras (borda e canto), patterns via DOM e via hooks, troca de grid 64→2048→4096 mantendo a regra.
- Uploads únicos de clear/randomize (contadores de `texSubImage2D`/`texImage2D`/`deleteTexture` no protótipo WebGL).
- **Higiene do loop**: 0 `readPixels` e 0 alocações de GL no loop de render; sem erros de página em toda a suíte.
- HUD (formato, cadência ~1 Hz) e determinismo do `?seed=`.
- **Byte layout (Stage 6):** células morta/viva com máscaras Conway gravadas, idade que sobe 1 por geração e satura em 127, morte zerando a idade e mantendo as máscaras (via `readRaw`).

O `readPixels` acontece **exclusivamente** no caminho de validação/teste, fora do `requestAnimationFrame`.

## Resultados medidos

Ambiente: Chromium headless + **SwiftShader (rasterizador por software)** — ou seja, roda a CPU, não a GPU. Máquina de medição: Linux x86_64 (out/2026). Página isolada por medição, janela de 2 s. Números absolutos variam com a carga da máquina; o que importa são as **classes** (display independe do grid; sim cresce com O(size²)).

| Cenário (Stage 6 — byte layout) | fps | Observação |
|---|---|---|
| Só display (sim pausada) @64² | ~60 | Display amostra a textura na tela. |
| Só display (sim pausada) @4096² | ~60 | **Igual à 64²** — o custo do display é O(pixels de tela), não O(grid). |
| Sim + display @64² (`sps=120`) | ~162 | 64² fragmentos de sim são triviais. |
| Sim + display @4096² (`sps=120`) | **~4.5–10.5** | 16.7M fragmentos × 9 `texelFetch` no rasterizador de **software**. |

Referência da Stage 5 (antes do byte layout, sob carga alta): display ~27 fps em 64² **e** 4096²; sim+display ~146–162 fps @64², ~4.5–6 fps @4096² — o decode por round-trip da Stage 6 é neutro dentro da variância de carga (o custo dominante continua sendo o rasterizador de software).

**Análise (evidência de profiling):** o shader de sim é O(size²) em fragmentos. Sob SwiftShader isso vira ~16.7M iterações de shader por geração na CPU — o gargalo é o rasterizador de software, não o código. Os testes de higiene e de classe (display @4096² na mesma classe que @64²) mostram que não há regressão arquitetural; em GPU real o fragmento shader de 16.7M texels é exatamente o tipo de carga paralela que placa gráfica resolve.

> **Sign-off do alvo de 60 fps (owner):** os números acima são de software GL (Chromium headless + SwiftShader). **Assinado e aceito pelo owner** — a meta de ~60 fps @4096² fica documentada como pendente de validação em hardware real; o shortfall (4.5–10 fps em software vs alvo) está aprovado como resultado do rasterizador de software, não como regressão arquitetural (evidência: display-only igual em 64² **e** 4096², sim+display 146–162 fps @64²). Números de GPU real, quando medidos, vão para a tabela acima *(issue #5 — critério de aceite fechado com sign-off)*.

## Encoding da regra e da malha

- **1 texel = 1 célula**; o estado vive em duas texturas RGBA8 em ping-pong (`textures[read]` → `textures[write]`), cada uma com seu FBO.
- **Byte layout por texel** (Stage 6): `R = (idade << 1) | viva` (idade = gerações consecutivas vivas, satura em 127); `G = máscara de nascimento` (bit n = nasce com n vizinhos; Conway B3 = `0b00001000`); `B = máscara de sobrevivência` (Conway S23 = `0b00001100`); `A = bit0 nasce com 8, bit1 sobrevive com 8, bits 2-7 id de linhagem` (0 no modo Conway).
- **Encoding normalizado:** RGBA8UI (renderização para texturas inteiras) não está disponível no stack de referência — sem `EXT_color_buffer_integer`, draws em FBOs inteiros produzem lixo (evidência na issue #6). Os bytes viajam como floats normalizados (v/255) e os shaders decodificam com `int(v * 255.0 + 0.5)` — **lossless para todos os 256 valores de byte** em highp, portável em qualquer WebGL2. Acima da linha de decode, o layout é byte a byte o especificado.
- **Linha de base:** índice `y * size + x`, com `y = 0` na **base** (`gl_FragCoord` é y-up; o upload via `texSubImage2D` usa a mesma convenção).
- **Regra B3/S23** em `shaders/sim.frag.glsl` (Stage 6): a expressão Conway `alive = (n == 3) || (self && n == 2)` indexada pelo **bit0 de R**; máscara G/B/A são gravadas mas **ainda não consumidas** (consumo de genoma chega na Stage 7). Vizinhança por `texelFetch` + módulo `(q + size) % size` (toro).
- Display pinta célula viva em `rgb(235,240,255)` e morta em `rgb(11,11,16)`, decodificando o bit0.
- **Pintura/patterns/seed** entram por `texSubImage2D` direto na textura viva (até 4 splits quando o retângulo cruza a borda), escrevendo o byte layout (viva = `(1,8,12,0)`, morta = `(0,8,12,0)`). Sem alocação por evento (`patchBuf`/`packBuf`/`fullBuf` alocados uma vez).
- A próxima geração é **consumida do texel `read`** no passo seguinte — pinturas caem estritamente entre passos (single-threaded).
- Hooks de validação: `__life.read()` devolve canal 0 como 0/255 (contrato do harness); `__life.readRaw()` devolve os bytes brutos do layout — só fora do loop.

## Como foi desenvolvido

Este repositório é também um experimento de **orquestração por agente** — o desenvolvimento foi conduzido com o opencode e duas comandos customizadas, com a issue do GitHub como única fonte da verdade de cada etapa:

- **`AGENTS.md`** define as regras inegociáveis do projeto (stack fixa, simulação só na GPU, zero alocação no loop, fidelidade validada, etc.) e o fluxo de build.
- **Agente `gt`** (em `~/.config/opencode/agents/gt.md`): um agente **só de planejamento** — ele só lê o código, explora o repo e escreve planos; **nunca edita arquivos**. Ele tem permissão para `gh issue *` (abrir/comentar/fechar issues), leitura e execução de testes, mas nada de escrita em código.
- **`/gt <repo>`** — cria uma issue por etapa, em ordem, com label `stage`.
- **`/gt next`** — se a etapa atual está `planned`: confere os critérios de aceite; se todos marcados, **fecha** a issue e passa a planejar a próxima com o agente `gt` (Goal, Scope, abordagem, passos, critérios `- [ ]`, riscos), adicionando o label `planned`. Se algo falta, lista o que falta e para. Também serve para planejar a primeira etapa e, com `remove` do label `planned`, para replanejar.
- **Modo Build** — implementa o plano na issue, marca os critérios conforme são atendidos, e commita apenas via **`/cp gt`** (que anexa `(#N)` da issue da etapa na mensagem do commit convencional).
- **`/gt skip`** — pula a etapa atual (comenta, label `skipped`, fecha como *not planned*) e segue para a próxima.

Fluxo completo por etapa:

```
planejar na conversa  →  /gt <repo>  →  /gt next (planeja a etapa N na issue)
        ↑                                          ↓
        │                                    modo Build (implementa,
        │                                     testa, marca critérios)
        └────────────  /gt next (confere, fecha N, planeja N+1)  ─────────
```

Labels: `stage` (toda issue de etapa), `planned` (planejada/em implementação), `skipped` (pulada). Nenhuma etapa avança enquanto a anterior estiver aberta, exceto com `/gt skip`.

> **Para quem quiser usar esse workflow:** vou criar um **repositório/documentação dedicado** (comandos `/gt` e `/cp`, agente `gt`, `AGENTS.md` de exemplo e o passo a passo completo), para que qualquer pessoa possa usufruir do método em qualquer projeto. Fique de olho neste repositório — o link deve aparecer aqui quando ficar pronto.

### Issues por etapa

| Etapa | Issue | Status |
|---|---|---|
| 1 — Scaffold e contexto WebGL2 | #1 | fechada |
| 2 — Núcleo de simulação GPU (B3/S23, ping-pong) | #2 | fechada |
| 3 — Renderização e câmera (pan/zoom) | #3 | fechada |
| 4 — Interação, patterns e controles | #4 | fechada |
| 5 — Validação e performance em escala | #5 | esta |

## Regras do projeto

Veja [AGENTS.md](./AGENTS.md) — stack fixa (HTML + JS + WebGL2, sem framework/bundler), simulação sempre na GPU, zero alocações no loop de render, fidelidade à regra B3/S23 validada com glider, blinker e Gosper glider gun, e performance primeiro.

## Estrutura

```
index.html      página + toolbar + HUD (sem framework)
main.js         app WebGL2: context, sim pass, display pass, uploads, controles
shaders/        sim.vert / sim.frag (B3/S23) / display.frag
tests/run.js    harness headless (npm test)
assets/         screenshot + gif usados neste README
```
