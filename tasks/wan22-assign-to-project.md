# Batch — Assign-to-project + image clips as project members (Phase 2.3)

Phase 2.1 ships project membership, but the only way to populate a project is by generating clips inside it (Phase 2.2). Existing clips can't be retroactively assigned. This batch closes that gap: a clip's project membership becomes editable from the gallery modal, and the project membership concept extends to image clips too.

Re-read CLAUDE.md before starting. Phases 2.1 and 2.2 must be merged before this batch runs.

---

## What to build

### 1. Make project membership editable from the modal sidebar

The gallery modal sidebar (per Phase 1.3) displays "Project: [name]" or "Project: None" for video clips. Phase 2.3 makes this row a clickable picker for both videos AND images.

UI pattern:

- The "Project: …" row becomes a button or dropdown trigger.
- Click → opens a small popover or inline picker.
- Picker contents:
  - List of all projects (sorted: most recently updated first), each with name + clip count
  - "None" option at top of the list
  - "+ Create new project" option at the bottom (opens the existing New Project modal from Phase 2.1; on success, auto-assigns the current clip to the newly created project, closes both)
- Search/filter input at the top of the picker if more than ~10 projects exist (cheap UX win, not load-bearing).

Selecting an option → POSTs to a new endpoint (below) → updates the modal sidebar's display in place → closes the picker.

### 2. New endpoint: `PATCH /api/generations/[id]/project`

Single-purpose endpoint for changing a clip's project membership.

Request:
```ts
{
  projectId: string | null;  // null = unassign from project
}
```

Response: `{ ok: true }` on success, 400 if projectId references a non-existent project, 404 if the generation doesn't exist.

Implementation:

1. Validate the generation exists.
2. Validate the projectId (if non-null) exists.
3. Update the row:
   - Set `projectId` to the new value (or null).
   - Recompute `position`:
     - If new `projectId` is null → set `position` to null.
     - If new `projectId` is non-null → set `position` to `max(position) + 1` for that project (or `1` if no clips yet). Same logic Phase 2.2 uses for new generations in a project.
4. Return.

The position recompute is "append to end" — matches the design call from earlier conversation. If the user wants the clip earlier in the sequence, they reorder via Phase 2.1's drag-and-drop after assignment.

If the clip was already in a project and is being moved to a different one, the old project loses the clip cleanly — no manual reordering of the old project's positions needed (gaps in `position` values are fine; sort by position handles them).

### 3. Allow images as project members

The data model already permits this — `Generation.projectId` isn't gated by `mediaType`. The only changes are UI surfaces that should now show image clips alongside video clips:

**Project detail view's linear strip (Phase 2.1):**

Image clips render as tiles in the strip alongside video clips. Use the existing image tile component from the gallery — same first-frame thumbnail logic doesn't apply (images have no first frame, they ARE the frame), so render `<img>` for images, `<video preload="metadata">` for videos. Tiles look the same shape and size; the duration badge appears only on video tiles.

The position number badge (Phase 2.1) appears on both image and video tiles.

**Stitch button behavior:**

This batch does NOT modify the stitch button or stitch flow. Phase 3 (already in PR #28 awaiting merge) currently stitches "all clips in the project" — once mixed-media projects exist, Phase 3 will encounter image clips and either fail or silently skip them depending on its implementation. Phase 3.1 will handle the selection UX properly.

In the meantime: if the user assigns images to a project and then clicks Stitch, the behavior is whatever Phase 3 produces. Don't add a defensive filter, don't add a warning. The user has been told (per the architect conversation) not to mix and stitch until Phase 3.1 ships.

The Stitch button itself stays disabled-when-fewer-than-2-clips per Phase 3 logic — count includes images. If a project has 1 image + 1 video, stitch button is enabled but will produce undefined behavior on click.

**Project card cover frame:**

The cover frame on the project listing card (Phase 2.1) currently shows the most recent project clip's localPath. This logic doesn't need a media-type aware update — the existing `<video preload="metadata">` pattern from Phase 2.1 silently degrades for images (a `<video>` tag pointed at an image URL renders nothing, breaks the thumbnail). Update the project card to detect mediaType and render `<img>` for image cover frames, `<video>` for video.

**Play-through (Phase 2.2):**

The play-through feature in Phase 2.2 chains video clips. It must filter to videos-only. Add the filter:

```ts
const playableClips = project.clips.filter(c => c.mediaType === 'video');
```

If a project has zero video clips (only images), the play-through button is hidden — same as the existing "fewer than 2 clips" rule. The button visibility check becomes "≥2 video clips."

**Generate-new-clip-in-project (Phase 2.2):**

The "Generate new clip in this project" button, when clicked, opens Studio in **Video mode** by default. That's the existing behavior. Don't change it — projects are video-first as a creative concept even when they hold image members.

If the user wants to add an image to a project, they generate the image normally (image mode, no project context), then assign it via the modal sidebar after the fact. Different pathways for different intents; matches "remix doesn't preload project context" from Phase 2.2.

The "Use last frame of previous clip" feature (Phase 2.2) needs a small adjustment: it pulls from the latest clip in the project. If that latest clip is an image, last-frame extraction doesn't apply — the image IS the frame. Two paths:

- **(a)** When the latest clip is an image, the "Use last frame" checkbox label changes to "Use this image as starting frame" and uses the image directly (no ffmpeg extraction).
- **(b)** When the latest clip is an image, the checkbox becomes "Use last frame of latest video" and skips images, finding the most recent video in the project.

(a) is simpler and matches user intuition. Use (a). If the project has zero videos AND the latest clip is an image, the checkbox label is "Use latest image as starting frame."

If the project is empty, the checkbox is hidden (existing Phase 2.2 behavior).

### 4. Project list filtering by media type

Add a small filter at the top of each project's linear strip: **All / Images / Videos** — same UI pattern as the gallery filter from Phase 1.3.

Optional but cheap. Sometimes you want to see only the videos in a mixed-media project to mentally plan the stitch. Default: All.

This filter is purely view-state; doesn't affect any backend, doesn't affect what stitch sees.

### 5. Bulk assign — explicitly out of scope for v1

Single clip at a time. No multi-select on gallery tiles, no "assign all selected to project X." If single-clip-at-a-time becomes painful, queue Phase 2.4 later.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `PATCH /api/generations/[id]/project` exists and behaves as documented.
- The gallery modal sidebar shows a clickable project picker for both image and video clips.
- The picker lists all projects with a "None" option and a "+ Create new project" option.
- Selecting a project updates the row's `projectId` and `position`; selecting "None" sets both to null.
- Project detail view's linear strip renders image clips alongside video clips with correct media-type-appropriate thumbnails.
- Project card cover frame renders correctly for both image and video covers.
- Play-through button hides when fewer than 2 video clips exist (regardless of total clip count).
- "Use last frame" checkbox in Phase 2.2 handles image-as-latest-clip case.
- The All/Images/Videos filter is visible on the project linear strip.

Manual smoke test (deferred to user):

1. Open the gallery modal for a video clip that's not in any project. Confirm the sidebar shows "Project: None" as a clickable picker.
2. Click the picker. Confirm the list of projects appears. Pick one. Confirm the sidebar updates immediately to show the project name. Refresh — confirm the assignment persisted.
3. Open the project detail view. Confirm the newly-assigned video appears in the linear strip at the end (highest position).
4. Open the gallery modal for an image. Confirm the same picker is available. Assign it to the same project. Refresh.
5. Open the project. Confirm the image clip appears in the strip as an `<img>` tile (no `<video>` tag, no duration badge), with its position number visible.
6. Confirm the project card cover frame renders correctly when the most recent clip is an image (visible `<img>`, not a broken `<video>`).
7. With both image and video clips in the project, confirm the play-through button is visible (assuming ≥2 video clips).
8. Try the "Use last frame of previous clip" checkbox in Phase 2.2's generation flow. With the latest clip being an image, confirm the label adapts ("Use latest image as starting frame") and the assignment uses the image directly without ffmpeg.
9. Try the All/Images/Videos filter. Confirm it shows the right subset.
10. Use the picker to move a clip from one project to another. Confirm it's removed from the first project's strip and appears at the end of the second project's strip.
11. Use the picker to set "None" on a clip currently in a project. Confirm the clip vanishes from the project's strip and `projectId` is null in the DB.
12. Use "+ Create new project" from the picker. Confirm a new project is created and the clip is auto-assigned to it.

---

## Out of scope

- Bulk assign / multi-select on tiles. Phase 2.4 if ever.
- Stitch button changes for mixed-media projects. Phase 3.1.
- Generating an image inside a project context (image mode + project preload). Out of scope; users assign post-hoc.
- Project membership for `isStitched: true` outputs (Phase 3 stitches). Out of scope; stitched outputs already have `parentProjectId` for the source-project relationship — they're not project members in the same sense.
- A "view all projects this clip belongs to" affordance — clips belong to at most one project.
- Reordering clips within a project from the gallery modal sidebar. The project detail view's drag-and-drop is the only reorder UX.
- A "move to project" right-click context menu on tiles. Modal sidebar is the only entry point.
- Showing an image's "starting-frame use count" or other relationship metadata. Out of scope.
- Auto-creating a project from a remix flow ("remix this video into a new project named X"). Out of scope.
- Any change to the `Generation` schema. The data model already permits everything in this batch.

---

## Documentation

In CLAUDE.md, find the Projects section. Update the model description to note that project membership applies to both image and video clips. Add a paragraph:

> Clips can be assigned to a project after creation via the gallery modal sidebar's project picker. Both image and video clips can be project members. The project detail view renders mixed-media linear strips with media-type-appropriate thumbnails and a per-strip All/Images/Videos filter. Stitch (Phase 3) currently treats all clips uniformly; the upcoming Phase 3.1 batch adds explicit clip selection.

Find the API routes table and add `PATCH /api/generations/[id]/project`.

When done, push and create the PR via `gh pr create` per AGENTS.md.
