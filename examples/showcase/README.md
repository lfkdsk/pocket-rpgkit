# Feature Gallery

This is one PocketJS application containing a miniature monster-RPG town and
fourteen focused halls. Walk through a stone archway marked with the hall's
number, then talk to the hall's curator. Every demonstration can be triggered
again; the archway at each hall's entrance returns to the plaza.

Press **SELECT** to open demo controls. Each hall is also a validated chapter
entry, so the web player can jump straight to any showroom without reloading.

| Hall | What it demonstrates | Authoring source |
| --- | --- | --- |
| 1. Night Garden | Fade, named tints, flash, shake, camera, balloons, backdrop | [`halls/presentation.ts`](halls/presentation.ts) |
| 2. Fountain Magic | One-shot/looping Tuxemon animations, targets, layers, waits, stopping | [`halls/presentation.ts`](halls/presentation.ts) |
| 3. Costume Workshop | Character appearance, visual layers, live passage | [`halls/presentation.ts`](halls/presentation.ts) |
| 4. Town Park | Bounded wander, speed/run/stop/facing/through, path finding | [`halls/motion.ts`](halls/motion.ts) |
| 5. Oracle's Room | Extension-provided rows and pure state updates | [`halls/interactive.ts`](halls/interactive.ts) |
| 6. Tuxemon Arena | Bamboon, Bigfin, the battle UI kit, and win/lose/escape branches | [`halls/interactive.ts`](halls/interactive.ts) |
| 7. Market Square | Buying, selling, stock, wallet, and inventory | [`halls/interactive.ts`](halls/interactive.ts) |
| 8. Endless Grove | Streamed chunks, native animated water, 16×32 walkers | [`halls/system.ts`](halls/system.ts) |
| 9. Portrait Library | Live dialog theme selection and speaker portraits | [`halls/system.ts`](halls/system.ts) |
| 10. Cutscene Stage | `lockInput`, `unlockInput`, and `worldIdle` gating | [`halls/motion.ts`](halls/motion.ts) |
| 11. Post Office | Real `SaveMenu` rendering and save-code round trip | [`halls/system.ts`](halls/system.ts) |
| 12. Tour Pavilion | 10-second idle tour, takeover, and L rewind | [`halls/system.ts`](halls/system.ts) |
| 13. Sound Studio | BGM, ambience, music effects, sound effects, fades, pause and replay | [`halls/system.ts`](halls/system.ts) |
| 14. Registration Desk | Built-in name-input scene, player-name registration, and name-aware follow-up dialogue | [`halls/system.ts`](halls/system.ts) |

`showcase-data.ts` assembles the project. `gen-assets.ts` composes its streamed
maps, walkers, animation frames and battle art from the small attributed
Tuxemon source set, then emits the editor JSON, manifests and frozen attract
tape. `bun tools/showcase-screenshots.ts` regenerates the fifteen scene
screenshots and their contact sheet after the showcase bundle and wasm host
have been built.

Map art is assembled, never hand-numbered:

- [`showcase-objects.ts`](showcase-objects.ts) lists every prop as a source
  PNG, a pixel rectangle measured on that sheet, an anchor inside its cell
  footprint, the number of top rows drawn above characters, and the ground it
  may stand on. It also names the Tuxemon autotile blocks used for paths,
  paving, sand and water, the interior floors, rug and wall.
- [`showcase-art.ts`](showcase-art.ts) places those props per room, picks the
  edge and corner tile for every terrain boundary, and letters the archway
  plaques with the same baked bold 12 px font the runtime uses.
- `tests/showcase-art.test.ts` checks each rectangle is the whole, tight
  object on its sheet, that every placed copy reproduces the source pixels over
  its ground, that plants stand only on plain grass, and that every terrain
  boundary uses a transition tile.
- `bun tools/showcase-tile-review.ts` writes 3x review sheets (each room, and
  each prop as rendered next to its source rectangle) plus a per-prop pixel
  report from the live captures.

The showcase's art and audio files retain their individual licenses; most of
the artwork and its generated derivatives are CC BY-SA 4.0. See
[`ATTRIBUTION.md`](ATTRIBUTION.md) for every source file, author, license and
modification. Pocket RPG Kit code remains MIT licensed.
