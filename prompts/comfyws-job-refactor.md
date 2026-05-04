# Batch — Job-type refactor in `comfyws.ts` (consolidate per-type switches)

`ComfyWSManager` maintains a discriminated union `Job = ImageJob | VideoJob | StitchJob`. Each job type has a base shape plus type-specific data (image has `params` and `imageBuffers`; video has `videoParams`; stitch has `generationId`, `outputPath`, optional ffmpeg child process handle). Cross-type operations (`addToRecentlyCompleted`, `getActiveJobs`, `expireJob`, abort handling) reach into type-specific fields via inline `job.mediaType === '...'` ternaries scattered across the file. Each new branch makes the manager harder to extend; today, adding a hypothetical fourth generation type means updating ~6 call sites in addition to the new register / finalize paths.

Refactor: extract the type-specific reads into private helper methods. Reduce the cross-type branch surface from N call sites to a small number of named methods. **No behavior change** — purely a maintainability refactor.

This batch should be the last on the queue. By the time it runs, the codebase is post-H1 (image and video both use one-call SSE; register signatures are aligned), post-H2 (complete-event shapes are unified), post-H3 (`Generation` schema has `lightning` + `videoLorasJson`). Cleaner foundation; smaller diff than if attempted earlier.

Re-read CLAUDE.md before starting. Disk-avoidance contract is unaffected — this batch doesn't touch the WS binary-frame capture, finalize write paths, or workflow code.

---

## What changes

### Step 1: extract type-discriminated helpers as private methods

Find every inline `job.mediaType === '...' ? X : Y` ternary and `switch (job.mediaType)` in `comfyws.ts`. Replace with calls to private helpers. The helpers are the only place mediaType-specific reads happen.

Concrete helpers (responsibilities; final names per the agent's preference):

```ts
private getJobGenerationId(job: Job): string {
  switch (job.mediaType) {
    case 'image': return ''; // image creates row in finalize, no ID before then
    case 'video': return job.videoParams.generationId;
    case 'stitch': return job.generationId;
  }
}

private getJobInitialStatus(job: Job): 'queued' | 'running' {
  // Stitch starts ffmpeg immediately (no ComfyUI queue);
  // image/video are 'running' once runningSince is set by an executing event, else 'queued'.
  if (job.mediaType === 'stitch') return 'running';
  return job.runningSince !== null ? 'running' : 'queued';
}
```

Add additional helpers as the refactor surfaces them — wherever a switch reads type-specific fields and lives at a call site, extract. Likely candidates:

- A helper for cleanup behavior (image / video need different post-finalize cleanup; stitch's ffmpeg has its own SIGTERM path).
- A helper for "does this job have a pre-existing DB row" (video and stitch yes; image no — relevant for abort handling).

Replace at every call site:

```ts
// Before:
const generationId =
  job.mediaType === 'video' ? job.videoParams.generationId :
  job.mediaType === 'stitch' ? job.generationId : '';

// After:
const generationId = this.getJobGenerationId(job);
```

The TypeScript narrowing inside each helper's `switch` statement works natively on discriminated unions — no casts needed. If a call site previously did its own type narrowing for a follow-up access (e.g. `if (job.mediaType === 'video') { ... job.videoParams.foo ... }`), keep that narrowing intact; only consolidate the read-access switches.

### Step 2: extract `addJob` private helper for register* boilerplate

Each `registerJob` / `registerVideoJob` / `registerStitchJob` does roughly the same bookkeeping after constructing the type-specific shape: set the watchdog timeout, insert into the jobs map. Extract:

```ts
private addJob(job: Omit<Job, 'timeoutId'>, timeoutMs: number): void {
  const timeoutId = setTimeout(() => this.expireJob(job.promptId), timeoutMs);
  this.jobs.set(job.promptId, { ...job, timeoutId } as Job);
}
```

The `Omit<Job, 'timeoutId'>` is awkward across a discriminated union. Two paths; agent picks based on which TypeScript narrows cleanest:

- **(a)** Use `Omit<Job, 'timeoutId'>` directly. Works if TS handles the omit-then-spread pattern well across the union.
- **(b)** Have each register* method construct the full job (including a placeholder `timeoutId`) and pass to `addJob(job, timeoutMs)`, which sets the real `timeoutId`. Slightly redundant but no `Omit` gymnastics.

Either is fine. Document which was chosen in the PR description.

Public methods become focused on type-specific construction:

```ts
registerJob(
  promptId: string,
  params: GenerationParams,
  resolvedSeed: number,
  assembledPos: string,
  assembledNeg: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  const promptSummary = params.positivePrompt.slice(0, 60).trim() || 'Image generation';
  this.addJob({
    promptId,
    mediaType: 'image',
    params,
    resolvedSeed,
    assembledPos,
    assembledNeg,
    controller,
    imageBuffers: [],
    activeNode: null,
    finalized: false,
    promptSummary,
    startedAt: Date.now(),
    runningSince: null,
    progress: null,
  }, IMAGE_JOB_TIMEOUT_MS);
}
```

Same restructuring for `registerVideoJob` and `registerStitchJob`. Each shrinks by the timeout-setup boilerplate.

The public surface (method names, parameter lists, return types) is unchanged — only the internal delegation pattern shifts.

### Step 3: cross-check finalize paths

`finalizeImageJob`, `finalizeVideoJob`, `finalizeStitchSuccess`, `finalizeStitchError` are kept separate. Their internals are genuinely different — image writes captured WS buffers to `IMAGE_OUTPUT_DIR`; video updates the existing row with the file metadata; stitch updates the row with ffmpeg output dimensions, then signals completion. Don't try to unify them.

But: any cross-type field reads (e.g. emitting recently-completed entries via `addToRecentlyCompleted`) that the finalize paths share should use the new helpers, not inline switches.

`addToRecentlyCompleted` is the most obvious case. Replace the inline `defaultId` switch with `this.getJobGenerationId(job)`.

### Step 4: ensure `Job` discriminated union is properly typed

If `Job = ImageJob | VideoJob | StitchJob` isn't already a named type-alias export, define it. Makes helper signatures readable and future cross-type code easier to write.

If individual job types (`ImageJob`, `VideoJob`, `StitchJob`) are exported from `comfyws.ts` for use in other files (e.g. queue context), keep the exports unchanged. The refactor doesn't change the public type surface.

### Step 5: regression check on branch parity

Before this batch, count the inline switches:

```bash
grep -nc "job\.mediaType ===" src/lib/comfyws.ts
```

Note the count. After the refactor, the same grep should return a small number (≤ 3 — only inside the helper methods themselves). If higher, find the leftover call sites and refactor them through helpers.

The goal isn't zero — it's "all the switches live in helpers, none at general call sites."

---

## Critical: no behavior change, disk-avoidance unchanged

User-visible behavior must be identical pre- and post-batch:

- Image generation flow unchanged.
- Video generation flow unchanged.
- Stitch flow unchanged.
- Queue tray contents unchanged across submit, run, complete, abort, refresh.
- Active-jobs poll endpoint returns the same shape.
- Recently-completed cache TTL unchanged.

Disk-avoidance unchanged:

- `onBinary` capture path: not touched.
- `finalizeImageJob` write path: not touched (only its callers, which the refactor doesn't restructure).
- ETN_LoadImageBase64 / ETN_LoadMaskBase64 / SaveImageWebsocket node references in the workflow: not touched.
- Post-finalize SSH cleanup glob (if applicable): not touched.

Run the full smoke test (image, video, stitch generation; refresh recovery; abort; mixed batch in queue) before marking the batch done.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `comfyws.ts` LOC count drops (rough indicator of consolidation; not a hard target — note the delta in the PR description).
- `grep -c "job\.mediaType ===" src/lib/comfyws.ts` returns ≤ 3 (only inside the new helper methods).
- The public surface of `ComfyWSManager` (`registerJob`, `registerVideoJob`, `registerStitchJob`, `getActiveJobs`, `removeSubscriber`, `abortJob`, `getClientId`, finalize methods, etc.) has the same exported method names and call signatures as before.
- `Job` discriminated union is defined and used as the parameter type for the cross-type helpers.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet, full regression):

1. Generate an image batch=1. Confirm: progress, completion, gallery refresh, DB row populated.
2. Generate an image batch=4. Confirm: 4 in queue, all complete, 4 thumbnails in result grid.
3. Generate a video batch=1. Confirm same.
4. Generate a video batch=4. Confirm: 4 in queue, all complete, 4 thumbnails in result grid (per H4).
5. Stitch a project. Confirm: job appears in tray, ffmpeg runs, completion, gallery refresh.
6. Refresh page mid-image-generation. Queue tray recovery picks up the running job.
7. Refresh page mid-video-generation. Same.
8. Refresh page mid-stitch. Same.
9. Abort each type of running job from the queue tray. Confirm: error message, no orphan files (`ssh a100 ls /models/ComfyUI/output/` for image; mint-pc `IMAGE_OUTPUT_DIR` / `VIDEO_OUTPUT_DIR` for in-flight video / `STITCH_OUTPUT_DIR` for in-flight stitch).
10. Submit one of each type (image + video + stitch) at once or in close succession. Confirm: queue tray shows all three correctly tagged, all complete in their own paths, no cross-contamination of state.
11. **Disk-avoidance regression check.** After a successful image generation: `ssh a100 ls /models/ComfyUI/output/*.png 2>&1` returns "no such file or directory."
12. Inspect DB rows for completed generations of each type: all fields populated as expected (`lorasJson`, `videoLorasJson`, `lightning`, `mediaType`, `isStitched`, `projectId`, `position`).

---

## Out of scope

- Changing public API surface. Method names, call signatures, exported types stay.
- Changing the discriminated union members. `ImageJob`, `VideoJob`, `StitchJob` keep their existing field shapes; this batch only consolidates how the manager interacts with them.
- Adding a new generation type. Future-proofing is the goal; not the implementation.
- Subclassing or class hierarchies for jobs. Plain TypeScript discriminated unions + private helper methods is the right level of abstraction here — heavier patterns are over-engineered for three concrete types.
- Changing finalize paths' internals. They remain separate methods.
- Touching WS handling, workflow building, or finalize file-writes.
- Changing timeouts, watchdog cadence, or recently-completed TTL.
- Reworking the abort flow's API surface. Internal calls can route through helpers; the public `abortJob(promptId)` signature is unchanged.
- Reworking `getActiveJobs` return shape. Same `ActiveJobInfo` shape, same fields.

---

## Documentation

In CLAUDE.md, find the `ComfyWSManager` description in the source layout. Update to note the consolidated helper pattern:

> `ComfyWSManager` (in `src/lib/comfyws.ts`) maintains a discriminated union `Job = ImageJob | VideoJob | StitchJob`. Cross-type operations route through private helpers (`getJobGenerationId(job)`, `getJobInitialStatus(job)`, `addJob(job, timeoutMs)`) rather than inline `mediaType` switches at call sites. The public API surface — `registerJob`, `registerVideoJob`, `registerStitchJob`, `getActiveJobs`, `removeSubscriber`, `abortJob`, the finalize methods — is unchanged from prior batches.

If CLAUDE.md describes any specific switch behavior in the manager (e.g. "the manager checks mediaType to decide..."), update or remove that description.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
