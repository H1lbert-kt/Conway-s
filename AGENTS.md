# AGENTS.md

Conway's Game of Life (B3/S23) in the browser, focused on **millions of cells at ~60 fps**.

## Non-negotiable rules

1. **Fixed stack:** plain HTML + JavaScript (ES modules) + WebGL2. No frameworks, no bundler, no external dependencies.
2. **GPU simulation:** the rule runs in a fragment shader using ping-pong textures (1 pixel = 1 cell). Never compute generations on the CPU.
3. **No per-cell drawing:** no `fillRect`, no per-cell loops, no DOM element per cell.
4. **No GPU readback in the loop** (`readPixels`, etc.). Only allowed outside the loop, for exporting/importing patterns.
5. **No allocations in the render loop:** don't create objects, arrays, or textures per frame. Reuse buffers and textures.
6. **Toroidal grid** (wrapping edges) by default, with configurable size (powers of 2, up to `MAX_TEXTURE_SIZE`).
7. **Rule fidelity:** results must match Conway exactly. Validate with known patterns (glider, blinker, Gosper glider gun) before any optimization.
8. **Performance first:** any change that drops FPS on a 4096×4096 grid must be justified or reverted.
9. **Small, simple files:** one `index.html`, one `main.js`, separate shaders. Don't create extra structure unless I ask.
10. **Don't add features I didn't ask for.** When in doubt, ask first.

## Workflow: one stage = one GitHub issue

The issue is the single source of truth for each stage. Uses the `gh` CLI.
Planning is done by `/gt next` (plan mode). Implementation is done in build mode.

### Build mode
1. Read the issue and its latest plan (`gh issue view <number> --comments`) before touching any code.
2. Implement only what the plan says. Anything outside it needs my approval first.
3. Check off acceptance criteria in the issue as they are met (`gh issue edit <number> --body-file -`). Never remove or rewrite the original description or the plan.
4. Commit messages reference the issue (`#<number>`).
5. Never create, close, or delete issues. Closing is done only by `/gt next`.
6. If the plan and the code disagree, stop and tell me. Update the issue first, then continue.
7. Do not start the next stage. Stop when all criteria of the current one are checked.
