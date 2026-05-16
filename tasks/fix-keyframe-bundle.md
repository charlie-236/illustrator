# Batch — Keyframe fixes (3 issues from QA)

Three keyframe-related issues from real use:

1. **Regression: can't delete keyframes.** Both the inline picker delete and the modal-side delete fail to actually remove the keyframe from the DB.
2. **Bulk regenerate-all.** "Generate keyframes (N needed)" only handles scenes without canonicals; user wants ability to regenerate all keyframes regardless of existing canonicals.
3. **Auto-canonical on regenerate.** When a keyframe is regenerated, it should automatically become canonical (instead of staying as a non-canonical alternate).

All three touch ProjectDetail / canonical pickers / keyframe generation flow. Bundled because they share files.

Re-read CLAUDE.md before starting. Disk-avoidance unaffected.

---

## Required changes

### Issue 1 — Regression: keyframe delete doesn't work

**Symptom.** Deleting a keyframe fails silently. Affects both:
- The Delete button in the canonical keyframe picker
- The Delete button in the larger image modal opened by tapping a keyframe thumbnail

**Diagnostic.** Read the current keyframe delete handler. Likely shapes of the bug:

- The DELETE call to `/api/generations/[id]` (or wherever images are deleted) returns success, but the keyframe still appears because the local `clips` state in ProjectDetail isn't being refreshed.
- The DELETE call is failing on the server side because of a foreign key or sceneId reference that's not handled.
- The Delete button's onClick is wired to a stub or missing handler.
- Recent batches modified the deletion path (e.g., for stitched outputs, for clips) and unintentionally broke the image-with-sceneId path.

**Fix.** Diagnose and repair. Steps:

1. **Read** `src/app/api/generations/[id]/route.ts` (or the equivalent delete endpoint). Confirm DELETE handler exists and accepts image generations regardless of `sceneId`. If the handler rejects images with a sceneId set (defensive code that may have been added), remove that gate.

2. **Read** the keyframe picker's Delete button onClick. Confirm it calls the DELETE endpoint AND refetches the project on success. The post-delete refetch is what makes the deletion visible in the UI.

3. **Read** the ImageModal's Delete button. Same pattern check.

4. If the server-side DELETE is fine but the client doesn't update: add the project refetch.

5. If the server-side DELETE is broken: fix it. Likely culprit: a check for `if (generation.sceneId) reject` that was added during one of the storyboard batches with the wrong intent.

When deleting a keyframe that's currently set as the scene's `canonicalKeyframeId`, also clear the canonical reference (set scene's `canonicalKeyframeId` to null in the storyboard PUT). Same pattern as clip detach in the prior 5d/6 fix bundle.

### Issue 2 — Bulk regenerate-all keyframes

**Symptom.** The "Generate keyframes (N needed)" button only handles scenes that don't have a canonical keyframe. User often wants to regenerate ALL keyframes (after a prompt edit, after deciding the existing batch was wrong, etc.).

**Background.** Original Phase 6 prompt scoped "Generate keyframes" as fill-the-gaps only. I rejected the regenerate-all variant as out of scope. Adding it now per use feedback.

**Fix.** Add a second action: "Regenerate all keyframes" alongside the existing "Generate keyframes (N needed)" button.

Layout option:

```
[ Generate keyframes (N needed) ]   [ Regenerate all keyframes ]
                                      ↑ shows when ANY canonical keyframe exists
```

When the storyboard has ANY scene with a canonical keyframe, show the regenerate-all button. When zero canonicals exist, only the gap-fill button is meaningful (it covers all scenes anyway).

Behavior:

- Tap "Regenerate all keyframes" → confirm dialog: "Regenerate keyframes for all N scenes? This will queue N image generations. Existing keyframes are preserved as non-canonical alternates."
- On confirm: submit a keyframe generation for every scene in the storyboard (parallel via ComfyUI queue, same pattern as the gap-fill batch).
- Each new keyframe lands as a Generation row with `sceneId` set; per Issue 3, each new keyframe also auto-promotes to canonical.

Existing per-scene flow stays untouched. Existing gap-fill button stays untouched. New button is purely additive.

In `ProjectDetail.tsx`, add a `handleRegenerateAllKeyframes` function alongside the existing `handleGenerateAllKeyframes`. Reuse the same per-scene submission helper.

```ts
async function handleRegenerateAllKeyframes() {
  const allScenes = storyboard.scenes;
  // Skip the "scenesNeedingKeyframes" filter; submit for ALL scenes
  for (const scene of allScenes) {
    void handleGenerateKeyframe(scene);
  }
  setBatchKeyframeScenes(new Set(allScenes.map((s) => s.id)));
}
```

The batch tracking (X/Y completed counter) reuses the existing infrastructure — no new state needed.

### Issue 3 — Auto-canonical on keyframe regeneration

**Symptom.** When a user regenerates a keyframe (per-scene Generate keyframe button on a scene that already has one), the new keyframe lands as a non-canonical alternate. User expects it to become canonical automatically — they regenerated because they didn't like the previous one.

**Fix.** When a keyframe generation completes via the per-scene Generate keyframe path OR via the regenerate-all batch (Issue 2), auto-update the scene's `canonicalKeyframeId` to point at the new keyframe.

Implementation point: the polling effect in `ProjectDetail.tsx` that detects keyframe completions. When a new keyframe is detected (matching an in-flight scene id), in addition to clearing the in-flight entry, also PUT the storyboard with `scene.canonicalKeyframeId = newKeyframeId`.

```ts
const newKeyframe = fresh.clips.find(
  (c) => c.sceneId === sceneId && c.mediaType === 'image' && new Date(c.createdAt).getTime() > entry.startedAt,
);
if (newKeyframe) {
  // Existing: remove from in-flight
  next.delete(sceneId);

  // NEW: auto-promote to canonical
  const updatedScenes = storyboard.scenes.map((s) =>
    s.id === sceneId ? { ...s, canonicalKeyframeId: newKeyframe.id } : s,
  );
  void fetch(`/api/storyboards/${storyboard.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storyboard: { ...storyboard, scenes: updatedScenes } }),
  }).catch((err) => console.warn('Failed to auto-promote keyframe to canonical:', err));
}
```

The fire-and-forget PUT is acceptable — failure just means canonical didn't update, the user can manually promote in the picker.

This applies to BOTH:
- Per-scene "Generate keyframe" tap (Issue 3 here)
- Whole-storyboard "Generate keyframes (N needed)" gap-fill (already auto-canonical after this fix because it goes through the same polling completion path — verify)
- Whole-storyboard "Regenerate all keyframes" (Issue 2 — same polling completion path; auto-canonical works automatically once Issue 3 is fixed)

So Issue 3's fix applies to all three keyframe-generation paths uniformly, since they all complete via the same polling effect.

If the user wants to keep an old keyframe as canonical instead of the new one: they can manually re-promote via the picker. The default is "newest = canonical" which matches user expectation per the QA report.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- Deleting a keyframe via the picker actually removes it from DB and UI.
- Deleting a keyframe via the image modal actually removes it.
- Deleting a canonical keyframe also clears the scene's `canonicalKeyframeId`.
- "Regenerate all keyframes" button visible alongside "Generate keyframes (N needed)" when any canonical exists.
- Tapping "Regenerate all keyframes" confirms then submits N keyframe generations covering all scenes.
- After any keyframe generation completes, the scene's `canonicalKeyframeId` updates to the new keyframe automatically.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. **Delete keyframe via picker.** Open canonical keyframe picker for a scene with 2+ keyframes. Tap Delete on a non-canonical keyframe. Confirm: keyframe disappears from list immediately; reload — it's still gone (DB persisted).
2. **Delete canonical keyframe.** In the same picker, tap Delete on the canonical keyframe. Confirm: keyframe deleted; scene's canonicalKeyframeId clears (reload to verify); fallback resolution picks the earliest remaining keyframe.
3. **Delete via image modal.** Tap a keyframe thumbnail to open ImageModal. Tap Delete in the modal. Confirm same behavior.
4. **Regenerate all (button visibility).** In a storyboard where every scene has a canonical keyframe, confirm "Regenerate all keyframes" button is visible.
5. **Regenerate all (button hidden when nothing to regenerate).** In a storyboard where no scene has a canonical keyframe, confirm only "Generate keyframes (N needed)" is visible (no regenerate-all).
6. **Regenerate all happy path.** Tap "Regenerate all keyframes". Confirm dialog. Confirm. All scenes show "Generating..." pills. Wait for completion. Each scene now has a new canonical keyframe; old keyframes are preserved as non-canonical alternates (visible in picker).
7. **Auto-canonical on per-scene regenerate.** On a scene with an existing canonical keyframe, tap "Generate keyframe". Wait for completion. Confirm: new keyframe is canonical; old keyframe is now non-canonical (visible in picker as alternate).
8. **Auto-canonical on gap-fill batch.** Empty out one scene's keyframes (delete them all). Tap "Generate keyframes (N needed)". After completion, the new keyframe is canonical for that scene.
9. **Disk-avoidance regression.** After many keyframe generations and deletions: `ssh <gpu-vm> ls /models/ComfyUI/output/` returns "no such file or directory."

---

## Out of scope

- A "Regenerate this scene's keyframe" button distinct from "Generate keyframe". The per-scene button already does the right thing now (regenerates and auto-canonicalizes).
- A user preference for "auto-canonical on regenerate" vs "manual canonical assignment". Auto is the default; manual override via picker is always available.
- Bulk delete of keyframes ("delete all non-canonical keyframes"). Could be a future feature; not this batch.
- Server-side transactional delete with cascade clearing of canonicalKeyframeId. The two-step client flow (DELETE generation, PUT storyboard) is acceptable for single-user reliability.
- Animations on auto-canonical change.

---

## Documentation

In CLAUDE.md, under the existing Phase 6 section, add:

> **Auto-canonical on regenerate.** When any keyframe generation completes (per-scene Generate, gap-fill batch, or regenerate-all), the scene's `canonicalKeyframeId` auto-updates to the new keyframe. User can manually re-promote via the picker if they prefer an older variant.
>
> **Regenerate-all batch.** Sibling action to the gap-fill batch. Submits a keyframe generation for every scene in the storyboard regardless of existing canonicals; new keyframes auto-canonicalize on completion. Existing keyframes preserved as non-canonical alternates.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
