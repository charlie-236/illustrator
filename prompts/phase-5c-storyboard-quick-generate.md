# Batch — Phase 5c: Storyboard quick-generate toggle

The Phase 5b "Generate this scene" flow bounces to Studio with the form pre-filled. That's the right call when the user wants to tweak parameters before generating — but it's friction when they trust the LLM and just want to see what it makes. Tap → tab switch → Studio loads → tap Generate is three transitions where it could be one.

Add a per-storyboard toggle: **Quick generate**. When ON, the per-scene Generate button skips Studio entirely. It builds parameters from the scene + project defaults, forces Lightning ON for speed, and submits directly to `/api/generate-video`. The user stays in Project Detail; the queue tray (already present, already polling) shows progress; when the clip lands, the scene card updates inline.

When OFF (default), behavior is unchanged from 5b — Studio bounce with full parameter control.

Re-read CLAUDE.md before starting. Disk-avoidance is unaffected — quick-generate uses the same `/api/generate-video` endpoint and same workflow build path as the existing video flow.

Tablet UX: the toggle and the in-flight scene affordance both follow tablet-first rules (≥44px tap targets, clear visual feedback).

---

## Required changes

### Part 1 — Schema-shape: `quickGenerate` on `Storyboard`

`src/types/index.ts`:

```ts
export interface Storyboard {
  scenes: StoryboardScene[];
  generatedAt: string;
  storyIdea: string;
  quickGenerate?: boolean;   // NEW — default false / undefined
}
```

No Prisma change needed — `Project.storyboardJson` is a `Json?` column; the field just becomes part of the stored object. Existing storyboards deserialize cleanly (missing field treated as false).

The PUT validator at `src/app/api/projects/[id]/storyboard/route.ts` accepts the new optional boolean field. Trim/coerce as needed.

### Part 2 — Toggle UI in storyboard section header

`src/components/ProjectDetail.tsx` — in the storyboard section's populated-state header (where the collapse chevron, "Generated <time> · <N> scenes" line, and Regenerate / Delete buttons live), add the toggle.

Layout option (tablet-friendly):

```
📓 Storyboard ▼                                           Generated 2h ago · 5 scenes
                                                          ⚡ Quick generate  [○━━]   ← toggle
```

The toggle is a labeled switch (mirror existing toggle patterns in the codebase — likely in `Studio.tsx` for Lightning toggle, or `ProjectDetail.tsx` favorites). Tap target ≥44px. Brief help text on tap-and-hold or below the toggle:

> Generate scenes inline with Lightning defaults. Tap to toggle off if you want to fine-tune in Studio.

State changes persist immediately:

```ts
const handleQuickGenerateToggle = async (next: boolean) => {
  if (!storyboard) return;
  const updated: Storyboard = { ...storyboard, quickGenerate: next };
  // Optimistic update; reconcile from PUT response
  setLocalStoryboard(updated);
  try {
    await fetch(`/api/projects/${project.id}/storyboard`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storyboard: updated }),
    });
  } catch (err) {
    // Revert on failure
    setLocalStoryboard(storyboard);
    setToggleError(String(err));
  }
};
```

### Part 3 — Branch in `handleGenerateScene`

The existing scene Generate handler currently builds a `ProjectContext` with `sceneContext` and dispatches to Studio. Branch on the toggle:

```ts
async function handleGenerateScene(scene: StoryboardScene) {
  if (storyboard.quickGenerate) {
    return handleQuickGenerateScene(scene);
  }
  // Existing path: build trigger, switch tab to Studio
  return handleStudioGenerateScene(scene);
}
```

### Part 4 — Quick-generate path: build params + submit + register

`handleQuickGenerateScene(scene)`:

```ts
async function handleQuickGenerateScene(scene: StoryboardScene) {
  // Already-in-flight guard (Part 6) — bail if this scene's already generating
  if (inFlightSceneIds.has(scene.id)) return;

  // 1. Resolve suggested starting frame (existing helper from 5b)
  const suggestedStartingClipId = resolveSuggestedStartingClipId(scene, storyboard.scenes, projectClips);

  // 2. Build the generate-video request body
  const params: VideoGenerationRequest = {
    positivePrompt: scene.positivePrompt,
    negativePrompt: '',  // Wan default; 5a's polish-style negative isn't in scope here
    width: project.defaultWidth ?? 1280,
    height: project.defaultHeight ?? 704,
    frames: clampToValidFrameCount(scene.durationSeconds * 16),
    steps: 4,             // Lightning default
    cfg: 1,               // Lightning default
    seed: -1,
    lightning: true,      // FORCE ON for quick-generate
    loras: project.defaultVideoLoras ?? [],
    projectId: project.id,
    sceneId: scene.id,
    // Starting frame
    ...(suggestedStartingClipId
      ? { startingClipId: suggestedStartingClipId }
      : {}),
    batchSize: 1,
  };

  // The exact field names must match what /api/generate-video accepts.
  // Read the route's request schema and align this construction to it.

  // 3. Mark in-flight (UI feedback)
  setInFlightSceneIds((prev) => new Set(prev).add(scene.id));

  // 4. Submit and read only the init event for promptId
  let promptId = '';
  try {
    const res = await fetch('/api/generate-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('No SSE body');

    promptId = await readInitEvent(res.body);
  } catch (err) {
    setInFlightSceneIds((prev) => {
      const next = new Set(prev);
      next.delete(scene.id);
      return next;
    });
    setQuickGenerateError({ sceneId: scene.id, message: String(err) });
    return;
  }

  // 5. Register with QueueContext so the queue tray shows it
  addJob({
    promptId,
    generationId: '',  // populated on completion via project refetch
    mediaType: 'video',
    promptSummary: `Scene ${scene.position + 1}: ${scene.description.slice(0, 40)}`,
    // ... other fields per existing addJob signature
  });
}
```

`readInitEvent(stream)` reads the SSE stream until the `init` event arrives, extracts `promptId`, and discards the rest. The server keeps generating; the client doesn't need ongoing SSE for the quick path. Pattern:

```ts
async function readInitEvent(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Stream ended before init event');
      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split('\n\n');
      buffer = messages.pop() ?? '';
      for (const message of messages) {
        if (!message.includes('event: init')) continue;
        const dataLine = message.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        const data = JSON.parse(dataLine.slice(6)) as { promptId: string };
        return data.promptId;
      }
    }
  } finally {
    reader.cancel().catch(() => { /* ignore */ });
  }
}
```

Cancelling the reader after init is fine — the server-side generation continues independently. This matches how the queue tray's refresh-recovery already handles "client disconnected, server kept working."

### Part 5 — Completion-driven refetch

Track in-flight scenes locally; refetch the project when any complete.

ProjectDetail-level state:

```ts
const [inFlightSceneIds, setInFlightSceneIds] = useState<Set<string>>(new Set());
```

When `inFlightSceneIds.size > 0`, run a polling effect:

```ts
useEffect(() => {
  if (inFlightSceneIds.size === 0) return;
  const interval = setInterval(async () => {
    const fresh = await fetchProject(project.id);
    setProject(fresh);
    // Detect which in-flight scenes now have a clip with sceneId === scene.id
    // that wasn't there before, and remove them from the set
    setInFlightSceneIds((prev) => {
      const next = new Set(prev);
      for (const sceneId of prev) {
        const sceneClips = fresh.clips.filter((c) => c.sceneId === sceneId);
        // If the count grew vs the snapshot we had at submit time, this scene completed
        // (Simpler heuristic: if any clip with this sceneId was created after the in-flight
        // entry was added, the scene completed.)
        if (sceneClips.length > 0 && /* completion detected */) {
          next.delete(sceneId);
        }
      }
      return next;
    });
  }, 5000);
  return () => clearInterval(interval);
}, [inFlightSceneIds.size, project.id]);
```

A simpler completion-detection scheme: store a timestamp alongside each in-flight scene id. On each poll, check whether any new clip with `sceneId === <inFlightSceneId>` and `createdAt > <inFlightTimestamp>` exists. If yes, that scene completed.

Map shape:

```ts
const [inFlightScenes, setInFlightScenes] = useState<Map<string, { startedAt: number; promptId: string }>>(new Map());
```

On submit:

```ts
setInFlightScenes((prev) => new Map(prev).set(scene.id, { startedAt: Date.now(), promptId }));
```

On poll:

```ts
const now = Date.now();
const completedSceneIds: string[] = [];
for (const [sceneId, entry] of inFlightScenes.entries()) {
  const newClip = fresh.clips.find(
    (c) => c.sceneId === sceneId && new Date(c.createdAt).getTime() > entry.startedAt
  );
  if (newClip) completedSceneIds.push(sceneId);
}
if (completedSceneIds.length > 0) {
  setInFlightScenes((prev) => {
    const next = new Map(prev);
    for (const id of completedSceneIds) next.delete(id);
    return next;
  });
  // Optional: brief success flash on the scene card
}
```

Polling cadence: 5 seconds matches the existing queue-tray polling. Stop the interval when `inFlightScenes.size === 0`.

### Part 6 — Scene card in-flight UI

When `inFlightScenes.has(scene.id)`:

- The "Generate this scene" button is replaced by a disabled "Generating..." pill with a small spinner and elapsed-time display: "Generating... 0:42"
- Tap is no-op (disabled)
- The Edit button stays available — editing while generating is fine; saved edits apply to future generations, not the in-flight one

Visual:

```
┌──────────────────────────────────────────────┐
│ Scene 3 · 4s · 1 clip                         │
│ A young girl climbs creaky stairs...          │
│                                                │
│ <prompt>                                       │
│                                                │
│ <thumbnail of canonical clip>                  │
│                                                │
│ [ ⏳ Generating... 0:42 ]      [ ✏️ Edit ]    │
└──────────────────────────────────────────────┘
```

Elapsed time: render via a `useEffect` ticker keyed on `inFlightScenes.get(scene.id)?.startedAt`. Update once per second. (Don't ticker globally; only render time on the scene cards that are actually in-flight.)

When the scene completes (in-flight removed via polling), the card re-renders with the new clip count, new canonical thumbnail, button returns to "Generate this scene".

### Part 7 — Error handling

Quick-generate failures don't open Studio. They surface inline:

- Pre-stream errors (`!res.ok`, JSON error body): toast or scene-card-level error message.
- Init-stream errors (no init event arrives, network drops mid-stream): same.
- Server-side failures *after* init (the actual generation fails on the GPU): the queue tray shows the error; the scene card eventually times out of in-flight (see Part 8) and returns to its idle state.

```ts
const [quickGenerateError, setQuickGenerateError] = useState<{ sceneId: string; message: string } | null>(null);
```

On error, show a small error banner at the scene-card level:

```
┌──────────────────────────────────────────────┐
│ ⚠️ Couldn't start generation: <message>       │
│                                          [×]  │
└──────────────────────────────────────────────┘
```

The banner dismisses on the next successful generate of the same scene, or via the [×] button.

### Part 8 — In-flight timeout (defensive)

If a scene sits in `inFlightScenes` for longer than a defensive ceiling (say, 30 minutes — well beyond a typical Lightning generation), assume it failed silently and remove it from the set. The poll effect can include this:

```ts
const STALE_INFLIGHT_MS = 30 * 60 * 1000;
const stale = [];
for (const [sceneId, entry] of inFlightScenes.entries()) {
  if (now - entry.startedAt > STALE_INFLIGHT_MS) stale.push(sceneId);
}
if (stale.length > 0) {
  setInFlightScenes((prev) => {
    const next = new Map(prev);
    for (const id of stale) next.delete(id);
    return next;
  });
  setQuickGenerateError({ sceneId: stale[0], message: 'Generation appears to have timed out' });
}
```

Coordinate with the watchdog fix's queue-aware behavior: 30 minutes is comfortably longer than VIDEO_JOB_TIMEOUT_MS's default + queue time. Adjust the constant if your typical generation is meaningfully different.

### Part 9 — `/api/generate-video` route accepts `startingClipId`

The current route may not accept `startingClipId` directly — it likely accepts `startingFrameImage` (base64, post-extract). For quick-generate, ProjectDetail doesn't want to extract-last-frame client-side just to pass it through.

Two options:

**(a) Server-side extract.** Extend `/api/generate-video` to accept an optional `startingClipId` field. When present, the server fetches the clip's path, runs ffmpeg's last-frame extract internally, base64-encodes, and threads through to the workflow builder. The existing `startingFrameImage` field stays for the Studio path.

**(b) Client-side extract before submit.** ProjectDetail fetches `/api/extract-last-frame/[clipId]`, gets the base64, then POSTs to `/api/generate-video` with `startingFrameImage`. Same as Studio's existing pattern, just done from ProjectDetail.

**(b) is simpler** and reuses existing infrastructure. Use it. The quick-generate flow becomes:

1. If `suggestedStartingClipId`: GET `/api/extract-last-frame/[clipId]` → base64 frame.
2. POST `/api/generate-video` with `startingFrameImage: base64Frame`.

If the extract-last-frame fetch fails, fall back to t2v (no starting frame) and continue. Don't crash the whole flow because of a missing starting frame — log the failure, show a small note ("Starting frame couldn't load, generating without it"), and proceed.

### Part 10 — Documentation

The Phase 5c section in CLAUDE.md describes the toggle, the Lightning-defaults policy, the in-flight UI, and the polling-based completion detection.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "quickGenerate" src/types/index.ts` shows the field on `Storyboard`.
- `grep -n "quickGenerate\|inFlightScenes\|handleQuickGenerateScene" src/components/ProjectDetail.tsx` shows the toggle UI, in-flight tracking, and the alternate generate path.
- The toggle persists across page reloads (PUT writes to `Project.storyboardJson`).
- Tapping "Generate this scene" with toggle ON does NOT switch tabs.
- Tapping "Generate this scene" with toggle OFF still switches to Studio (5b behavior unchanged).
- The in-flight scene card shows a disabled "Generating... <elapsed>" pill in place of the Generate button.
- On completion, the scene card auto-refreshes with the new clip count and canonical thumbnail.
- Quick-generate uses Lightning regardless of project default for `defaultLightning`.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet, full sequence):

1. **Toggle persistence.** Open a project with a storyboard. Toggle Quick generate ON. Reload the page. Confirm toggle is still ON.
2. **Inline generation, scene 1.** With toggle ON, tap "Generate this scene" on Scene 1. Confirm: no tab switch; scene card shows "Generating... 0:01" pill; queue tray shows the new job; elapsed time advances. Wait for completion.
3. **Auto-refresh on completion.** After step 2 completes, confirm: scene card refreshes with "1 clip", canonical thumbnail visible, Generate button restored.
4. **Lightning enforcement.** Inspect the resulting clip's DB row (Prisma Studio or `psql`). Confirm `lightning: true` regardless of the project's `defaultLightning` setting.
5. **Chaining works.** Generate Scene 1 quick, then Scene 2 quick. Confirm Scene 2's clip uses Scene 1's canonical's last frame as i2v starting frame (workflow JSON inspection or visual continuity check).
6. **Toggle OFF preserves 5b behavior.** Toggle Quick generate OFF. Tap "Generate this scene" on Scene 3. Confirm Studio bounce — 5b behavior is intact.
7. **Concurrent quick-generates.** With toggle ON, tap Generate on Scene 4 immediately followed by Scene 5 (don't wait for Scene 4 to finish). Confirm both go in-flight; both pills show; both eventually complete; both clips persist with correct sceneIds.
8. **Re-tap during in-flight is no-op.** While Scene 4 is generating, tap its (disabled) pill. Confirm nothing happens — no duplicate job submitted.
9. **Edit during in-flight.** While Scene 4 is generating, tap its Edit button. Confirm: edit modal opens; user can change description/prompt; save succeeds. The in-flight job continues with the original prompt; the next Generate uses the edited values.
10. **Submission failure.** Stop ComfyUI (or otherwise force `/api/generate-video` to fail). Tap Quick Generate on a scene. Confirm: scene-card error banner appears with the message; in-flight set is cleared (scene returns to idle); user can dismiss banner.
11. **Stale in-flight cleanup.** Force a generation to silently fail (this is hard to reliably reproduce — could be tested by submitting a job and then killing the manager mid-flight). Confirm that after 30 minutes the stale entry clears from in-flight and the scene card returns to idle. (May skip if not easily reproducible.)
12. **Starting-frame extract failure.** Set Scene 2's canonical to a clip whose file has been deleted from disk but the DB row remains. Tap Quick Generate on Scene 3. Confirm: starting-frame extract fails gracefully; scene generates as t2v; small note in the error banner ("Starting frame couldn't load").
13. **Scene 1 (no predecessor).** Tap Quick Generate on Scene 1 of a fresh storyboard. Confirm: no starting frame, t2v generation, completes successfully.
14. **Disk-avoidance check.** After several quick-generates: `ssh <gpu-vm> ls /models/ComfyUI/output/` shows no orphan files.
15. **Studio path regression.** With toggle OFF, do a full Studio-bounce generate (5b behavior). Confirm everything still works as before.

---

## Out of scope

- A "Quick generate all scenes" button. Could be a future feature; this batch ships the per-scene quick path.
- Per-scene Lightning override (e.g., "this scene should use full quality"). Lightning is the trade-off — if you want fine control, toggle OFF.
- Per-scene parameter customization in quick-generate. Quick path uses project defaults + Lightning; nothing to customize without bouncing to Studio.
- Surface generation progress (current step, % complete) on the scene card. The queue tray already provides this; the scene card just shows "Generating... <elapsed>".
- Sound/notification when a quick-generate completes. The existing notification system fires for any completed job; scene-card auto-refresh is the visual feedback.
- Multiple storyboards per project (Charlie's question — see follow-up batch).
- A "regenerate this scene's clip" button (replace canonical with new). User generates again; the picker handles canonical selection.
- Tracking which generations were quick vs. studio-driven on the clip's DB row. Both produce the same `Generation` shape; the path doesn't matter for the data.
- Confirmation before generating ("are you sure?"). One tap submits; that's the point.

---

## Documentation

In CLAUDE.md, add a Phase 5c section under the existing Phase 5b:

> ## Phase 5c — Storyboard quick-generate
>
> Storyboards gain a `quickGenerate` toggle (stored on the Storyboard object inside `Project.storyboardJson`). When ON, the per-scene Generate button skips Studio and submits directly to `/api/generate-video` with Lightning forced ON, project defaults, the scene's prompt + duration, and the chained suggested starting frame. The user stays in ProjectDetail; the queue tray (existing) shows progress; ProjectDetail polls `/api/projects/[id]` while any scenes are in-flight and refreshes when clips complete.
>
> The toggle defaults OFF — preserves 5b's Studio-bounce behavior for users who want full parameter control. Toggle is per-storyboard, not per-project — each project's storyboard owns its own preference.
>
> **In-flight UI:** the scene card replaces its Generate button with a disabled "Generating... <elapsed>" pill while a job for that scene's id is active. On completion, the card auto-refreshes via the polling effect.
>
> **Lightning enforcement:** quick-generate forces `lightning: true` regardless of `Project.defaultLightning`. If the user wants non-Lightning generation, they toggle the storyboard's quick-generate OFF and use Studio.

In the source layout, note the new responsibilities on `ProjectDetail.tsx`:

> Hosts quick-generate toggle, alternate inline submit path, in-flight scene tracking, and the polling-based completion-detection effect.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
