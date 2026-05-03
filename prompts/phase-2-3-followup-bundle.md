# Batch — Phase 2.3 / 3.1 follow-up bundle

Three issues discovered after Phase 2.3 (assign-to-project) and Phase 3.1 (stitch selection) merged. All small, all in adjacent areas of the project detail view and Studio. Bundled into a single PR.

Re-read CLAUDE.md before starting. Use `project_knowledge_search` to ground each change in actual code rather than guessing at file structure.

---

## Issue 1: Replace implicit "latest" starting frame with explicit picker

### Background

Phase 2.2 introduced "Use last frame of previous clip" as a checkbox that auto-selected the latest clip (by position) and extracted its last frame at submit time. Phase 2.3 expanded projects to mixed-media (images + videos) and added retroactive assignment, which complicates the implicit "latest" rule:

- "Latest" can mean position-latest or assignment-latest; ambiguous.
- The user can't see what frame they'll get until after generation completes.
- The current label ("Use latest image as starting frame (loaded on submit)") confidently asserts an action without visual confirmation.

Replace the boolean toggle with an explicit picker that shows what's about to happen.

### Required changes

**1. Replace the checkbox with a button.**

In Studio's video form, where the "Use last frame of previous clip" checkbox lives today, replace with:

- A "Choose starting frame" button (visible only when the project has at least one clip — same gating as the checkbox today).
- When a frame is selected: a thumbnail preview (~120px square) replaces the button area, showing the actual frame, with a "Change" button to reopen the picker and a × button to clear back to t2v.
- When no frame is selected: just the button.

The state stored in form state is the selected `Generation.id` (or `null` for t2v). At submit time, the client either:
- Resolves the selection's last frame via `/api/extract-last-frame` (for video selections) or uses the image directly (for image selections), then POSTs `mode: 'i2v'` with the resulting base64.
- POSTs `mode: 't2v'` if no selection.

**2. Build the picker modal.**

A modal showing all clips in the active project as tiles. Each tile:
- For images: render the image directly as the tile.
- For videos (clips and stitched outputs both): render the **last frame** of the video, extracted via `/api/extract-last-frame` at picker-open time. Cache extraction results in component state so reopening the picker doesn't re-extract.
- Position number badge in a corner (matching the project detail view's strip).
- For stitched outputs (no `position`): show "Stitched" instead of a position number.
- Selected tile is visually highlighted.

Picker behavior:
- Opens with the project's latest clip (highest `position` value) pre-selected. Use the existing `latestClipMediaType` / `latestClipFilePath` ProjectContext fields if they cleanly support this; otherwise compute from the project's clip list. The default-selection is purely a UX shortcut — user sees the modal opens with their likely choice already chosen, one "Confirm" click away.
- "Confirm" applies the selection and closes; "Cancel" closes without changing.
- If the project has no clips, the picker doesn't open (the button is hidden anyway per the gating rule).

**3. Lazy extraction.**

`/api/extract-last-frame` is called once per video tile when the picker opens, in parallel via `Promise.all`. Display a small loading state per tile while extraction is in flight. Cache results in component state (a `Map<generationId, string>` of frame data URLs) so reopening the picker doesn't re-trigger extraction.

If extraction fails for a specific tile, render the tile with an error state ("Couldn't load preview") and disable selection of that tile. Don't block the whole picker on a single failure.

**4. Submit-time logic.**

When the form submits with a starting frame selected:

1. Look up the selection by ID in the project's clips.
2. If `mediaType === 'image'`: read the image file, base64-encode, strip data-URI prefix.
3. If `mediaType === 'video'` (clip or stitched): call `/api/extract-last-frame` with the generation ID, get the base64. Use the cached frame from the picker if still valid; re-extract if not (the picker may have been opened/closed with cache cleared between).
4. POST to `/api/generate-video` with `mode: 'i2v', startImageB64: <base64>`.

The `latestClipMediaType` / `latestClipFilePath` ProjectContext fields are no longer load-bearing for the form's logic — they're now just defaults for the picker's pre-selection. Don't remove them in this batch (avoid scope creep), but mark them as "default-selection helpers only" in any comments.

### Out of scope

- Extracting last frames for all videos in the project on Studio mount (extract on picker open only, lazy).
- Showing intermediate-frame extraction (just last frame, same as today).
- A "use a different frame from this video" sub-picker. Last frame only.
- Pre-fetching frames for the picker the moment Studio loads. Wait for the user to click.
- Saving the user's last picker selection across sessions. Each Studio session starts with the position-latest default.

---

## Issue 2: Stitched outputs in the project linear strip

### Background

Phase 3 displays stitched exports in a separate section below the project's clip strip. Clicking a stitched export thumbnail does nothing (no in-app playback). Phase 2.3 made the strip mixed-media but kept the horizontal scroll. Combined effect: the strip wastes vertical space, stitched outputs are second-class, and clicking them does nothing useful.

Fix: stitched outputs become first-class members of the strip; the strip wraps instead of scrolls; the standalone "Stitched exports" section is retired.

### Required changes

**1. Strip layout: scroll → wrap.**

Replace the horizontal-scroll layout with a wrapping grid. Use whatever responsive grid pattern the existing Gallery view uses (CSS grid or `flex flex-wrap`) — match conventions. Tile sizing stays the same as the current strip's tile sizing; only the container layout changes.

Drag-to-reorder via `@dnd-kit/core` (per Phase 2.1) continues to work in the wrapping grid. `@dnd-kit/sortable` supports both linear and grid layouts; minimal changes if any. Verify by `project_knowledge_search` for the existing dnd-kit setup and adapt.

**2. Add stitched outputs to the strip query.**

The project detail view's API call (likely `GET /api/projects/[id]`) returns clips. Extend the query to also include stitched outputs joined via `parentProjectId`:

```ts
// In the route handler:
const clips = await prisma.generation.findMany({
  where: { projectId: id },
  orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
});
const stitched = await prisma.generation.findMany({
  where: { parentProjectId: id, isStitched: true },
  orderBy: { createdAt: 'asc' },
});
return { ..., clips, stitched };
```

Or merge them server-side into a single ordered list — agent's call based on what's cleaner against the existing route shape.

The client-side ordering for the merged list:
- Source clips (with `position`) sorted by `position ASC, createdAt ASC`.
- Stitched outputs (no `position`) sorted by `createdAt ASC` after all source clips.

A clean way to express this: use `(position ?? Number.MAX_SAFE_INTEGER), createdAt ASC` as the sort key.

**3. Tile rendering for stitched outputs.**

Stitched outputs render as video tiles (existing video tile component, since `mediaType === 'video'`). They get an additional "Stitched" badge in a corner — distinct visual position from the duration badge, so both can show at once. Use a different color/icon to make stitched outputs scannable when the filter is set to "All".

**4. Tile click → ImageModal.**

The existing image/video modal (Phase 1.3) handles `mediaType: 'video'` rows uniformly — including stitched outputs, since `isStitched: true` rows are still videos with valid `localPath`. Wire the click handler on stitched output tiles to open the modal exactly like clip video tiles do.

This is the bug fix half of Issue 2 — stitched outputs become playable in-app instead of download-only.

**5. Four-way filter.**

Replace the existing All/Images/Videos filter (per Phase 2.3) with **All / Images / Clips / Videos**:

- **All**: everything.
- **Images**: `mediaType === 'image'`.
- **Clips**: `mediaType === 'video' && !isStitched` — unstitched videos.
- **Videos**: `mediaType === 'video' && isStitched` — stitched outputs.

The terminology is the call here: "Clips" = source/raw videos, "Videos" = stitched outputs. This matches the user's mental model where they're producing "videos" by stitching "clips" together. Counterintuitive on first read, intuitive once internalized.

**6. Retire the standalone "Stitched exports" section.**

Remove the entire section from the project detail view. The strip is now the source of truth for everything in the project.

**7. Stitch button copy update.**

Phase 3.1's "no videos to stitch" empty state in the stitch modal becomes "no clips to stitch" — match the new terminology where "Clips" means unstitched videos.

The stitch selection list still excludes images (per Phase 3.1) and now also excludes already-stitched outputs (since stitching a stitched output recursively makes no sense). Verify the selection-list query filters by `mediaType === 'video' && !isStitched`. If it doesn't, fix it.

### Out of scope

- Drag-to-reorder of stitched outputs (they have no project position, sort by createdAt is sufficient).
- Schema changes — the existing `isStitched` boolean and `parentProjectId` foreign key are sufficient.
- Gallery view changes — single-tile rendering with the Stitched badge stays as-is from Phase 1.3.
- Showing the source clip count on stitched output tiles ("3 of 5 stitched"). The modal sidebar already shows this per Phase 3.1.
- A "re-stitch this output with different selections" affordance. Out of scope.

---

## Issue 3: Friendly-name fallback fixes

Two trivial fixes related to LoRA name handling.

**Fix A: defensive fallback in Studio.tsx.**

The line `friendlyName: modelLists.loraNames[e.loraName] ?? e.loraName` (somewhere in Studio.tsx — `project_knowledge_search` to find it) falls back to the obfuscated `loraName` when the friendly-name lookup fails. If a project's `defaultVideoLoras` references a deleted LoRA, the obfuscated hex string lands in workflow `_meta.title` — exactly the leak the obfuscation pattern exists to prevent.

Replace with:

```ts
friendlyName: modelLists.loraNames[e.loraName] ?? '(unknown LoRA)'
```

Search the codebase for similar patterns:

```bash
grep -rn "loraNames\[.*\] ?? " src/
grep -rn "loraNames\[.*\] ||" src/
```

Apply the same fallback fix to any other site that falls back to the raw filename. Document any sites changed in the PR description.

**Fix B: image-side LoraLoader missing _meta.title.**

The Wan video LoRA injection (Phase 1.4b) sets `_meta: { title: \`LoRA (high): ${friendlyName}\` }` on every `LoraLoaderModelOnly` node. The image-side `LoraLoader` injection has no `_meta.title` field at all (verified by reading `src/lib/workflow.ts` — confirm via `project_knowledge_search`).

Not a leak — there's nothing to leak when the field is absent — but inconsistent with the video side. Add `_meta: { title: \`LoRA: ${friendlyName}\` }` to the image-side `LoraLoader` injection for symmetry. Use the LoRA's friendly name from the existing data flow (whatever the image-side builder already has access to).

If the image-side builder doesn't currently have `friendlyName` available in its scope (only has `loraName`), the agent has two options:

- **(a)** Pass `friendlyName` through from the call site.
- **(b)** Look up `friendlyName` from `LoraConfig` at build time.

(a) is cleaner — the call site already has the data, no extra DB read needed. Match whatever `useModelLists`-derived structure the call site uses.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- The Studio video form's starting-frame UI is a button that opens a picker modal, not a checkbox.
- The picker modal shows tiles for all project clips (images, videos, stitched) with last-frame previews extracted lazily and cached.
- Selecting a tile and confirming populates the form; clearing returns to t2v.
- The project detail view's strip wraps to multiple rows instead of horizontally scrolling.
- Stitched outputs appear in the strip with a "Stitched" badge.
- Clicking a stitched output tile opens the existing video modal and plays the video.
- The four-way filter (All / Images / Clips / Videos) works and uses the terminology defined above.
- The standalone "Stitched exports" section is gone.
- The stitch modal's empty-state copy is "no clips to stitch."
- `grep -n "loraNames\[.*\] ?? " src/` returns no matches that fall back to the raw `loraName`. Each match either uses `'(unknown LoRA)'` or has a justified non-leak fallback documented in the PR.
- Image-side `LoraLoader` injection has a `_meta.title` field using `friendlyName`.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. Open Studio in video mode with a project active. Confirm the starting-frame UI is a button, not a checkbox.
2. Click "Choose starting frame." Confirm the modal opens with the project's latest clip pre-selected. Last frames of videos are visible (loading briefly first if not cached). Click a different tile, confirm. Confirm the thumbnail preview appears in the form.
3. Click "Change" on the preview. Picker reopens with the previous selection retained. Cancel, no change. Reopen, click ×. Confirm cleared back to no preview (t2v).
4. Generate with a video selection. Confirm the resulting clip starts visually where the source video's last frame is. Generate with an image selection. Confirm starts where the image is.
5. Open a project with 10+ items. Confirm the strip wraps onto multiple rows. Confirm tiles drag-reorder cleanly across rows.
6. Stitch the project. After stitch completes, return to project view. Confirm the stitched output appears as a tile in the strip with a "Stitched" badge. Click the tile — confirm the modal opens and the video plays.
7. Try each filter: All shows everything, Images filters to images, Clips filters to unstitched videos, Videos filters to stitched outputs.
8. Confirm the standalone "Stitched exports" section is gone.
9. Open the stitch modal on a project with no unstitched videos (only images and a previous stitch). Confirm the copy says "no clips to stitch."
10. Set a project's `defaultVideoLoras` to reference a real LoRA, then delete that LoRA from the Models tab. Open Studio, click "Generate new clip in this project." The form's pre-fill should show '(unknown LoRA)' for the deleted entry, not the obfuscated hex.
11. Generate an image with a LoRA in the stack. Capture the workflow JSON sent to ComfyUI. Confirm the image-side `LoraLoader` node now has `_meta.title` matching the friendly name.

---

## Out of scope

(Per-issue out-of-scope already listed in each section above.)

Cross-cutting:
- Renaming `clip` to `item` throughout the codebase. The "items" terminology was discussed in earlier prompts but isn't scoped here. The new four-way filter uses "Clips" and "Videos" as user-facing labels — that's a UX choice, not a codebase rename.
- Refactoring `latestClipMediaType` / `latestClipFilePath` out of ProjectContext. They're now just default-selection helpers for the picker; renaming or removing them is its own batch.
- Auditing all `_meta.title` fields across the codebase for friendly-name compliance. Scope is the LoRA path only.

---

## Documentation

Update CLAUDE.md:

- Find the Phase 2.2 starting-frame description. Replace with the new picker UX. Note the lazy extraction and caching behavior.
- Find the Phase 3 / 3.1 stitched-exports description. Update to reflect that stitched outputs are now first-class strip members, not a separate section. Update the filter description to four-way.
- Find the LoRA obfuscation rule (added by Phase 1.4b). Add a sentence: "Friendly-name fallback patterns must use a literal placeholder (e.g. '(unknown LoRA)'), never the obfuscated `loraName`. Falling back to the raw name re-introduces the leak the pattern exists to prevent."

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
