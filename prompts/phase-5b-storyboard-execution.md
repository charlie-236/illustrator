# Batch — Phase 5b: Storyboard scene execution + editing

Phase 5a established storyboards as a read-only data layer. Phase 5b makes them **actionable** and **editable**. Each scene gets a per-scene Generate button that bounces to Studio with the scene's prompt + duration + suggested starting frame pre-filled. Generated clips persist a `sceneId` back-reference so they're traceable to their scene. Scene fields become editable. When a scene has multiple generated clips, the user picks which one is canonical (the one whose last frame chains into the next scene's i2v starting frame).

Last-frame chaining is **suggested but overridable**: when you tap Generate on Scene N, Studio's i2v starting frame defaults to Scene N-1's canonical clip's last frame. The existing GalleryPicker remains available — user can pick a different clip, an external image, or turn the starting frame off entirely. This preserves hard-cut storytelling while making the common case (continuous narrative) one tap.

This is a substantial batch. Implement in the order presented; the schema + types + persistence (Parts 1-4) are foundational, the per-scene generate flow (Parts 5-7) is the magic, and the editing surfaces (Parts 8-10) layer on top. Each part has its own acceptance criteria — check them as you go.

Re-read CLAUDE.md before starting, particularly the Phase 5a section and the existing project-context-trigger pattern (from H5).

---

## Critical: disk-avoidance contract is unaffected

This batch touches the video generation route's request body shape, `finalizeVideoJob` to persist a new field, and the project route's clip select. None of the workflow build path, WS binary capture, or finalize disk-write logic changes. Verify with the standard greps post-implementation.

Tablet UX rules apply throughout — the storyboard section is a primary tablet surface. Tap targets ≥44–48px on every Generate button, scene card, edit affordance, and picker. The scene edit modal and canonical clip picker use the bottom-sheet pattern (mirror `StitchModal`).

---

## Required changes

### Part 1 — Schema

`prisma/schema.prisma`:

```prisma
model Generation {
  // ... existing fields ...
  sceneId String?    // null for non-storyboard clips; references a scene's id within Project.storyboardJson
}
```

Apply via `npx prisma db push`. Existing rows backfill with null.

No foreign-key constraint — scenes live inside the project's JSON column, not as relational rows. The `sceneId` is a soft reference that the client validates on render. If a scene is deleted (regenerate storyboard, or scene removal in a future phase), the existing clips' `sceneId` values become stale; they're treated as orphans (no scene badge shown). Acceptable.

No index needed in 5b — `sceneId` queries are always within a single project, and the existing `projectId` index handles the prefix. If query performance becomes a concern in 5c, add `@@index([projectId, sceneId])`.

### Part 2 — Types

`src/types/index.ts` — extend `StoryboardScene` from 5a:

```ts
export interface StoryboardScene {
  id: string;
  position: number;
  description: string;
  positivePrompt: string;
  durationSeconds: number;
  notes?: string | null;             // NEW — user freeform; null/undefined for newly generated
  canonicalClipId?: string | null;   // NEW — when set, identifies the canonical clip; when null, fall back to earliest-generated client-side
}
```

Both new fields are optional (`?`) and nullable so existing 5a-generated storyboards (which don't have these keys at all) deserialize cleanly. Treat `undefined === null` everywhere on read.

Extend `GenerationRecord` and `ProjectClip` (or whatever the project route's clip projection type is named) to include `sceneId: string | null`.

Extend `ProjectContext` (the trigger payload) with optional `sceneContext`:

```ts
export interface ProjectContext {
  projectId: string;
  projectName: string;
  mode: 'image' | 'video';
  // ... existing fields ...
  sceneContext?: SceneTriggerContext;  // NEW
}

export interface SceneTriggerContext {
  sceneId: string;
  sceneIndex: number;            // 0-indexed; for display ("Scene 3 of 5")
  prompt: string;
  durationSeconds: number;
  suggestedStartingClipId: string | null;  // null = no chaining suggestion (scene 0, or prev has no canonical)
}
```

When `sceneContext` is present, Studio's apply-trigger effect treats it as overrides on top of the project context (Part 6).

### Part 3 — Generation route accepts and persists `sceneId`

`src/app/api/generate-video/route.ts` — request body extends to accept optional `sceneId: string`. Validation: if present, must be a non-empty string. Don't validate consistency with the project's storyboard (single-user app; trust the client). The value flows through to `registerVideoJob` as part of `videoParams`.

`src/lib/comfyws.ts` — `VideoJobParams` (or whatever the type is named) extends to include `sceneId?: string`. `finalizeVideoJob` writes it to the new DB column:

```ts
const created = await prisma.generation.create({
  data: {
    // ... existing fields ...
    sceneId: videoParams.sceneId ?? null,
  },
});
```

The PUT validator at `src/app/api/projects/[id]/storyboard/route.ts` (from 5a) extends to accept the new optional fields on each scene. `notes` accepts `string | null | undefined`; trim and treat empty strings as null on save. `canonicalClipId` accepts `string | null | undefined`.

### Part 4 — Project route returns `sceneId` on clips

`src/app/api/projects/[id]/route.ts` — the `select` clause for `generations` (the project's clips) gains `sceneId: true`. The response shape's clip entries gain `sceneId: string | null`.

The same select extension applies to `stitchedExports` if those rows could ever have a sceneId — but they shouldn't (stitched outputs aren't scene generations). Skip stitchedExports.

### Part 5 — Per-scene Generate button

`src/components/ProjectDetail.tsx` — each scene card in the storyboard section gains a Generate button. Visible regardless of whether the scene already has clips. (Generating again produces additional clips; the canonical picker handles "which one is the chosen one.")

Layout per scene card:

```
┌──────────────────────────────────────────────┐
│ Scene 3 · 4s · 2 clips                        │   ← clip count when > 0
│ A young girl climbs creaky stairs into a      │
│ dusty attic.                                   │
│                                                │
│ <prompt in smaller monospace text>             │
│                                                │
│ [thumbnail of canonical clip if any]           │
│                                                │
│ [ Generate this scene ]   [ ✏️ Edit ]          │
└──────────────────────────────────────────────┘
```

The clip-count line ("2 clips") is rendered when the scene has any associated clips (computed client-side from project clips where `clip.sceneId === scene.id`). Tap the count → opens canonical clip picker (Part 9).

The canonical clip thumbnail uses `<video preload="metadata" muted playsInline>` mirroring the gallery's video tile pattern. Aspect-ratio-preserving width, ~half the card width. Tap opens the existing `ImageModal` at the clip.

Resolution rule for canonical: if `scene.canonicalClipId` is set and the referenced clip exists in the project's clips, that's canonical. Otherwise, fall back to "earliest-created clip with `sceneId === scene.id`" (computed client-side, ordered by `createdAt asc`). If no clips have this `sceneId`, no thumbnail.

Scene cards remain tappable as a whole (existing read-only display). The Generate and Edit buttons are explicit affordances within the card. Don't double-bind tap-on-card to enter edit mode — too easy to mis-tap.

### Part 6 — Studio apply-trigger handles `sceneContext`

`src/components/Studio.tsx` — extend the `projectContextTrigger` consumer effect. When `trigger.sceneContext` is present:

```ts
if (projectContextTrigger.sceneContext) {
  const sc = projectContextTrigger.sceneContext;

  // Force video mode regardless of trigger.mode
  setMode('video');

  // Apply standard project-context defaults first (existing logic)
  // ... existing video-mode setup with project defaults ...

  // Then override with scene-specific values
  setVideoP((prev) => ({
    ...prev,
    // Convert duration seconds → frames at 16fps. Round to nearest valid frame count.
    frames: clampToValidFrameCount(sc.durationSeconds * 16),
  }));

  // Override prompt with scene's prompt
  setP((prev) => ({ ...prev, positivePrompt: sc.prompt }));

  // Stash sceneId in form state for the eventual generate-video request
  setActiveSceneId(sc.sceneId);

  // Suggest the starting frame from the previous scene's canonical clip
  if (sc.suggestedStartingClipId) {
    setUseStartingFrame(true);
    setSelectedStartingClipId(sc.suggestedStartingClipId);
    // The existing extract-last-frame fetch fires off this; no new logic needed
  }
  // If no suggestion, leave starting frame state at whatever the project context default was
}
```

`clampToValidFrameCount(n)` — Wan 2.2's frame counts are constrained (the existing video form uses a slider with valid values, e.g. 41, 57, 81, 113). Pick the nearest valid value to the requested. Use whatever helper or constant the existing video form uses; if there isn't one, the valid set is documented in `wan22-workflow.ts` or a sibling.

`activeSceneId` is a new piece of Studio state — `useState<string | null>(null)` — that's set by scene triggers and included in the generate-video request body. It clears on:
- Mode switch image ↔ video (clearing in image mode is fine — video-only concept)
- Successful generation (the clip lands with the sceneId; subsequent generations from the same form don't carry it unless the user re-triggers from a scene)
- Project context trigger without sceneContext (regular "Generate clip in project" → scene context goes away)
- Tab switch away from Studio (defensive)

### Part 7 — Last-frame chaining suggestion logic

`src/components/ProjectDetail.tsx` — when building the trigger payload for "Generate this scene":

```ts
function handleGenerateScene(scene: StoryboardScene) {
  const sceneIndex = scene.position;

  // Resolve previous scene's canonical clip id (if any)
  let suggestedStartingClipId: string | null = null;
  if (sceneIndex > 0) {
    const prevScene = storyboard.scenes[sceneIndex - 1];
    if (prevScene) {
      // Use prevScene.canonicalClipId if set, otherwise resolve fallback
      const canonical = resolveCanonicalClipId(prevScene, projectClips);
      suggestedStartingClipId = canonical;
    }
  }

  const trigger: ProjectContext = {
    projectId: project.id,
    projectName: project.name,
    mode: 'video',
    // ... existing latestClip*, defaults fields ...
    sceneContext: {
      sceneId: scene.id,
      sceneIndex,
      prompt: scene.positivePrompt,
      durationSeconds: scene.durationSeconds,
      suggestedStartingClipId,
    },
  };
  setProjectContextTrigger(trigger);
  setTab('studio');
}

function resolveCanonicalClipId(scene: StoryboardScene, projectClips: ProjectClip[]): string | null {
  if (scene.canonicalClipId) {
    // Verify the referenced clip exists; if it was deleted, fall through
    if (projectClips.some((c) => c.id === scene.canonicalClipId)) {
      return scene.canonicalClipId;
    }
  }
  // Fall back: earliest-created clip with this sceneId
  const sceneClips = projectClips
    .filter((c) => c.sceneId === scene.id)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return sceneClips[0]?.id ?? null;
}
```

`resolveCanonicalClipId` is shared logic — extract it to a small helper (sibling file, or inline at the top of ProjectDetail). It's used both for the chaining suggestion and for rendering the thumbnail (Part 5) and for the canonical picker's "currently selected" state (Part 9).

If `suggestedStartingClipId` is null (scene 0, or previous scene has no clips yet), the trigger sets no starting-frame default. The user sees the standard t2v form and can manually pick a starting frame via the existing GalleryPicker if desired.

### Part 8 — Scene edit modal

New component, `src/components/SceneEditModal.tsx`. Bottom-sheet pattern.

```
┌──────────────────────────────────────────────┐
│ Edit Scene 3                            [×]   │
├──────────────────────────────────────────────┤
│                                                │
│ Description                                    │
│ ┌──────────────────────────────────────────┐  │
│ │ <textarea, 3-4 rows>                       │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ Prompt                                         │
│ ┌──────────────────────────────────────────┐  │
│ │ <textarea, 6-8 rows, monospace>            │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ Duration (seconds): [ — ] 4 [ + ]              │
│                                                │
│ Notes                                          │
│ ┌──────────────────────────────────────────┐  │
│ │ <textarea, 3-4 rows>                       │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ [ Cancel ]                       [ Save ]      │
└──────────────────────────────────────────────┘
```

State:
- Local copy of the scene's editable fields (description, positivePrompt, durationSeconds, notes)
- Initialize from the scene prop on open
- Track dirty state (any field changed from initial)

Save:
1. Construct the full storyboard with the edited scene replacing the original (same id, same position, same canonicalClipId — only the four editable fields change).
2. PUT `/api/projects/[id]/storyboard` with the full storyboard.
3. On success: close modal, project re-fetches.
4. On failure: keep modal open, show inline error, preserve user's edits.

Cancel: if dirty, show a confirm dialog ("Discard changes?"). If not dirty, close immediately.

Validation:
- Description: required, 1-2000 chars after trim. (Soft cap; LLM scenes are usually 100-300 chars.)
- Prompt: required, 1-3000 chars after trim.
- Duration: integer 1-10. Use the same number-stepper pattern as the storyboard generation modal.
- Notes: optional, up to 2000 chars.

Tablet-friendly: textareas use `input-base` styling, generous height; the duration stepper buttons are ≥44px each.

Position is **not editable** in 5b (scene reordering is a 5c concern). The scene id is hidden from the user — it's an opaque cuid.

### Part 9 — Canonical clip picker

New component, `src/components/CanonicalClipPickerModal.tsx`. Bottom-sheet pattern.

Opens when the user taps the clip-count line ("2 clips") on a scene card. Shows all clips with `sceneId === scene.id` as a vertical list of video tiles. The currently-canonical clip (resolved per Part 7's rules) has a "Canonical" badge.

```
┌──────────────────────────────────────────────┐
│ Canonical clip — Scene 3                [×]   │
├──────────────────────────────────────────────┤
│ Pick which clip should chain into the next    │
│ scene's starting frame.                        │
│                                                │
│ ┌──────────────────────────────────────────┐  │
│ │ <video tile, full width>      [Canonical]│  │
│ │ Generated 2h ago · 4s · seed 1284         │  │
│ │ [ Set as canonical ] (disabled)           │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ ┌──────────────────────────────────────────┐  │
│ │ <video tile, full width>                  │  │
│ │ Generated 1h ago · 4s · seed 9921         │  │
│ │ [ Set as canonical ]                      │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ [ Close ]                                      │
└──────────────────────────────────────────────┘
```

Tapping "Set as canonical" on a non-canonical clip:
1. Update the scene's `canonicalClipId` locally (optimistic).
2. PUT the storyboard.
3. On success: re-resolve canonical, update badge, close picker (or stay open — let the user keep browsing).
4. On failure: revert and show error.

Tap a clip's video tile to open the existing `ImageModal` for that clip. The picker stays mounted underneath; modal closes return to picker. (Mirror existing modal stacking patterns.)

If the scene has 0 or 1 clips, the picker is never opened (the count line is suppressed for 0, and "1 clip" doesn't open the picker — it opens the modal directly because there's nothing to pick).

### Part 10 — Clip-back-to-scene info in modal sidebar

`src/components/ImageModal.tsx` (or wherever the modal sidebar metadata is rendered) — when the displayed clip has `sceneId` set, add a sidebar row:

```
Scene
Scene 3 of 5 · "A young girl climbs creaky stairs..."
```

The line is informational. No tap interaction in 5b — tapping doesn't navigate to the scene. (5c can add scroll-to-scene navigation if useful.)

The scene index and description require the project's storyboard. The modal's data-fetch layer (currently fetches the clip via `/api/generation/[id]` or similar) needs the storyboard too. Two options:
- **(a)** Extend the modal's clip-fetch to include the parent project's storyboard. Adds a join.
- **(b)** Render "Scene <id-prefix>" as a fallback when the storyboard isn't in scope, and only render the full "Scene 3 of 5" when the modal is opened from a context that already has the storyboard (i.e., from ProjectDetail, which holds it in state).

**(b) is cleaner.** The modal accepts an optional `storyboard` prop. When opened from ProjectDetail, the storyboard is passed through. When opened from the Gallery, no storyboard is in scope — show a minimal "Scene <truncated id>" or omit the line entirely (graceful degradation).

If `(b)` feels too messy, `(a)` is acceptable. Document the choice in the PR description.

---

## Acceptance criteria — Schema + types (Parts 1-2)

- `npm run build` passes clean.
- `grep -n "sceneId" prisma/schema.prisma` shows the field on `Generation`.
- `npx prisma db push` applies cleanly. Existing rows have null sceneId.
- `grep -n "sceneId" src/types/index.ts` shows it on `GenerationRecord` and `ProjectClip`.
- `grep -n "SceneTriggerContext\|sceneContext" src/types/index.ts` shows the new types.

## Acceptance criteria — Per-scene generation (Parts 3-7)

- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "sceneId" src/app/api/generate-video/route.ts` shows the body acceptance.
- `grep -n "sceneId" src/lib/comfyws.ts` shows finalize writing the field.
- `grep -n "sceneId" src/app/api/projects/\[id\]/route.ts` shows it in the clips select.
- `grep -n "sceneContext\|SceneTriggerContext" src/components/Studio.tsx` shows the apply-trigger logic.
- `grep -n "activeSceneId" src/components/Studio.tsx` shows the new state and its inclusion in the generate-video body.
- `grep -n "handleGenerateScene\|resolveCanonicalClipId" src/components/ProjectDetail.tsx` shows the per-scene Generate button and chaining logic.

## Acceptance criteria — Editing surfaces (Parts 8-10)

- `src/components/SceneEditModal.tsx` exists.
- `src/components/CanonicalClipPickerModal.tsx` exists.
- `grep -n "SceneEditModal\|CanonicalClipPickerModal" src/components/ProjectDetail.tsx` shows the integration.
- `grep -n "sceneId" src/components/ImageModal.tsx` shows the sidebar info line.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet, full sequence):

1. **Schema migration applied.** `npx prisma db push`. Confirm `sceneId` column on `Generation` table. Existing rows null.
2. **Backwards compatibility.** Open a project that had a 5a-generated storyboard. Confirm scenes render with no errors. Notes and canonicalClipId are absent from old data — UI handles gracefully.
3. **Scene 0 generation.** Tap "Generate this scene" on Scene 1 of a fresh storyboard. Studio opens in video mode. Confirm: prompt is the scene's prompt, frames maps from durationSeconds × 16, project defaults applied for the rest. No starting frame suggested (Scene 1 has no predecessor). Tap Generate. Wait for completion. Confirm the clip lands in the project; row has `sceneId` set; scene card now shows "1 clip" with the clip as canonical-by-fallback.
4. **Scene chaining.** Tap "Generate this scene" on Scene 2. Studio opens with Scene 1's canonical clip as the suggested starting frame (i2v mode). Confirm the starting-frame thumbnail in Studio shows Scene 1's last frame. Tap Generate. Confirm the new clip persists with `sceneId` for Scene 2.
5. **Override starting frame.** Tap Generate on Scene 3. Confirm Scene 2's canonical is suggested. Tap the GalleryPicker, pick a different image entirely. Generate. Confirm the override took effect (new clip uses the picked frame, not Scene 2's last).
6. **Hard cut.** Tap Generate on Scene 4. Toggle starting frame OFF. Generate. Confirm t2v generation succeeds.
7. **Multiple clips per scene.** Tap Generate on Scene 1 again. Confirm a second clip lands with the same sceneId. Scene card shows "2 clips." Tap the count → canonical picker opens. Confirm both clips visible; first-generated has Canonical badge.
8. **Change canonical.** In the picker, tap "Set as canonical" on the second clip. Confirm: badge moves, picker reflects new canonical, storyboard PUT succeeds. Close picker. Tap Generate on Scene 2. Confirm the new canonical's last frame is now suggested (chaining adapts).
9. **Edit a scene.** Tap Edit on Scene 3. Confirm modal opens with prefilled fields. Edit the description and prompt. Add notes. Adjust duration. Save. Confirm scene card updates; PUT succeeded; reload page → changes persisted.
10. **Cancel with dirty state.** Open Edit on Scene 4. Edit a field. Tap Cancel. Confirm the discard-confirm dialog. Cancel discard → modal stays. Tap Cancel again, confirm discard. Modal closes; no changes.
11. **Edit validation.** Open Edit on Scene 5. Empty the description. Try to Save. Confirm validation prevents save. Restore, save successfully.
12. **Modal sidebar from ProjectDetail.** In the project's clip strip, tap a clip generated from a scene. Confirm the modal sidebar shows "Scene N · description" line.
13. **Modal sidebar from Gallery.** In the global gallery, tap a clip with sceneId set. Confirm graceful degradation — either short "Scene <id-prefix>" or no line, depending on path (a) vs (b). Document which.
14. **Stale canonical.** Set a scene's canonicalClipId via the picker. Then delete that clip from the gallery. Reload the project. Confirm the scene falls back to earliest-created. Subsequent chaining uses the fallback.
15. **No-storyboard regression.** Open a project with no storyboard. Confirm: storyboard section in empty state, regular Generate buttons work as before, no scene-related UI surfaces.
16. **Storyboard delete.** Generate clips for several scenes. Delete the storyboard via the Phase 5a delete button. Confirm: storyboard section returns to empty state. The clips remain in the project (not deleted) but their `sceneId` references become orphans. Open one of the clips: confirm the modal sidebar handles missing-storyboard gracefully (no crash, no scene line, or "Scene (deleted)").
17. **Regression: existing video generation.** Use Studio's regular video generation flow (no scene context). Confirm clips persist with `sceneId: null` and don't get scene badges anywhere.
18. **Regression: image generation.** Image clips should have `sceneId: null`. Storyboard generation never targets image mode. Verify.
19. **Disk-avoidance check.** After several scene generations: `ssh a100 ls /models/ComfyUI/output/` should show no orphan `.png` or `.webm` files. The hijack contract is unchanged.

---

## Out of scope

- **Scene reordering.** Drag-to-reorder, position editing — 5c.
- **Adding/removing scenes manually.** A storyboard's scene set is fixed at generation time; user regenerates the whole storyboard if they want different scenes. 5c may add insert/delete.
- **LLM-iterative editing of scenes.** "Rewrite scene 3 to be moodier" — 5c.
- **Auto-generating all scenes** (one-tap generate-all). 5c — needs queue-management considerations.
- **Storyboard versioning / undo.** Single live storyboard; replace-on-regenerate.
- **Cross-project scene linking.** Scenes belong to one project.
- **Scene templates / cloning.** Out of scope.
- **The clip badge in the project clip strip** (small "Scene 3" label on each clip tile). Modal sidebar covers it; tile-level badges are visual clutter on tablet. Skip for 5b.
- **Tap-to-scroll-to-scene from the modal sidebar.** Informational only in 5b. 5c can add navigation.
- **Per-scene generation parameters override** (each scene gets its own LoRA stack, lightning toggle, etc.). For 5b, scenes inherit project defaults; the user can adjust in Studio per-generation. Persisting per-scene params is 5c if useful.
- **Auto-set canonical when first clip lands.** Resolution rule (Part 7) handles this client-side via fallback — no auto-PUT needed. Storage stays clean.
- **Notification or indicator when a scene's chaining suggestion changes** (e.g., user changes Scene 2's canonical → Scene 3's chaining target changes). The next time the user taps Generate on Scene 3, the new value is used. No proactive UI signal needed.
- **Validation that sceneId on generate-video request matches an existing scene in the project's storyboard.** Trust the client.

---

## Documentation

In CLAUDE.md, find the Phase 5a section (added by the prior batch). Add a Phase 5b subsection:

> ## Phase 5b — Storyboard scene execution + editing
>
> Each scene gets a "Generate this scene" button that bounces to Studio with the scene's prompt + duration + suggested i2v starting frame pre-filled. Generated clips persist `sceneId` (new column on `Generation`) for traceability. Last-frame chaining is suggested-but-overridable: Scene N's Generate button suggests Scene N-1's canonical clip's last frame as the i2v starting frame; the existing GalleryPicker remains available for overrides or hard cuts.
>
> **Canonical clip per scene:** when a scene has multiple generated clips, one is "canonical" — the chaining target. `StoryboardScene.canonicalClipId` stores the user's pick. When unset, fallback is the earliest-created clip with that sceneId. The `CanonicalClipPickerModal` lets the user choose.
>
> **Scene editing:** `SceneEditModal` allows editing each scene's description, prompt, durationSeconds, and notes. Position is fixed in 5b; reordering is 5c.
>
> **Clip back-reference:** clips with `sceneId` set show a "Scene N" line in the `ImageModal` sidebar when opened from ProjectDetail (where the storyboard is in scope). From Gallery the line gracefully degrades.
>
> **Trigger payload:** `ProjectContext.sceneContext` (optional) carries scene-specific overrides on top of project defaults. Studio's apply-trigger effect applies the scene's prompt, duration → frames conversion, and starting-frame suggestion. `Studio.activeSceneId` (new state) flows the sceneId to the generate-video request body.

In the source layout, add:
- `src/components/SceneEditModal.tsx` — scene editing bottom-sheet modal.
- `src/components/CanonicalClipPickerModal.tsx` — canonical clip picker bottom-sheet modal.
- A note on `ProjectDetail.tsx`: now hosts per-scene Generate buttons, scene edit triggers, canonical picker integration, and the chaining-suggestion logic.

In the schema doc block, add `sceneId String?` to the `Generation` model with a comment matching the existing nullable-field pattern.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
