# Batch — Queue tray "Queued" status

When a second job is added while one is already running, the new job's queue-tray row reads "Starting…" with an elapsed timer counting up. Misleading: the job isn't starting, it's queued behind another. ComfyUI processes one prompt at a time; the second prompt sits in ComfyUI's queue until the first finishes.

This batch adds a `'queued'` status distinct from `'running'`, drives it from ComfyUI's queue inspection, and reflects it correctly in the UI.

Re-read CLAUDE.md before starting. Phase 1.2b (queue UX) must be merged before this batch runs.

---

## What's happening today

Phase 1.2b's job state union is `'running' | 'completing' | 'done' | 'error'`. When the user submits a second job, the route POSTs to ComfyUI's `/prompt`, gets back a prompt ID, registers a job with status `'running'`, and the SSE stream opens. ComfyUI hasn't actually started executing — it's queued internally — but no progress events arrive until ComfyUI reaches the prompt in its own queue. The tray shows "Starting…" / `0/N` and the elapsed timer ticks up against time the job hasn't actually been running.

For Phase 1.2a's locked-form UX this was less visible (you couldn't queue a second job). Phase 1.2b unlocked concurrency and exposed the issue.

---

## What to build

### 1. Add `'queued'` to the status union

In the active-jobs state container (Phase 1.2b's source) and the ActiveJob type:

```ts
type ActiveJob = {
  // ... existing fields ...
  status: 'queued' | 'running' | 'completing' | 'done' | 'error';
};
```

A job's initial status on registration is `'queued'`, not `'running'`. It transitions to `'running'` when the first progress event arrives (the WS message that says ComfyUI is sampling step 1 of N).

### 2. Detection: when does a job transition queued → running?

The cleanest signal is **the first SSE progress event**. When the queue UX state container receives a progress message for a `'queued'` job, transition it to `'running'`.

This requires the SSE handler in `comfyws.ts` (or wherever the progress events are emitted) to fire `updateProgress` even for the "step 0 of N" / "execution started" event. If it currently only fires on actual sampling progress, ensure the first transition message also fires through the same dispatch path.

ComfyUI's `executing` WS message (sent when a node starts execution) is the right discriminator — when ComfyUI sends `executing` for the first node of our prompt, the job has reached the front of ComfyUI's queue. The progress message that follows is the first sampling step.

If the existing comfyws routing already handles the `executing` message: have it dispatch a `transitionToRunning(promptId)` event that the queue UX state consumes. If not: add the handler.

Either way, the dispatch is one-directional — the UI doesn't need to ping ComfyUI for queue status; the WS messages already tell us when execution starts.

### 3. Display

Queue-tray row rendering:

- `status === 'queued'`:
  - Status label: "Queued"
  - Progress bar: hidden, OR shown as 0% with a different color
  - Elapsed timer: hidden, OR shown but labeled "Waiting" instead of elapsed time
  - ETA: shown as `Calculating…` (the queue-tray state can't know the ETA before the previous job finishes, so don't try)
- `status === 'running'`:
  - Existing display (progress bar, elapsed since transition, ETA per the watchdog/ETA batch).
  - Important: when transitioning from queued → running, the elapsed timer **starts from now**, not from job submission. The "elapsed" metric is "elapsed since execution started," not "elapsed since I clicked Generate." Rationale: a job that sat queued for 10 minutes shouldn't show "Elapsed: 10:23" at the moment ComfyUI started executing it — that's misleading about how long the actual generation took.
  - This means the `startedAt` timestamp on the job record needs to be re-set when the queued → running transition fires, or a separate `runningSince` timestamp added. The latter is cleaner — keep `startedAt` as job-creation time (for the queued-duration tracking, see below), add `runningSince` as execution-started time, and the elapsed display uses `runningSince`.

The "Aborted" / "Done" / "Error" states are unchanged.

### 4. Queue position display (optional polish)

If multiple jobs are queued behind a running one, show queue position:

```
Queued (2 of 3)
```

Where "2 of 3" is the position in the local app's queue (not ComfyUI's internal queue, which we don't have visibility into for our specific prompts vs. external prompts). Compute by sorting queued jobs by `startedAt` and finding the current job's index.

If the agent finds this display uses too much horizontal space in the tray row, drop the `(N of M)` and just show "Queued."

### 5. Abort behavior on queued jobs

A queued job can be aborted. The abort path needs slightly different handling:

- The job exists in our state but ComfyUI hasn't started it yet.
- ComfyUI's `/interrupt` only stops the *currently running* prompt. It doesn't help with queued ones.
- ComfyUI exposes `POST /queue` with a `delete: ["<promptId>"]` body to remove a queued prompt:

```ts
fetch(`${COMFYUI_URL}/queue`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ delete: [promptId] }),
}).catch(...);
```

In `abortJob`, branch on status:

```ts
if (job.status === 'queued') {
  // Remove from ComfyUI's queue (not interrupt, which would kill whatever's actually running)
  fetch(`${COMFYUI_URL}/queue`, { method: 'POST', body: JSON.stringify({ delete: [promptId] }) }).catch(...);
} else {
  // Existing interrupt path
  fetch(`${COMFYUI_URL}/interrupt`, { method: 'POST' }).catch(...);
}
```

Then run the rest of the existing abort cleanup (mark `recentlyCompleted` with `error: Aborted`, SSH cleanup if applicable, remove from active map).

Verify the ComfyUI `POST /queue` shape against the live VM before relying on it. If the API differs (some builds use `cancel` vs `delete`, some require different keys), document what the agent observed in the PR description.

### 6. The "Waiting" state and ETA implications

For the watchdog/ETA batch's ETA logic: queued jobs have no ETA until they transition to running. The queue tray row shows `Calculating…` for queued. Once they transition, the existing live-calibration kicks in.

The 60-minute sanity timeout (per the watchdog redesign batch) **starts at queued, not at running**. A job that sits queued for 65 minutes (because the user queued 5 long videos behind one stalled one) should still trip the watchdog. Document this; the current spec is ambiguous.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `'queued'` is in the ActiveJob status union.
- New jobs register with status `'queued'`.
- Status transitions to `'running'` on the first execution/progress WS message.
- Queue-tray rows for `'queued'` jobs show "Queued" label, no elapsed-since-submission counter, no progress bar.
- Elapsed timer in `'running'` state starts from execution-start, not from submission.
- Abort on a queued job calls `POST /queue` with `delete`, not `/interrupt`.
- Abort on a running job calls `/interrupt` (existing behavior).
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. Submit a video generation. While it's running, submit a second. Confirm the second tray row shows "Queued" with no elapsed counter, no progress.
2. Wait for the first to complete. Confirm the second transitions to "Running" and the elapsed timer starts counting from that moment.
3. Submit two more while one is running. Confirm both queue with appropriate status labels.
4. Abort the *queued* one (not the running one). Confirm: the queued job clears with status "Aborted" without affecting the running job. Verify via `nvidia-smi` that GPU stayed pegged the whole time.
5. Abort the *running* one. Confirm: GPU drops, the job clears, and one of the previously queued jobs starts executing within seconds.
6. Refresh the page mid-queue (multiple jobs in flight). Confirm the queue tray repopulates with the correct status per job (per the existing refresh survivability work).

---

## Out of scope

- Showing ComfyUI's actual queue position (vs. our local app's queue position). ComfyUI's queue can contain prompts from external clients; we don't have visibility there.
- A "drag to reorder queued jobs" UX. Out of scope.
- "Pause queue" / "resume queue" affordance (process completed jobs but don't start new ones). Out of scope.
- Notification chime on job transitioning queued → running. Only completion/error fires the chime.
- Per-checkpoint queue prioritization (e.g. "process all SDXL jobs before any video jobs"). Out of scope.
- Multi-instance ComfyUI scaling. Single instance.

---

## Documentation

In CLAUDE.md's queue UX section, add:

> Jobs are registered with status `'queued'` and transition to `'running'` when the first WS execution event arrives from ComfyUI for that prompt. The tray distinguishes queued (no elapsed counter, no progress) from running (live progress, ETA, elapsed since execution start). Aborting a queued job calls ComfyUI's `POST /queue` with `delete` to remove it from ComfyUI's internal queue; aborting a running job calls `/interrupt` to kill GPU work mid-execution.

Find the documented job state union in CLAUDE.md; update it to include `'queued'`.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
