# Fix bundle — Phase 5d / Phase 6 issues

Five distinct bugs landed in the 5d/6 batches. Most are small. The biggest is the keyframe-checkpoint detection (which makes Phase 6 unusable today). Bundling them together because they all touch the same surfaces (ProjectDetail, the canonical pickers, the stitch route).

Re-read CLAUDE.md before starting. Disk-avoidance contract is unaffected — no workflow / WS / finalize changes.

---

## Issue 1: Keyframe says "no image checkpoint available" when one IS selected

**Symptom.** Tapping "Generate keyframe" produces the error `"Keyframe: No image checkpoint available. Select one in Studio first."` even when the user has selected an image checkpoint in Studio.

**Root cause.** Phase 6's `handleGenerateKeyframe` calls a `readLastUsedImageCheckpoint()` helper that the prompt described as "reads from sessionStorage the same key Studio uses to persist the user's last-selected image checkpoint." But Studio doesn't persist its checkpoint to sessionStorage — checkpoint lives in component state (`p.checkpoint`) and resets on tab unmount. The helper has nothing to read, returns null, and the next-line fallback to `modelLists.checkpoints[0]` may also be misfiring (perhaps `modelLists` not initialized yet at the moment ProjectDetail renders).

**Fix.** Two-part. Make ProjectDetail's keyframe handler resolve a checkpoint from a real source, not a fictional sessionStorage key.

### Part 1A — Add a default-image-checkpoint to project settings

Schema (Prisma):

```prisma
model Project {
  // ... existing fields ...
  defaultCheckpoint String?   // image checkpoint name, e.g., "sdxl_pony_v6.safetensors"
}
```

Apply via `npx prisma db push`. Existing projects backfill with null.

ProjectDetail's settings modal gets a new field:

```
Default image checkpoint  [ <dropdown of checkpoints> ▼ ]
                           Used for keyframe generation. Falls back to your
                           last-used image checkpoint if not set.
```

Dropdown lists `modelLists.checkpoints` (already loaded). Default option "(none)" maps to null. PATCH `/api/projects/[id]` accepts the field.

The `/api/projects/[id]/route.ts` PATCH handler accepts `defaultCheckpoint: string | null` and writes it.

### Part 1B — Persist Studio's last-used image checkpoint

In `Studio.tsx`, find `handleCheckpointChange(newCheckpoint)`. After the existing logic, add:

```ts
try { sessionStorage.setItem('studio-last-image-checkpoint', newCheckpoint); } catch { /* ignore */ }
```

Same pattern in `handleInitialCheckpoint(newCheckpoint)` for parity.

This gives a real sessionStorage key for the keyframe handler to read.

### Part 1C — Fix `handleGenerateKeyframe` resolution order

In ProjectDetail's `handleGenerateKeyframe`:

```ts
function resolveKeyframeCheckpoint(): string | null {
  // 1. Project default (most explicit user intent)
  if (project.defaultCheckpoint) return project.defaultCheckpoint;

  // 2. Studio's most recently used image checkpoint (sessionStorage)
  try {
    const last = sessionStorage.getItem('studio-last-image-checkpoint');
    if (last && modelLists.checkpoints.includes(last)) return last;
  } catch { /* ignore */ }

  // 3. First available image checkpoint
  return modelLists.checkpoints[0] ?? null;
}

async function handleGenerateKeyframe(scene: StoryboardScene) {
  if (inFlightKeyframeScenes.has(scene.id)) return;

  const checkpoint = resolveKeyframeCheckpoint();
  if (!checkpoint) {
    setKeyframeError({ sceneId: scene.id, message: 'No image checkpoints installed. Add one via the Models tab.' });
    return;
  }
  // ... rest of the existing handler
}
```

The error message also gets clearer — distinguishes "no checkpoint set" (which is no longer a possible state given the resolution chain) from "no checkpoints exist" (which means the user hasn't installed any image checkpoints, the actionable state).

### Acceptance for Issue 1

- `grep -n "defaultCheckpoint" prisma/schema.prisma` shows the new field on `Project`.
- `grep -n "studio-last-image-checkpoint" src/components/Studio.tsx` shows persistence calls in both `handleCheckpointChange` and `handleInitialCheckpoint`.
- `grep -n "resolveKeyframeCheckpoint\|studio-last-image-checkpoint" src/components/ProjectDetail.tsx` shows the resolution helper.
- ProjectDetail's settings modal shows a "Default image checkpoint" dropdown.
- "Generate keyframe" succeeds with no project default set (uses sessionStorage value).
- "Generate keyframe" succeeds with project default set (uses project value).
- Error message only fires when zero image checkpoints are installed.

---

## Issue 2: No way to delete a storyboard or individual scene

**Symptom.** The 5d batch added storyboard tabs and scene management, but the long-press tab menu (specified for Rename / Delete / Reorder) doesn't exist or doesn't expose Delete. Same for individual scene deletion — the SceneEditModal can edit but not delete.

**Fix.** Add explicit Delete affordances on both tabs and scenes via overflow buttons (more discoverable than long-press on tablet).

### Part 2A — Storyboard tab overflow menu

Each storyboard tab gets a small overflow button (⋮) next to the name when the tab is active:

```
[ Main ⋮ ]  [ Alt take ]  [ + ]
```

Tapping ⋮ opens a small popover (or bottom sheet on narrow viewports):

```
┌─────────────────────────┐
│  Rename                 │
│  Delete                 │
└─────────────────────────┘
```

Tapping Delete → confirm dialog ("Delete storyboard '<name>'? This removes the scene plan only. Project clips are not affected.") → DELETE `/api/storyboards/[id]` → on success: switch active tab to first sibling (or null if no siblings), refresh project.

If the overflow approach feels heavy, an alternative: a small × button on the active tab next to the name (only on the *active* tab, to avoid accidental deletion via mistapped inactive tabs). Long-press not required — tablet-friendly tap is preferred.

The Delete action only works on the active tab. If user wants to delete a different tab, they tap it first. Simpler than per-tab delete buttons that clutter the strip.

### Part 2B — Scene delete from SceneEditModal

`SceneEditModal` gains a Delete button at the bottom-left of the footer (separated from Save/Cancel by visual whitespace and color):

```
[ Delete ]                                     [ Cancel ]  [ Save ]
   red                                                      violet
```

Tapping Delete → confirm dialog ("Delete Scene N? Any clips already generated from this scene will remain in your project but their scene reference will be cleared.") → builds an updated storyboard with this scene removed, all subsequent scenes' positions decremented → PUT `/api/storyboards/[id]`.

For new (insert-mode) scenes, the Delete button is hidden — there's nothing to delete since the scene hasn't been saved yet (Cancel handles that case).

The clip-orphan behavior (sceneId becomes orphan) is consistent with the existing storyboard-delete and scene-deletion semantics. Don't try to clear `sceneId` on the clips — they keep their value, just lose their scene-side referent. Same as today's behavior when a storyboard is deleted.

### Acceptance for Issue 2

- The active storyboard tab shows an overflow button (⋮) or × that opens a delete affordance.
- Tapping the overflow → confirms → DELETE → tab disappears, sibling becomes active.
- SceneEditModal shows a Delete button at the bottom-left of the footer.
- Tapping Delete → confirms → PUT updated storyboard without that scene → scene disappears from the list, position numbers renumber.
- Insert-mode (new) scenes don't show a Delete button.

---

## Issue 3: Attached clips don't appear in canonical picker until refresh

**Symptom.** After "Pick from project" and selecting a clip, the picker closes (or stays open) but the clip doesn't appear in the canonical picker's clip list. Refreshing the page shows it correctly.

**Root cause.** When attaching a clip, the implementation writes `Generation.sceneId` server-side but doesn't update the local `clips` state in ProjectDetail. The picker reads from `sceneClips = clips.filter((c) => c.sceneId === scene.id)` — without a re-fetch, the local state still shows the clip as not-attached.

**Fix.** After a successful attach (PATCH `/api/generations/[id]` to set sceneId), update local state.

In `ProjectDetail.tsx`'s attach handler (or in the picker, depending on where the handler lives — wherever `sceneId` is being written):

```ts
async function handleAttachClipToScene(clipId: string, sceneId: string) {
  const res = await fetch(`/api/generations/${clipId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId }),
  });
  if (!res.ok) {
    setAttachError('Failed to attach clip');
    return;
  }

  // Update local state — find the clip and update its sceneId
  setClips((prev) => prev.map((c) =>
    c.id === clipId ? { ...c, sceneId } : c,
  ));
}
```

If the clip being attached comes from another project (gallery picker case), it isn't currently in `clips` state. Two options:

**(a)** Re-fetch the project: `await load();` — simple, slightly slower (one HTTP round-trip).

**(b)** Add the attached clip to local state directly by constructing a `ProjectClip` from the picker's `GenerationRecord`. Faster but duplicates field mapping.

Use (a) — the project fetch is cheap and keeps state truly authoritative. Mirror the post-stitch refresh pattern.

### Verify the PATCH endpoint exists

Search for `PATCH /api/generations/[id]` or similar. If the endpoint doesn't exist for setting `sceneId`, create it:

```ts
// src/app/api/generations/[id]/route.ts (or extend existing)

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json();
  const updates: { sceneId?: string | null; isFavorite?: boolean } = {};
  if ('sceneId' in body) {
    if (body.sceneId !== null && (typeof body.sceneId !== 'string' || body.sceneId.length === 0)) {
      return Response.json({ error: 'sceneId must be a non-empty string or null' }, { status: 400 });
    }
    updates.sceneId = body.sceneId;
  }
  // ... handle isFavorite if needed
  if (Object.keys(updates).length === 0) {
    return Response.json({ error: 'No updates' }, { status: 400 });
  }
  await prisma.generation.update({ where: { id }, data: updates });
  return Response.json({ ok: true });
}
```

If a PATCH endpoint exists but doesn't accept `sceneId`, extend it. If it accepts only `isFavorite` today (most likely), add `sceneId` to the allowed fields.

### Acceptance for Issue 3

- Attaching a clip from project → clip immediately appears in scene's clip list, no refresh needed.
- Attaching a clip from gallery → same.
- The PATCH endpoint accepts `sceneId: string | null`.

---

## Issue 4: Gallery picker for "attach from gallery" crashes

**Symptom.** `TypeError: can't access property Symbol.iterator, data.items is undefined` at `CanonicalClipPickerModal.tsx:404` (`GalleryPickerVideo` sub-component).

**Root cause.** The gallery API (`/api/gallery`) returns `{ records, nextCursor }`. The 5d implementation reads `data.items` instead of `data.records`. Wrong field name; `data.items` is undefined; spread operator throws.

**Fix.** Change the `GalleryPickerVideo` (or whatever the new sub-component is named) to use the correct response shape:

```ts
interface GalleryResponse {
  records: GenerationRecord[];   // NOT items
  nextCursor: string | null;
}

async function loadMore() {
  const params = new URLSearchParams({
    mediaType: 'video',
    isStitched: 'false',          // exclude stitched outputs from clip-attach
  });
  if (cursor) params.set('cursor', cursor);

  const res = await fetch(`/api/gallery?${params}`);
  const data = await res.json() as GalleryResponse;

  setItems((prev) => [...prev, ...data.records]);  // data.records, not data.items
  setCursor(data.nextCursor);
  setHasMore(data.nextCursor !== null);
}
```

For the keyframe canonical picker's "attach from gallery" sub-component, same fix but `mediaType: 'image'`.

The reference implementation is `src/components/GalleryPicker.tsx` — it correctly uses `data.records`. Mirror its loading shape exactly.

### Acceptance for Issue 4

- "Pick from gallery" in canonical clip picker loads videos without crashing.
- "Pick from gallery" in canonical keyframe picker loads images without crashing.
- `grep -n "data.items" src/components/CanonicalClipPickerModal.tsx` returns nothing.
- `grep -n "data.items" src/components/CanonicalKeyframePickerModal.tsx` returns nothing.

---

## Issue 5: Detach is broken and only shown for canonical clip

**Symptoms.**
1. Detach button only renders for the clip currently marked canonical.
2. Tapping detach doesn't actually clear `sceneId` on the clip.

**Root cause.** The 5d prompt left detach-UX ambiguous ("a separate 'Detach' button on the existing-clip row in the picker. Either UX is acceptable"). The implementer chose the badge-based approach but only wired it to the canonical row. Also, the handler probably writes the storyboard's `canonicalClipId` to null but doesn't write the clip's `sceneId` to null.

**Fix.**

### Part 5A — Render detach button on every clip in the picker

Each clip row in `CanonicalClipPickerModal` shows three actions when the clip belongs to the scene:

```
┌──────────────────────────────────────────────┐
│ <video tile, full width>          [Canonical] │
│ Generated 1h ago · seed 8821                  │
│ [ Set as canonical ] [ Promote to video ] [ Detach ]
└──────────────────────────────────────────────┘
```

The Detach button is always visible for any clip in the per-scene clip list. It removes the scene reference (clears `sceneId` on the clip) and, if that clip was canonical, clears the scene's `canonicalClipId`.

Same treatment in `CanonicalKeyframePickerModal` for keyframes.

### Part 5B — Detach handler clears both fields

```ts
async function handleDetach(clip: ProjectClip) {
  // Clear sceneId on the clip via PATCH
  const res = await fetch(`/api/generations/${clip.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId: null }),
  });
  if (!res.ok) {
    setError('Failed to detach clip');
    return;
  }

  // If this clip was the canonical for the scene, also clear the storyboard's canonicalClipId
  let updatedStoryboard = storyboard;
  if (scene.canonicalClipId === clip.id) {
    const updatedScenes = storyboard.scenes.map((s) =>
      s.id === scene.id ? { ...s, canonicalClipId: null } : s,
    );
    updatedStoryboard = { ...storyboard, scenes: updatedScenes };
    const sbRes = await fetch(`/api/storyboards/${storyboard.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storyboard: updatedStoryboard }),
    });
    if (!sbRes.ok) {
      // Roll back the sceneId clear if storyboard PUT fails — best-effort consistency
      await fetch(`/api/generations/${clip.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneId: scene.id }),
      });
      setError('Failed to update storyboard');
      return;
    }
  }

  // Update local state: remove clip from sceneClips list
  // (Caller component should refresh project state)
  onCanonicalChanged(updatedStoryboard);
  onClipDetached(clip.id);
}
```

The detach effectively removes the clip from the scene's "clips for this scene" view. The clip itself stays in the gallery, just unattached.

If detaching the *only* clip on a scene, the scene transitions back to its empty state — Generate buttons return, no thumbnail.

### Part 5C — Confirmation for detach?

Detach is a low-cost reversible action (the clip stays, only the scene reference clears). Don't add a confirm dialog — it's friction without benefit. If the user mistaps, they tap "Pick from project" and re-attach.

### Acceptance for Issue 5

- Every clip in the canonical clip picker shows a Detach button.
- Same in canonical keyframe picker.
- Tapping Detach clears the clip's `sceneId` (verifiable via DB or by reloading the page).
- If the detached clip was canonical, the scene's `canonicalClipId` also clears.
- Detached clips disappear from the scene's clip list immediately, no refresh required.

---

## Issue 6: Stitch canonical doesn't respect storyboard scene order; needs storyboard naming and association

**Symptoms.**
1. The stitch modal opens with canonical clips but in some order other than scene-position order.
2. The output filename doesn't reflect the storyboard's name.
3. The stitched output isn't associated with the storyboard.

**Root causes.**
1. The 5d implementation populates the stitch modal with canonical clips, but the modal's existing reordering (drag handles, default position-based ordering) overrides scene order.
2. The stitch route slugs the project name (`stitched_<project>_<timestamp>.mp4`); doesn't know about storyboards.
3. No `storyboardId` field exists on `Generation`; nothing connects the stitched output back to its source storyboard.

**Fixes.** Add `storyboardId` to `Generation`, extend the stitch route to accept it, change the filename convention when present, and make sure the modal honors the supplied clip order without reverting to position-based.

### Part 6A — Add `storyboardId` to `Generation`

```prisma
model Generation {
  // ... existing fields ...
  storyboardId String?     // soft ref to Storyboard.id; null for non-storyboard stitches
}
```

Apply via `npx prisma db push`. Existing rows backfill with null.

No FK constraint — keeps the soft-reference pattern consistent with `sceneId`. If a storyboard is deleted, stitched outputs that referenced it become orphans (consistent with how scene clips become orphans when their scene goes away).

### Part 6B — Stitch route accepts `storyboardId`

`src/app/api/projects/[id]/stitch/route.ts` request body extends:

```ts
{
  transition?: 'hard-cut' | 'crossfade';
  clipIds?: string[];
  storyboardId?: string;   // NEW
}
```

When `storyboardId` is provided, the route:

1. Validates the storyboard exists and belongs to this project.
2. Uses the storyboard name in the output filename (see Part 6C).
3. Persists `storyboardId` on the resulting `Generation` row.

### Part 6C — Output filename naming

Today: `stitched_<projectslug>_<timestamp>.mp4` via the existing `slugify(\`stitched ${project.name}\`)` call.

When `storyboardId` is present, change to:

```ts
const storyboard = await prisma.storyboard.findUnique({
  where: { id: body.storyboardId },
  select: { name: true, projectId: true },
});
if (!storyboard || storyboard.projectId !== projectId) {
  return new Response(JSON.stringify({ error: 'Storyboard not found in this project' }), { status: 400 });
}
const slug = slugify(`stitched ${storyboard.name}`);
```

Resulting filename pattern: `stitched_<storyboardslug>_<timestamp>.mp4`. Matches the user's request.

For non-storyboard stitches, keep the existing `stitched_<projectslug>_<timestamp>.mp4` convention. No regression on the project-level stitch button.

### Part 6D — Persist `storyboardId` on the row

In the `prisma.generation.create({ ... })` call inside the stitch route, add:

```ts
storyboardId: body.storyboardId ?? null,
```

### Part 6E — Honor user-supplied clip order; don't re-sort

`src/lib/stitch.ts` and `src/app/api/projects/[id]/stitch/route.ts` already accept `clipIds: string[]` and use that order. Verify the StitchModal client code doesn't re-sort.

In `ProjectDetail.tsx`'s `handleStitchCanonical`:

```ts
function handleStitchCanonical() {
  if (!storyboard) return;
  const orderedClipIds = storyboard.scenes
    .map((s) => resolveCanonicalClipId(s, clips))
    .filter((id): id is string => id !== null);

  if (orderedClipIds.length < 2) {
    setStitchError('Need at least 2 scenes with canonical clips to stitch');
    return;
  }

  setStitchPreselectedClipIds(orderedClipIds);
  setShowStitch(true);
}
```

The StitchModal opens with `preselectedClipIds`, displays them in that order, all checked. The modal's existing drag-to-reorder still works for last-mile adjustments — but the *initial* order is the storyboard's scene order.

In the StitchModal, when `preselectedClipIds` is provided, it overrides whatever the modal's default ordering would be:

```tsx
const [orderedClips, setOrderedClips] = useState<ProjectClip[]>(() => {
  if (preselectedClipIds && preselectedClipIds.length > 0) {
    // Order = preselected order, filtered to clips that still exist
    return preselectedClipIds
      .map((id) => videoClips.find((c) => c.id === id))
      .filter((c): c is ProjectClip => c !== undefined);
  }
  // Default: project-position order (existing behavior)
  return videoClips;
});
```

When the modal sends to `/api/projects/[id]/stitch`, it sends:

```ts
{
  transition,
  clipIds: orderedClips.filter((c) => selectedIds.has(c.id)).map((c) => c.id),
  storyboardId: preselectedStoryboardId ?? undefined,  // pass through if set
}
```

The route uses `clipIds` order; storyboardId flows to the DB row.

### Part 6F — Type extensions

`GenerationRecord` and `ProjectStitchedExport` types gain `storyboardId: string | null`. Most consumers ignore it; the eventual storyboard-stitched-exports view (out of scope here) uses it.

### Acceptance for Issue 6

- `grep -n "storyboardId" prisma/schema.prisma` shows the field on `Generation`.
- `grep -n "storyboardId" src/app/api/projects/\[id\]/stitch/route.ts` shows acceptance + persistence.
- Stitching a storyboard's canonicals produces a file named `stitched_<storyboardslug>_<timestamp>.mp4`.
- The resulting `Generation` row has `storyboardId` populated.
- The clip order in the resulting video matches the storyboard's scene order (scene 1 → scene 2 → ... → scene N).
- Project-level Stitch button (no storyboard) still produces `stitched_<projectslug>_<timestamp>.mp4` with project-position ordering — no regression.

---

## Critical: disk-avoidance and tablet UX

This batch doesn't touch the workflow build path, the WS finalize path, or any output-handling logic. The forbidden-class-type guards apply equally. Verify with the standard greps post-implementation.

All new UI affordances (overflow buttons, delete buttons, detach buttons) ≥44px tap targets. Confirm dialogs use the existing bottom-sheet pattern.

---

## Acceptance criteria — overall

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- All six issues' acceptance criteria pass.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet, full sequence):

1. **Keyframe with project default checkpoint.** Open project settings; set Default image checkpoint to a specific one. Save. Tap "Generate keyframe" on a scene. Confirm the keyframe generates using that checkpoint (visible in the resulting clip's metadata).
2. **Keyframe falls back to last-Studio.** Project default unset. Open Studio image mode, pick a checkpoint. Return to project. Tap "Generate keyframe". Confirm uses the Studio-selected checkpoint.
3. **Keyframe falls back to first-available.** Project default unset, Studio session cleared. Tap "Generate keyframe". Confirm uses `modelLists.checkpoints[0]`.
4. **Delete storyboard tab.** With 2+ storyboards, tap active tab's overflow → Delete → confirm. Confirm tab disappears, sibling becomes active.
5. **Delete scene.** Open SceneEditModal → tap Delete → confirm. Confirm scene removed; subsequent scenes renumber; clips that were associated stay in the gallery (orphan sceneId).
6. **Attach project clip — immediate visibility.** Open canonical clip picker for a scene with no clips. "Pick from project". Pick a clip. Confirm clip appears in scene's clip list immediately, no refresh.
7. **Attach gallery clip — no crash.** Same picker; "Pick from gallery". Confirm gallery picker loads videos without error. Pick one. Confirm attaches and displays.
8. **Detach any clip.** Open picker for a scene with 2+ clips. Tap Detach on the non-canonical one. Confirm: clip vanishes from scene list; reload page; confirms `sceneId` is null on the clip in DB.
9. **Detach canonical clip.** Open picker for a scene where the canonical is set. Tap Detach on the canonical. Confirm: clip vanishes; scene's canonicalClipId clears; chaining for next scene falls back appropriately.
10. **Stitch canonical — naming + ordering.** Storyboard with 4 scenes, each with a canonical clip. Tap "Stitch canonical". Confirm: modal opens with 4 clips in scene-position order. Submit. Confirm: resulting filename is `stitched_<storyboardslug>_<timestamp>.mp4`; the video plays scenes in scene order; the row's `storyboardId` is populated.
11. **Project-level stitch — regression.** Tap project-level Stitch (not storyboard). Confirm: filename is `stitched_<projectslug>_<timestamp>.mp4`; row's `storyboardId` is null.
12. **Disk-avoidance.** After heavy use: `ssh <gpu-vm> ls /models/ComfyUI/output/*.png` returns "no such file or directory."

---

## Out of scope

- A "stitched-exports per storyboard" UI view. The DB now supports it (storyboardId on Generation), but no new UI surfaces are needed in this fix bundle. Future feature.
- Backfilling `storyboardId` on existing stitched exports.
- Iterative LLM editing of scenes.
- Any new keyframe / video generation features.
- Renaming any existing routes or files.
- Reorganizing the SceneEditModal beyond adding the Delete button.
- A "delete multiple scenes at once" bulk action.

---

## Documentation

In CLAUDE.md, update the relevant Phase 5d / Phase 6 sections to reflect the fixes:

- Note that `Project.defaultCheckpoint` is the explicit project-level default for keyframe checkpoint selection, with fallback chain documented.
- Note that storyboard tabs and scenes are deletable via overflow / Delete affordances.
- Note that the canonical pickers' "Pick from gallery" reads `data.records` from `/api/gallery` (the canonical shape).
- Note that detach is available on every per-scene clip / keyframe, not just the canonical.
- Note the `Generation.storyboardId` column and its filename / association semantics.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
