# Conway's Game of Life

Simulação do Jogo da Vida de Conway (B3/S23) no navegador, feita para rodar **milhões de células a ~60 fps**: HTML + JavaScript (ES modules) + WebGL2, com a simulação inteira executando em shader (ping-pong textures), sem dependências externas e sem desenhar célula por célula na CPU.

## Sobre este repositório

Além do projeto em si, este repositório é um experimento de **novas práticas de orquestramento**:

- **Agente autônomo**: o desenvolvimento é conduzido por um agente que criei e estou usando (opencode, com as instruções em [`AGENTS.md`](./AGENTS.md)), que opera em dois modos — *plan mode* (só planeja, não toca em código) e *build mode* (implementa).
- **Método das issues**: cada etapa do projeto é uma issue no GitHub, com o plano completo (goal, escopo, abordagem, passos, critérios de aceite e riscos) comentado na própria issue, que vira a **única fonte da verdade** da etapa.
- **Labels como estado**: `stage` (toda issue de etapa), `planned` (etapa planejada/em implementação), `skipped` (etapa pulada).

### Fluxo

1. Planejar as etapas na conversa.
2. `/gt <repo>` → cria uma issue por etapa, em ordem, com label `stage`.
3. `/gt next` → planeja a etapa atual na issue e adiciona `planned`.
4. Modo Build → implementa e marca os critérios de aceite na issue.
5. `/gt next` → confere os critérios, fecha a etapa e planeja a próxima.
6. Repetir até acabar.

Nenhuma etapa avança enquanto a anterior estiver aberta (exceto com `/gt skip`).

## Regras do projeto

Veja [AGENTS.md](./AGENTS.md) — stack fixa (HTML + JS + WebGL2, sem framework/bundler), simulação sempre na GPU, zero alocações no loop de render, fidelidade à regra B3/S23 validada com glider, blinker e Gosper glider gun, e performance primeiro.
