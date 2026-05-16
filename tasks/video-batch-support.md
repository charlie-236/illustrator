# Batch — Video generation batch support

Video generation today produces exactly one clip per Generate click. Image generation has supported `batchSize` from the start — a single submit produces N independent generations with different seeds, each queued as a separate job, each landing in the gallery as it completes.

This batch brings video to parity. Adds a batch-size control to the video form, wires N parallel video jobs through the route + queue, ships nothing else new (the queue tray, gallery rendering, and project membership all already handle N concurrent jobs from prior work).

Re-read CLAUDE.md before starting. Use `project_knowledge_search` to confirm current image-side batch implementation before designing the video version — the goal is structural symmetry.

---

## What to build

### 1. Video form — batch slider

The video form's settings popout (per PR #27) currently has: resolution presets, width/height, frames, steps, cfg, seed. Add a **Batch** slider:

- Range: 1–4 (cap matches image mode).
- Default: 1.
- Step: 1 (whole numbers only).
- Display label: "Batch: N" with no units.

Place it near the seed control — same logical neighborhood (controls that vary per-job rather than per-batch).

The existing image-mode batch slider lives at the same place in the image-mode popout. Match the visual pattern exactly. Use `project_knowledge_search` to find the image-mode batch slider and mirror its component, sizing, and styling.

### 2. Video form state + submit

Form state gains `batchSize: number` for video mode (it already has it for image mode). On submit:

```ts
async function handleGenerateVideo() {
  if (submitting) return;
  setSubmitting(true);

  // ... existing single-job submission code ...

  // After the existing single-job logic, repeat for batchSize - 1 more jobs.
  // Each gets its own seed (random per take when seed is -1, or seed+i when explicit).
}
```

Submit logic for `batchSize > 1`:

- Each take gets its own SSE stream (just like image-mode batch).
- The seed is **incremented per take** when a specific seed was provided, or **fully randomized per take** when seed is -1. Match what image-mode batch does — `project_knowledge_search` for image-mode batch seed handling.
- Each take adds its own job to the queue tray.
- All takes share the same project context (if any), prompt, starting frame (if i2v), Lightning state, LoRA stack, dimensions, frames, steps, cfg.

If a starting frame is required (i2v with project context), it's resolved **once before the loop** — don't re-extract or re-encode per take. The base64 string is the same across all N takes.

### 3. Route — accept batchSize, validate cap

`/api/generate-video` body extends with `batchSize?: number`. Default 1. Validate:

- Integer between 1 and 4 inclusive.
- Anything else → 400 with a clear error.

The route POSTs N workflows to ComfyUI sequentially (same pattern image-mode uses), each with its own prompt ID, each registered as a separate job in the comfyws manager.

If the route currently expects to handle one job per request, the cleanest refactor is: extract the per-job logic into a helper, call it N times in a loop. The SSE response stream emits one `init` event per job (so the client can register N tray entries), then progress events tagged by promptId, then a `complete` per job, then a final closing.

Look at how image-mode handles the SSE multiplexing for batch — copy that pattern. If image-mode opens N separate streams instead of multiplexing, video can do the same. Either pattern is fine; the goal is parity.

### 4. Position handling for project clips

When `batchSize > 1` and `projectId` is set, all N takes get sequential `position` values: `max(position) + 1`, `max(position) + 2`, ..., `max(position) + N`. Compute the base once before the loop, increment per take.

This means a 4-take batch lands as positions 5, 6, 7, 8 in a project that previously had 4 clips. The user reorders manually if they want a different arrangement.

### 5. Filename uniqueness

Each video file's local filename includes a timestamp (`<slug>_<timestamp>.webm`). For 4 takes submitted within the same millisecond the timestamps would collide. Mirror image-mode's collision avoidance — likely an index suffix when the batch size > 1: `<slug>_<timestamp>_1.webm`, `_2.webm`, etc.

`project_knowledge_search` for the image-mode `isBatch` filename pattern. Match it.

### 6. VM-side filename obfuscation still applies

Per the existing video filename obfuscation (PR #17), each generation gets a random 16-char hex prefix on the VM-side `SaveWEBM` output. With batchSize > 1, **each take gets its own random prefix** — they're independent generations.

The `filenamePrefix` on each `VideoJobParams` is generated independently per take. The cleanup glob in `comfyws.ts` still works the same way (one prefix per job, one cleanup call per job).

### 7. Watchdog + ETA

Each take has its own watchdog (the existing `VIDEO_JOB_TIMEOUT_MS`). Each take's ETA is computed independently in the queue tray — they may report different ETAs because ComfyUI processes them sequentially (queue position matters, the takes 2-4 are "Queued" while take 1 is "Running").

This is correct behavior. Don't try to roll the batch's takes into a single tray entry — they're independent jobs by design.

### 8. Studio video form — submitting flag

The submit button's debounce flag (`submitting`, per the generate-button-debounce batch) needs a small adjustment. Currently it resets via fixed-duration `setTimeout(800ms)`. With batchSize > 1, the per-take submission loop may take longer than 800ms to enqueue all N takes (each POST to ComfyUI takes time).

Two paths:

- **(a) Keep the 800ms debounce.** Even if takes are still being enqueued at 800ms, the user double-tapping at that point won't cause real harm — they'd just queue another batch on top. Acceptable.
- **(b) Hold `submitting` for the full duration of the per-take loop.** Set true at start, false in a finally after all N POSTs complete.

I lean (a) for symmetry with image-mode. The debounce's job is "absorb a finger-drift double-tap"; it's not a complete idempotency mechanism. If the user's intent is genuinely to submit two batches in 1 second, that's their call.

If image-mode batch uses a different pattern (held lock through the whole batch loop), match it. Match conventions over consistency-by-prescription.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- The video form's settings popout has a Batch slider, range 1–4, default 1.
- Submitting with batchSize=4 produces 4 jobs in the queue tray within ~2 seconds of the click.
- Each of the 4 jobs gets a unique seed (random per take if seed=-1, or sequential if explicit).
- Each of the 4 jobs gets its own random VM filename prefix.
- All 4 takes run in sequence (ComfyUI queue limitation), but all 4 land in the gallery as they complete.
- When project context is active, all 4 takes inherit the project association and get sequential `position` values.
- The route validates `batchSize` is in [1, 4] and returns 400 for anything else.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. Open Studio video mode (no project). Set batch to 4. Click Generate Video. Confirm 4 jobs appear in the queue tray. Confirm 1 starts running while 3 queue. Wait for all 4 to complete. Confirm 4 .webm files in the gallery, all with the same prompt but visually different.
2. Same flow but with project context active. Confirm all 4 takes appear in the project's linear strip in 4 sequential positions.
3. Set batch to 4 with Lightning on. Confirm wall-clock is ~12 minutes (4 × 3min) rather than ~56 minutes.
4. Set batch to 4 with i2v + a starting frame. Confirm the starting frame is loaded once on submit, not 4 times. All 4 takes start from the same frame but differ in motion.
5. Try `batchSize: 5` via curl. Confirm 400 error.
6. Set batch to 1. Confirm exactly one job is created (no regression on the single-take path).

---

## Out of scope

- Increasing the batch cap above 4. The image-mode cap is 4 for tablet UX reasons (one row of thumbnails at sensible size); video keeps the same cap for symmetry.
- Showing a "batch progress" indicator in Studio (e.g. "2 of 4 complete"). The queue tray already shows per-job state; that's sufficient feedback.
- Rolling all N takes into a single queue tray entry. Each take is its own job by design.
- A "regenerate batch" button on the form. Standard remix already serves this purpose (with the upcoming remix batch-default change).
- Special UI for choosing a "favorite" take. Standard favorite + delete affordances are sufficient.
- Schema changes. The `Generation` schema already has everything needed; takes are independent rows.
- Allowing different params per take (parameter sweeps). That's a separate feature, not multi-take.

---

## Documentation

In CLAUDE.md, find the Studio video mode section. Update the controls list to include Batch (1–4, default 1). Update the queue UX section to mention that video batch submissions produce N parallel jobs in the queue, identical to image-mode batch behavior.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
