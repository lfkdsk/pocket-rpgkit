# Studio interaction design

This page defines the interaction and visual contract for Studio's navigation
and map-authoring helpers. They are editor view state only: project changes
still go through `editor/api`, and none of these controls add fields to
`rpgkit-project/v1` or to sharded packs.

## Find and act

`Ctrl/Command+K` opens a centered command palette. Its search is fuzzy across
an action's label, id and context, and results are grouped as actions, maps,
events and event commands. Up/Down changes the active row, Enter runs it and
Escape closes the palette; focus returns to the element that opened it.
Recently run entries sort ahead of otherwise equal matches and are stored as a
bounded host preference. The catalog includes file actions, undo/redo, tools,
layers and visibility, fit/zoom, play-test, every map, events and commands on
the open map, and every insertable command kind when an event page is selected.
Only the map catalog is read globally: a sharded project never loads other map
files merely because the palette opened. A toolbar search button exposes the
same feature without requiring the shortcut.

## See and navigate the map

The lower-right minimap shows the cached ground bitmap plus high-contrast event
dots. It is at most 184 by 136 CSS pixels and preserves the map aspect ratio.
The current viewport is an accent-coloured rectangle. Clicking centers that
point; dragging the rectangle pans continuously. The thumbnail is regenerated
only when the map, document revision or art revision changes, then reused for
view-only updates, so panning a large map redraws only the small overlay.

A compact layers card sits in the canvas's upper-right corner. Ground, upper, passage and events
each have an eye toggle and an opacity slider. The active editing layer has an
accent bar; edges use the passage presentation row because they share its
overlay. `1`–`4` keep selecting editing layers and `Shift+1`–`Shift+4` toggle
ground, upper, passage and events visibility. Visibility and opacity are view
state and never change project bytes.

Wheel and trackpad gestures update a target camera while animation frames ease
the displayed camera toward it. Zoom remains anchored to the pointer in map
space. A released Space/middle-button pan continues briefly from recent pointer
velocity and decelerates; bounds remain intentionally soft so the map can be
positioned beside overlays. **View settings** offers Follow system, Full motion
and Reduced motion. Follow system disables interpolation and inertia when the
host reports `prefers-reduced-motion`; Reduced motion always disables them.
Fit, keyboard zoom, minimap jumps and problem reveals are immediate in reduced
motion mode.

## Inspect without leaving the canvas

After a short stationary hover over an event, a non-interactive card shows its
sprite (or the same deterministic placeholder as the canvas), name/id, active
page trigger and the first three meaningful command summaries, including text
lines. It chooses the side with more free space and is clamped inside the
canvas host, so it does not cover the hovered event when another side is
available. It disappears on pointer movement to another cell, drag, editing,
map change or hidden events. Selecting an event remains a click, not a hover.

## Choose tiles

The tile panel searches by sheet name, full tile id or numeric cell id. Search
results are keyboard-focusable tiles and never alter the declared sheet list.
A star toggles a bounded, host-persisted favorites strip; recently used tiles
stay in most-recent order. Dragging across the sheet selects a rectangular
tile region, with its dimensions shown next to the brush. Painting repeats
that pattern from the stroke's first cell; the commit sends parallel `cells`
and `values` arrays through the additive patterned form of `paint-cells`, so
even a large inline project is parsed, validated and serialized only once and
the stroke remains one patch and one undo step. A click remains a one-tile
selection. Passage and edge brushes keep their existing behavior.

## Visual language and empty states

Cards, the command palette, hover card, notices and drop feedback use existing
theme variables (`--panel`, `--panel-2`, `--raised`, `--border`, `--text`,
`--muted`, `--accent`, `--danger`, `--ok`, `--warn`, `--shadow`) and derive
translucent fills with `color-mix`; no light- or dark-only literal is used.
Open/close, selection and toast motion share short 120–180 ms transitions.
The reduced-motion media query and setting reduce these to an effectively
instant transition. Empty project, empty map/event list, empty command page and
no tile-search result states state what is absent and offer the next valid
action. Toasts use `status` for success/information and `alert` for errors,
remain dismissible, and never cover the inspector or tile panel.

The browser and desktop builds use the same DOM implementation and preferences
through `StudioHost`; the PocketJS in-game editor is unchanged because no data
or edit protocol changed.
