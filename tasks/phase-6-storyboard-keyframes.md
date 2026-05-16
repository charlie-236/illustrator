# Batch — Phase 6: Storyboard keyframes (cheap previews + promote to video)

Phase 5 plans, 5b/5c executes. Phase 6 adds the cost-control layer: cheap image keyframes per scene that can be reviewed, regenerated, and promoted to video. Keyframes are tightly coupled — when a scene has a canonical keyframe, that's what the video starts from (i2v). No double-pay on rejected scenes, faster iteration on storyboards.

**Glossary:** A *keyframe* is a quick preview image (~20-30 seconds to generate) representing a scene. It's the visual answer to "is this scene heading in the right direction?" before committing GPU time on Wan video (~3 minutes). Quality is acceptable-but-not-final — the goal is direction, not polish. When a scene has a canonical keyframe, video generation uses it as the i2v starting frame. Always images, never videos. Always per-scene-bound (via `Generation.sceneId`). Always inline (no Studio bounce regardless of `quickGenerate`).

Economics: image generation ~30s, Wan 2.2 Lightning video ~3 min. A 10-scene storyboard at keyframe-only cost: ~5 min. Same storyboard rendered as videos: ~30 min. Iterate cheaply, commit selectively.

Two distinct generation surfaces:
- **Per-scene keyframe** — tap "Generate keyframe" on a scene card. One scene. For iterating on a specific scene.
- **Whole-storyboard batch** — tap "Generate keyframes (N needed)" in the storyboard section header. All scenes that don't yet have a canonical keyframe submit at once. Walk away ~5 minutes; come back to a populated storyboard.

Reuses infrastructure:
- `Generation.sceneId` column (5b) — keyframes are images with sceneId set
- `mediaType: 'image'` distinguishes keyframes from clips
- Canonical clip picker pattern (5b) → canonical keyframe picker
- Inline submission + polling pattern (5c) → inline keyframe generation
- Chaining precedence (5b) → extends with keyframe-as-priority

Re-read CLAUDE.md before starting, particularly the Phase 5 sections and the existing scene execution path.

---

## Critical: disk-avoidance and tablet UX

This batch doesn't touch the workflow build path, the WS finalize path, or any output-handling logic. Keyframe images use the same `/api/generate` route as regular image generation; they go to `IMAGE_OUTPUT_DIR` like any other image. The forbidden-class-type guards apply equally. Verify with the standard greps.

Tablet UX rules apply throughout. The storyboard-level batch button needs particular attention because it's high-stakes (kicks off N generations); the affordance and confirmation must be unambiguous.

---

## Required changes

### Part 1 — Schema-shape: `canonicalKeyframeId` on `StoryboardScene`

`src/types/index.ts`:

```ts
export interface StoryboardScene {
  id: string;
  position: number;
  description: string;
  positivePrompt: string;
  durationSeconds: number;
  notes?: string | null;
  canonicalClipId?: string | null;
  canonicalKeyframeId?: string | null;
}
```

No Prisma change — `Project.storyboardJson` is `Json?`; the field becomes part of the stored object. Existing storyboards deserialize cleanly (missing field = null = fallback).

The PUT validator at `src/app/api/projects/[id]/storyboard/route.ts` accepts the new optional field.

### Part 2 — Resolution helpers

The existing `resolveCanonicalClipId` (from 5b) needs an explicit `mediaType: 'video'` filter:

```ts
function resolveCanonicalClipId(scene: StoryboardScene, projectClips: ProjectClip[]): string | null {
  const videoClips = projectClips.filter((c) => c.sceneId === scene.id && c.mediaType === 'video');
  if (scene.canonicalClipId && videoClips.some((c) => c.id === scene.canonicalClipId)) {
    return scene.canonicalClipId;
  }
  const earliest = videoClips
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
  return earliest?.id ?? null;
}

function resolveCanonicalKeyframeId(scene: StoryboardScene, projectClips: ProjectClip[]): string | null {
  const keyframes = projectClips.filter((c) => c.sceneId === scene.id && c.mediaType === 'image');
  if (scene.canonicalKeyframeId && keyframes.some((k) => k.id === scene.canonicalKeyframeId)) {
    return scene.canonicalKeyframeId;
  }
  const earliest = keyframes
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
  return earliest?.id ?? null;
}
```

### Part 3 — Project clips API surfaces mediaType

`src/app/api/projects/[id]/route.ts` — verify the `select` clause on the project's clips includes `mediaType` (it should already, post-5b). If missing, add it.

### Part 4 — Updated chaining precedence

Starting-frame-source decision tree per scene:

1. **This scene's canonical keyframe** (if exists) → use its image as the i2v starting frame
2. **Previous scene's canonical clip's last frame** (5b logic) → extract via `/api/extract-last-frame/[clipId]`
3. **None** → t2v

Update both `handleGenerateScene` (Studio-bounce path) and `handleQuickGenerateScene` (inline path from 5c).

`SceneTriggerContext` widens:

```ts
export interface SceneTriggerContext {
  sceneId: string;
  sceneIndex: number;
  prompt: string;
  durationSeconds: number;
  suggestedStartingClipId: string | null;
  suggestedStartingKeyframeId: string | null;
}
```

Studio's apply-trigger effect:

```ts
if (sc.suggestedStartingKeyframeId) {
  await handleStartingFromKeyframe(sc.suggestedStartingKeyframeId);
} else if (sc.suggestedStartingClipId) {
  await handleStartingClipPicked(sc.suggestedStartingClipId);
}
```

`handleStartingFromKeyframe(keyframeId)` is a new helper — load the keyframe's image as base64 (Part 12 helper) and populate the same Studio state that the GalleryPicker → starting frame flow uses.

For `handleQuickGenerateScene` (inline, 5c): same precedence — if canonical keyframe exists, fetch its base64 and use as `startingFrameImage` in the POST body.

### Part 5 — Scene card layout

Each scene card displays both keyframes and clips with separate thumbnails, counts, and Generate buttons:

```
┌──────────────────────────────────────────────┐
│ Scene 3 · 4s                                  │
│ A young girl climbs creaky stairs into a      │
│ dusty attic.                                   │
│                                                │
│ <prompt in monospace>                          │
│                                                │
│ [keyframe thumb]    [clip thumb]               │
│ 🖼 2 keyframes      🎬 1 clip                  │
│                                                │
│ [ Generate keyframe ]   [ Generate this scene ]│
│                                          ✏️    │
└──────────────────────────────────────────────┘
```

Layout rules:
- Keyframe thumbnail = `<img>` of canonical keyframe; empty state = neutral placeholder with 🖼 icon
- Clip thumbnail = `<video preload="metadata" muted playsInline>` of canonical clip; empty state = 🎬 icon placeholder
- Each thumbnail tappable → opens `ImageModal`
- Each count line tappable → opens picker
- Counts only show when value > 0
- Tap targets ≥44px throughout
- In-flight generation replaces button with "Generating..." pill

### Part 6 — Per-scene inline keyframe generation

`handleGenerateKeyframe(scene)`:

```ts
async function handleGenerateKeyframe(scene: StoryboardScene) {
  if (inFlightKeyframeScenes.has(scene.id)) return;

  const checkpoint = readLastUsedImageCheckpoint() ?? modelLists.checkpoints[0];
  if (!checkpoint) {
    setKeyframeError({ sceneId: scene.id, message: 'No image checkpoint available' });
    return;
  }

  const params: GenerationParams = {
    positivePrompt: scene.positivePrompt,
    negativePrompt: '',
    checkpoint,
    width: project.defaultWidth ?? 1280,
    height: project.defaultHeight ?? 704,
    steps: 25,
    cfg: 7,
    sampler: 'euler',
    scheduler: 'normal',
    seed: -1,
    batchSize: 1,
    loras: [],
    highResFix: false,
    projectId: project.id,
    sceneId: scene.id,
  };

  setInFlightKeyframeScenes((prev) =>
    new Map(prev).set(scene.id, { startedAt: Date.now(), promptId: '' }),
  );

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('No SSE body');

    const promptId = await readInitEvent(res.body);
    setInFlightKeyframeScenes((prev) => {
      const next = new Map(prev);
      next.set(scene.id, { startedAt: Date.now(), promptId });
      return next;
    });
    addJob({
      promptId,
      generationId: '',
      mediaType: 'image',
      promptSummary: `Keyframe — Scene ${scene.position + 1}: ${scene.description.slice(0, 40)}`,
    });
  } catch (err) {
    setInFlightKeyframeScenes((prev) => {
      const next = new Map(prev);
      next.delete(scene.id);
      return next;
    });
    setKeyframeError({ sceneId: scene.id, message: String(err) });
  }
}
```

`readInitEvent` is the helper from 5c. `readLastUsedImageCheckpoint()` reads the same `sessionStorage` key Studio uses; falls back to `modelLists.checkpoints[0]`.

### Part 7 — Whole-storyboard keyframe batch

The storyboard section's populated-state header gains a new button alongside Regenerate / Delete:

```
📓 Storyboard ▼                          Generated 2h ago · 10 scenes
                                         ⚡ Quick generate  [○━━]

[ Generate keyframes (7 needed) ]   [ Regenerate ]   [ Delete ]
```

Button label and visibility:
- Label: `Generate keyframes (N needed)` where N = count of scenes whose `resolveCanonicalKeyframeId(scene, projectClips)` returns null
- N === 0: hide entirely
- Any keyframe in-flight from this batch: button shows `Generating keyframes (X/Y)` where X = completed-in-this-batch, Y = total-in-this-batch; disabled

Tap → confirm dialog (because this is N-tap-amplification — one tap fires N generations):

> Generate keyframes for 7 scenes?
>
> This will queue 7 image generations on the GPU. They'll run in sequence and complete in roughly 3-4 minutes. You can keep using the app while they generate.
>
> [ Cancel ]   [ Generate ]

On confirm:

```ts
async function handleGenerateAllKeyframes() {
  const scenesNeedingKeyframes = storyboard.scenes.filter(
    (s) => resolveCanonicalKeyframeId(s, projectClips) === null,
  );
  if (scenesNeedingKeyframes.length === 0) return;

  // Submit all in parallel — ComfyUI's queue handles GPU serialization.
  // Don't await; the polling effect handles completions.
  for (const scene of scenesNeedingKeyframes) {
    void handleGenerateKeyframe(scene);
  }
}
```

Each scene's submission goes through the existing `handleGenerateKeyframe` → in-flight Map → polling completion path. ComfyUI's queue serializes GPU work; the client doesn't try to control ordering. Each scene's per-card UI feedback is independent.

**Mid-batch failure handling — quiet partial success:** if 7 submit and 3 fail at the route level, per-scene error banners surface on the failed cards. The 4 that succeeded land normally as they complete. No storyboard-level progress bar; no aggregate failure summary. The user sees succeeded scenes by looking at the cards; retries failed ones individually via per-scene Generate.

The "X/Y completed" text in the disabled batch button is purely informational — it doesn't gate retry. Once X reaches Y (or the in-flight Map empties from this batch's submissions), the button reverts to its idle state, with N recalculated. If 3 scenes failed, the button shows `Generate keyframes (3 needed)` again — natural retry path.

### Part 8 — Tracking batch state

Beyond the existing `inFlightKeyframeScenes` Map, add a small piece of state to track which scenes are part of an in-progress batch (for the `(X/Y)` button label):

```ts
const [batchKeyframeScenes, setBatchKeyframeScenes] = useState<Set<string>>(new Set());
```

`handleGenerateAllKeyframes` sets `batchKeyframeScenes` to the IDs of scenes it submitted. The polling effect, on each in-flight removal that's also in `batchKeyframeScenes`, recomputes display. When `batchKeyframeScenes` is empty (all completed or stale-cleared), reset.

The X/Y label:

```ts
const batchTotal = batchKeyframeScenes.size;
const batchCompleted = Array.from(batchKeyframeScenes).filter(
  (id) => !inFlightKeyframeScenes.has(id),
).length;
// label: `Generating keyframes (${batchCompleted}/${batchTotal})`
```

### Part 9 — Inline keyframe completion polling

ProjectDetail tracks two in-flight Maps: video clips (5c) and keyframes. Both poll the project endpoint at the same 5s cadence — combine into one polling effect:

```ts
useEffect(() => {
  if (inFlightVideoScenes.size === 0 && inFlightKeyframeScenes.size === 0) return;

  const interval = setInterval(async () => {
    const fresh = await fetchProject(project.id);
    setProject(fresh);
    const now = Date.now();

    setInFlightVideoScenes((prev) => {
      const next = new Map(prev);
      for (const [sceneId, entry] of prev.entries()) {
        const newClip = fresh.clips.find(
          (c) =>
            c.sceneId === sceneId &&
            c.mediaType === 'video' &&
            new Date(c.createdAt).getTime() > entry.startedAt,
        );
        if (newClip) next.delete(sceneId);
        else if (now - entry.startedAt > STALE_INFLIGHT_MS) next.delete(sceneId);
      }
      return next;
    });

    setInFlightKeyframeScenes((prev) => {
      const next = new Map(prev);
      for (const [sceneId, entry] of prev.entries()) {
        const newKeyframe = fresh.clips.find(
          (c) =>
            c.sceneId === sceneId &&
            c.mediaType === 'image' &&
            new Date(c.createdAt).getTime() > entry.startedAt,
        );
        if (newKeyframe) next.delete(sceneId);
        else if (now - entry.startedAt > STALE_INFLIGHT_MS) next.delete(sceneId);
      }
      return next;
    });

    // Reset batch tracking when no batch scenes still in-flight
    setBatchKeyframeScenes((prev) => {
      const stillInFlight = Array.from(prev).filter((id) => inFlightKeyframeScenes.has(id));
      return stillInFlight.length === 0 ? new Set() : prev;
    });
  }, 5000);

  return () => clearInterval(interval);
}, [inFlightVideoScenes.size, inFlightKeyframeScenes.size, project.id]);
```

Stale timeout: 30 minutes (matches 5c).

### Part 10 — Canonical keyframe picker modal

New component, `src/components/CanonicalKeyframePickerModal.tsx`. Bottom-sheet pattern, mirroring the canonical clip picker (5b).

Opens when the user taps the keyframe count line ("2 keyframes") on a scene card. Lists all keyframes with `sceneId === scene.id` and `mediaType === 'image'` as image tiles.

Each row:

```
┌──────────────────────────────────────────────┐
│ <image tile, full width>          [Canonical] │
│ Generated 1h ago · seed 8821                  │
│ [ Set as canonical ] [ Promote to video ] [ Regenerate ] │
└──────────────────────────────────────────────┘
```

Three actions:
- **Set as canonical** — PUT storyboard with new `canonicalKeyframeId`
- **Promote to video** — generates video using THIS specific keyframe (regardless of canonical); honors `quickGenerate` toggle for Studio-bounce vs inline
- **Regenerate** — same handler as scene card "Generate keyframe"

Tap a keyframe tile → `ImageModal` at that keyframe.

### Part 11 — Modal sidebar info

`src/components/ImageModal.tsx` — when displaying a keyframe (image with `sceneId` set, opened from ProjectDetail):

```
Keyframe
Scene 3 of 5 · "A young girl climbs creaky stairs..."

[ Promote to video ]
```

For clips (video with sceneId), 5b's existing sidebar info stays:

```
Scene
Scene 3 of 5 · "A young girl climbs creaky stairs..."
```

Gallery context (no storyboard in scope) — graceful degradation per 5b's path-(b) gating.

### Part 12 — `/api/generate` accepts `sceneId`; image-to-base64 helper

Verify the image generate route accepts `sceneId`. If not, add:

```ts
sceneId: typeof body.sceneId === 'string' && body.sceneId.length > 0 ? body.sceneId : undefined,
```

`finalizeImageJob` writes it to the DB row (mirror `finalizeVideoJob`'s pattern from 5b).

Image-to-base64 helper used by both Studio's `handleStartingFromKeyframe` and the promote-to-video paths:

```ts
async function imageToBase64(filePath: string): Promise<string> {
  const res = await fetch(imgSrc(filePath));
  if (!res.ok) throw new Error('Failed to load keyframe image');
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
```

If the keyframe image fails to load (rare), fall back to t2v with a small note in the error toast — don't block the entire flow.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "canonicalKeyframeId" src/types/index.ts` shows the field on `StoryboardScene`.
- `grep -n "resolveCanonicalKeyframeId\|resolveCanonicalClipId" src/components/ProjectDetail.tsx` shows both helpers, with `resolveCanonicalClipId` filtering by `mediaType: 'video'`.
- `grep -n "handleGenerateKeyframe\|handleGenerateAllKeyframes\|inFlightKeyframeScenes\|batchKeyframeScenes" src/components/ProjectDetail.tsx` shows per-scene flow, batch flow, in-flight tracking, and batch tracking.
- `src/components/CanonicalKeyframePickerModal.tsx` exists.
- `grep -n "sceneId" src/app/api/generate/route.ts` shows acceptance and pass-through.
- `grep -n "sceneId" src/lib/comfyws.ts` shows `finalizeImageJob` writing the field.
- Scene cards display two thumbnails (keyframe + clip) and two action buttons.
- Chaining precedence (keyframe → clip last frame → t2v) is implemented in both Studio-bounce and quick-generate paths.
- Storyboard section header shows "Generate keyframes (N needed)" when N > 0; hidden when N === 0; shows "Generating keyframes (X/Y)" while batch in-flight.
- Tapping the batch button shows a confirm dialog before submitting.
- "Promote to video" works from picker and modal sidebar.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet, full sequence):

1. **Schema continuity.** Open a project with an existing 5a/5b storyboard. Confirm scene cards render correctly with the new keyframe section in empty state.
2. **Per-scene keyframe — happy path.** Tap "Generate keyframe" on Scene 1. In-flight pill appears; queue tray shows the image generation. Wait ~30s. Confirm keyframe thumbnail appears on the scene card; "1 keyframe" count visible.
3. **Whole-storyboard batch — happy path.** Open a project with a fresh 10-scene storyboard, no keyframes. Confirm "Generate keyframes (10 needed)" button visible. Tap. Confirm dialog appears with the count. Confirm. Watch all 10 scene cards transition to "Generating..." pills. Walk away. Return after ~5 minutes. Confirm all 10 keyframes have populated.
4. **Whole-storyboard batch — partial coverage.** With 3 scenes already having canonical keyframes, confirm button label says "Generate keyframes (7 needed)". Tap and confirm. Confirm only 7 go in-flight; the 3 already-covered are unchanged.
5. **Whole-storyboard batch — button hides when complete.** With every scene having a canonical keyframe, confirm the button is hidden. (Per-scene Generate keyframe still works.)
6. **Whole-storyboard batch — dialog cancel.** Tap; cancel the dialog. Confirm no submissions fire.
7. **Whole-storyboard batch — partial failure.** Stop ComfyUI after the first 3 keyframes complete (or otherwise force later submissions to fail). Confirm: 3 keyframes land normally; remaining scenes' in-flight pills clear; per-scene error banners surface; user can retry failed scenes individually. Button reverts to "Generate keyframes (N needed)" with the failed count.
8. **Whole-storyboard batch — concurrent with video.** While a 5c quick-generate video is in-flight on Scene 3, tap the batch button with Scene 3 needing one. Confirm: Scene 3's keyframe submits alongside its video; both complete independently.
9. **Promote to video (canonical).** With canonical keyframe on Scene 1, tap "Generate this scene". Confirm resulting video uses keyframe as i2v starting frame.
10. **Promote to video (specific, non-canonical).** Generate a second keyframe on Scene 1. Open picker. Tap "Promote to video" on the second. Confirm video generation uses that specific keyframe.
11. **Set canonical via picker.** Tap "Set as canonical" on the second keyframe. Confirm badge moves; storyboard PUT succeeds. Re-tap "Generate this scene" — new canonical's image is used.
12. **Precedence: keyframe wins over chained clip.** Generate Scene 1's clip. Generate Scene 2's keyframe. Tap "Generate this scene" on Scene 2. Confirm starting frame is Scene 2's keyframe, NOT Scene 1's clip's last frame.
13. **Precedence: chained clip when no keyframe.** Scene 1 video generated, Scene 2 has no keyframe. Tap Generate on Scene 2. Confirm starting frame is Scene 1's clip's last frame.
14. **Precedence: t2v when neither.** Tap Generate on Scene with no keyframe and no previous clip. Confirm t2v.
15. **Studio-bounce path with keyframe.** With `quickGenerate` OFF, Scene 1 has canonical keyframe. Tap "Generate this scene". Confirm Studio opens; i2v starting frame pre-filled with keyframe.
16. **Modal sidebar — keyframe.** Tap a keyframe thumbnail. Modal sidebar shows "Keyframe — Scene N · description"; Promote button visible. Tap promote; video generation starts.
17. **Modal sidebar — clip.** Tap a clip thumbnail. Sidebar shows "Scene — Scene N · description" (informational, no button per 5b).
18. **Modal sidebar — gallery context.** Open a keyframe from global Gallery. Confirm graceful degradation.
19. **Stale canonical.** Set canonical keyframe; delete that keyframe via gallery. Reload project. Confirm fallback to earliest-keyframe.
20. **Disk-avoidance.** After many keyframe + video generations: `ssh <gpu-vm> ls /models/ComfyUI/output/*.png` returns "no such file or directory."
21. **Storyboard delete preserves keyframes' scene reference.** Delete the storyboard. Generated keyframes remain; their `sceneId` becomes orphan. Same as 5b clip behavior.

---

## Out of scope

- **Storyboard-level batch progress UI** beyond the simple X/Y counter ("Generating keyframes — 4/10 complete with detailed per-scene timeline"). Per-scene cards convey individual state.
- **"Regenerate all keyframes" button** (regardless of existing canonicals). First cut is fill-the-gaps only. Could be a future feature.
- **Cancel-mid-batch.** Once submitted, all N go through. Per-scene cancel via queue tray still works; no batch-level cancel.
- **Editing the keyframe prompt separately from the scene prompt.** Keyframe uses the scene's `positivePrompt` as-is. If consistently producing poor first-frames, the LLM system prompt can be tuned to produce both video and keyframe prompts — Phase 5a iteration.
- **Per-scene checkpoint or LoRA selection for keyframes.** All scenes use last-selected image checkpoint, no LoRAs.
- **Multi-batch keyframe variation per scene** ("generate 4 variants"). Single-take per tap.
- **Auto-promote first keyframe to canonical.** Resolution helper handles fallback. No implicit storyboard PUTs.
- **Hide / archive non-canonical keyframes.** They stay in the gallery.
- **Keyframe-specific gallery filter.** Four-way filter handles it — keyframes show under Images.
- **Tracking keyframe→video lineage explicitly.** Not needed.
- **Server-side `startingKeyframeId` in `/api/generate-video`.** Client-side base64 (option b) is simpler.

---

## Documentation

In CLAUDE.md, add a Phase 6 section under the existing Phase 5 sections:

> ## Phase 6 — Storyboard keyframes
>
> A *keyframe* is a quick image preview of a scene (~30 seconds vs ~3 minutes for video). Each scene gains a "Generate keyframe" affordance and a thumbnail tile alongside its clip tile. Keyframes are `Generation` rows with `mediaType: 'image'` and `sceneId` set.
>
> **Tight coupling.** A scene's canonical keyframe IS the i2v starting frame for that scene's video generation. Promoting a keyframe to video runs Wan i2v from exactly that image.
>
> **Two generation surfaces.** Per-scene "Generate keyframe" (one scene at a time, on the scene card) and storyboard-level "Generate keyframes (N needed)" (whole-storyboard batch, in the section header). Batch button hides when no scenes need keyframes; submits all needing scenes in parallel via ComfyUI's queue. Mid-batch failures surface as per-scene error banners; quiet partial success.
>
> **Precedence for starting frame source:** scene's canonical keyframe → previous scene's canonical clip's last frame (5b) → none (t2v). Applied in both quick-generate (5c) and Studio-bounce paths.
>
> **Always inline.** Keyframe generation never bounces to Studio (regardless of `Storyboard.quickGenerate`). The toggle controls only the video Generate path.
>
> **Cost economics:** keyframe-only iteration on a 10-scene storyboard is ~5 min; same at video cost is ~30 min. Approve the storyboard cheaply, commit GPU time selectively.

In the source layout, add:
- `src/components/CanonicalKeyframePickerModal.tsx`
- A note on `ProjectDetail.tsx`: hosts per-scene and whole-storyboard keyframe generation flows, the keyframe + clip dual-thumbnail scene card layout, and the unified polling effect.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
