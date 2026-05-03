# Batch — Stitch clip selection (Phase 3.1)

Phase 3 stitches all clips in a project. Phase 2.3 introduced mixed-media projects (images alongside videos), and even within pure-video projects there's a workflow gap: sometimes you want to stitch a subset (clips 1-5 but not 6-7, exclude experimental takes, etc.).

This batch adds an explicit clip-selection step to the stitch modal and enforces video-only stitching.

Re-read CLAUDE.md before starting. Phases 2.3 and 3 must be merged before this batch runs.

---

## What to build

### 1. Defensive video-only filter in the stitch route

The stitch route (`POST /api/projects/[id]/stitch` from Phase 3) currently fetches all project clips and passes them to ffmpeg. After Phase 2.3, projects can contain image clips. Update the route to filter clips before stitching:

```ts
const allClips = project.clips;  // already ordered by position
const videoClips = allClips.filter(c => c.mediaType === 'video');
```

If the request body specifies a `clipIds` array (new, see below), the route uses that selection instead. Otherwise it defaults to all video clips (preserves Phase 3 behavior for callers that don't specify selection).

If the resolved selection is empty or has fewer than 2 video clips: 400 with "Need at least 2 video clips to stitch."

### 2. Add `clipIds` to the stitch request body

Update `POST /api/projects/[id]/stitch` request shape:

```ts
{
  transition: 'hard-cut' | 'crossfade';
  clipIds?: string[];  // ordered list of generation IDs to stitch; optional
}
```

Validation:
- If `clipIds` is provided: every ID must reference a clip belonging to this project AND with `mediaType: 'video'`. Any non-video ID in the list → 400 with a clear error. (Don't silently filter out non-videos from a user-supplied list; if the client sent an image ID, that's a bug worth surfacing.)
- If `clipIds` has fewer than 2 entries → 400.
- The stitch order is the order of `clipIds`, not the project's `position` field. This lets the user reorder selection on the fly without committing to a project reorder.

If `clipIds` is omitted: default to all video clips in `position` order, same as today.

The DB row's `stitchedClipIds` field stores the actual list used, so future viewing of a stitched output reflects the real selection.

### 3. Stitch modal selection UX

Phase 3's stitch modal has a "Stitch N clips, total duration X.Xs" summary. Replace with an explicit selection UI:

**Layout:**

A scrollable area showing all videos in the project as rows (not tiles — a row per clip is more compact for selection). Each row:

- Checkbox (default checked).
- Position number (the project's `position` for this clip).
- Tiny thumbnail (~40px, video first frame).
- Prompt summary (60 chars, ellipsis on overflow).
- Duration label (e.g. "3.6s").
- Drag handle (optional in this batch; see below).

Above the list:

- "Select all" / "Deselect all" links.
- Live summary that updates as selections change: "Stitching 5 of 7 clips, total duration 18.2s".

Below the list:

- Transition radio group (Hard cut / Crossfade), unchanged from Phase 3.
- "Stitch" button (disabled if fewer than 2 selected).
- "Cancel" button.

**Image clips don't appear in this list at all.** The selection UI is video-only by design — the user should never see an image clip and wonder why it's not selectable. If a project has 0 video clips, the modal opens with an empty state explaining "This project has no videos to stitch."

### 4. Reorder within selection — defer

A drag handle on each row is tempting but adds complexity (drag-and-drop within a modal, recalculating state, etc.). Defer.

For v1 of selection: stitch order = the order of selected clips in the displayed list (which is `position` order). If the user wants a different stitch order, they reorder in the project detail view first (existing Phase 2.1 drag), then come back to stitch.

If reordering-without-committing-to-project-reorder becomes a real friction point, queue a Phase 3.1.1 follow-up. Don't preemptively build.

### 5. Submit logic

The stitch button submits the modal:

```ts
fetch(`/api/projects/${projectId}/stitch`, {
  method: 'POST',
  body: JSON.stringify({
    transition,
    clipIds: selectedClipIds,  // in displayed order
  }),
});
```

Stays in the queue tray flow from Phase 3 — the user closes the modal, the stitch job appears in the tray with progress and ETA (per Phase 3 + the watchdog/ETA batch).

### 6. Stitched output sidebar — show actual selection

Phase 3's gallery modal sidebar shows "Source clips: N" for stitched outputs. Update to reflect that N may be a subset:

> Source clips: 5 of 7 from project [name]

Where the "5 of 7" pattern shows how many were selected vs. how many videos the project had at the time of stitching. The source project's video count can change over time (clips added or deleted), but the stitched row's `stitchedClipIds` is immutable — derive the "of N" from the length of the array snapshot stored on the row.

If `stitchedClipIds` is missing or null (Phase 3 outputs created before this batch), fall back to the existing display ("Source clips: N" without the "of M" pattern).

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `POST /api/projects/[id]/stitch` accepts an optional `clipIds` array.
- The route validates that all `clipIds` reference video clips belonging to the project; non-video IDs return 400.
- Omitting `clipIds` falls back to all video clips in position order (Phase 3 behavior preserved for non-UI callers).
- The stitch modal shows a per-clip selection list with checkboxes (default-checked).
- The "Stitch" button is disabled when fewer than 2 clips are selected.
- The summary updates live as the user toggles selections.
- Image clips are absent from the selection list (not just disabled — invisible).
- Stitch button stays usable for pure-video projects with all clips selected (no regression).
- The stitched output's gallery sidebar shows "X of N from project Y" where appropriate.

Manual smoke test (deferred to user):

1. Open a project with 5 videos. Click Stitch. Confirm the modal shows 5 rows, all checked, summary "Stitching 5 of 5 clips."
2. Deselect 2 of them. Confirm summary updates to "Stitching 3 of 5 clips" and total duration recomputes.
3. Stitch with the partial selection. Confirm the resulting mp4 contains exactly the 3 selected clips in the order they appeared in the list. Confirm `stitchedClipIds` in the DB row matches the selection.
4. Open the stitched output in the gallery. Confirm the sidebar shows "Source clips: 3 of 5 from project [name]".
5. Add 2 image clips to the same project (Phase 2.3 affordance). Click Stitch again. Confirm the selection list still shows only the 5 videos — no image clips visible.
6. Try to use curl to POST to the stitch route with a `clipIds` array containing an image clip's ID. Confirm 400 with a clear error.
7. Try to use curl with `clipIds: []`. Confirm 400 ("need at least 2").
8. With a project containing 0 videos (only images), open the stitch modal. Confirm the empty state ("no videos to stitch") and the Stitch button is disabled.
9. Pre-Phase-3.1 stitched outputs (created before this batch) still display correctly in the gallery sidebar — the "of N" suffix is omitted gracefully.

---

## Out of scope

- Drag-to-reorder within the selection list. Defer to Phase 3.1.1 if friction emerges.
- Filter / search within the selection list (for projects with many clips). Out of scope; if you have 50 videos in a project that's its own UX problem.
- Saved selections / named compilations. That's Phase 3.2.
- Re-stitch with the same selection (clone-stitch button). Out of scope.
- Showing the previously-used selection on a re-open of the modal. Each modal open is a fresh selection, default-all-checked.
- Bulk-deselect by base model, by date, by Lightning state, etc. Out of scope.
- A keyboard-shortcut affordance for the modal. Out of scope.
- Confirming "you're about to skip clip 3, are you sure?" — the user knows what they're doing.

---

## Documentation

In CLAUDE.md, find the Phase 3 stitching section. Update:

> The stitch endpoint accepts an optional `clipIds: string[]` parameter for explicit selection. When provided, the array's order determines stitch order; when omitted, the route defaults to all video clips in the project's `position` order. All entries must reference video clips belonging to the project — image clips are rejected with 400 to surface client-side bugs early.
>
> The stitch modal exposes per-clip checkboxes (default all checked) and a live summary of selected count and total duration. Image clips are excluded from the selection list entirely; they exist in the project for organizational reasons but are never stitch candidates.

Find the API routes table and update `POST /api/projects/[id]/stitch` to mention the new optional field.

When done, push and create the PR via `gh pr create` per AGENTS.md.
