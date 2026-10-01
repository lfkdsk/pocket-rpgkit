# Feature Gallery

This is one PocketJS application containing a lobby and twelve focused rooms.
Walk onto a numbered lobby portal, read the room label, then talk to its
curator. Every demonstration can be triggered again; the glowing pad beside
the entrance returns to the lobby.

Press **SELECT** to open demo controls. Each hall is also a validated chapter
entry, so the web player can jump straight to any showroom without reloading.

| Room | What it demonstrates | Authoring source |
| --- | --- | --- |
| 1. Screen Effects | Fade, named tints, flash, shake, camera, balloons, backdrop | [`halls/presentation.ts`](halls/presentation.ts) |
| 2. Map Animations | One-shot/looping animations, targets, layers, waits, stopping | [`halls/presentation.ts`](halls/presentation.ts) |
| 3. Runtime Appearance and Layers | Character appearance, visual layers, live passage | [`halls/presentation.ts`](halls/presentation.ts) |
| 4. Movement Lab | Bounded wander, speed/run/stop/facing/through, path finding | [`halls/motion.ts`](halls/motion.ts) |
| 5. Extensions & Dynamic Choices | Extension-provided rows and pure state updates | [`halls/interactive.ts`](halls/interactive.ts) |
| 6. Battle Arena | Battle UI kit plus win, lose, and escape branches | [`halls/interactive.ts`](halls/interactive.ts) |
| 7. Shop | Buying, selling, stock, wallet, and inventory | [`halls/interactive.ts`](halls/interactive.ts) |
| 8. Streamed World | Streamed chunks, native animated tiles, 16×32 walkers | [`halls/system.ts`](halls/system.ts) |
| 9. Themes & Portraits | Live dialog theme selection and speaker portraits | [`halls/system.ts`](halls/system.ts) |
| 10. Cutscene & Input Lock | `lockInput`, `unlockInput`, and `worldIdle` gating | [`halls/motion.ts`](halls/motion.ts) |
| 11. Saves & Save Codes | Real `SaveMenu` rendering and save-code round trip | [`halls/system.ts`](halls/system.ts) |
| 12. Attract Tour & Rewind | 10-second idle tour, takeover, and L rewind | [`halls/system.ts`](halls/system.ts) |

`showcase-data.ts` assembles the project. `gen-assets.ts` emits the editor
JSON, stream pak entries, procedural images, manifests, and frozen attract
tape. The runtime entry in `showcase.tsx` registers extensions and battle UI
and owns the theme/save demonstration shell.
