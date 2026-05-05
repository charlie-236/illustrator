# Quick fix — Watchdog timer should start when execution begins, not when job is registered

The job watchdog (`IMAGE_JOB_TIMEOUT_MS`, `VIDEO_JOB_TIMEOUT_MS`, `STITCH_JOB_TIMEOUT_MS`) currently starts ticking the moment `registerJob` / `registerVideoJob` / `registerStitchJob` is called — i.e., right after the prompt is queued to ComfyUI. If ComfyUI is busy with another generation, the new job sits in its queue and the watchdog burns budget while no GPU work is happening. A 15-minute video that waits 6 minutes in queue gets killed mid-execution.

Two changes:

1. **Reset the watchdog when ComfyUI actually starts executing the job.** The existing register-time timer stays as a safety net (catches the rare case of a prompt that's accepted but never executes), but the *real* budget starts ticking on `execution_start`.

2. **Sentinel value `0` disables the watchdog entirely.** Single-user app; the operator may legitimately want no force-abort behavior at all. Setting `VIDEO_JOB_TIMEOUT_MS=0` (or 0 for any of the three) skips both the register-time and execution-start timers. The watchdog becomes opt-out.

This is fix-forward on top of the M1 refactor — `addJob(job, timeoutMs)` is already the consolidation point.

Re-read CLAUDE.md before starting. Disk-avoidance is unaffected.

---

## Required changes

### Part 1 — Store `timeoutMs` on the job

`src/lib/comfyws.ts` — extend the base `Job` shape (whatever the discriminated union's common fields look like) to include:

```ts
timeoutMs: number;   // 0 = no watchdog. Stored so execution_start can reset.
```

Each `register*` method passes its respective `IMAGE_JOB_TIMEOUT_MS` / `VIDEO_JOB_TIMEOUT_MS` / `STITCH_JOB_TIMEOUT_MS` value through `addJob`. `addJob` writes it onto the job before storing in the jobs map.

### Part 2 — `addJob` respects sentinel `0`

Currently `addJob` looks roughly like:

```ts
private addJob(job: Omit<Job, 'timeoutId'>, timeoutMs: number): void {
  const timeoutId = setTimeout(() => this.expireJob(job.promptId), timeoutMs);
  this.jobs.set(job.promptId, { ...job, timeoutId, timeoutMs } as Job);
}
```

Update to skip the timer when `timeoutMs <= 0`:

```ts
private addJob(job: Omit<Job, 'timeoutId' | 'timeoutMs'>, timeoutMs: number): void {
  const timeoutId = timeoutMs > 0
    ? setTimeout(() => this.expireJob(job.promptId), timeoutMs)
    : null;
  this.jobs.set(job.promptId, { ...job, timeoutId, timeoutMs } as Job);
}
```

`Job.timeoutId` becomes `NodeJS.Timeout | null`. Wherever the codebase reads or clears `timeoutId`, handle the null case (`if (job.timeoutId) clearTimeout(job.timeoutId);`).

### Part 3 — Reset on `execution_start`

Find the WS message handler in `comfyws.ts` — the function that dispatches incoming ComfyUI events by type (`execution_start`, `executing`, `progress`, `executed`, `execution_success`, `execution_error`). Look for whatever already handles `execution_start` (it likely sets `job.runningSince = Date.now()` or similar).

After the existing logic for `execution_start`:

```ts
// Reset watchdog: queue time doesn't count against the budget. Budget starts now.
if (job.timeoutMs > 0) {
  if (job.timeoutId) clearTimeout(job.timeoutId);
  job.timeoutId = setTimeout(() => this.expireJob(job.promptId), job.timeoutMs);
}
```

If a job's `timeoutMs` is 0 (sentinel), this block is a no-op — the original null `timeoutId` stays null. No watchdog ever fires.

If no `execution_start` handler exists yet — i.e., the codebase relies only on `executing` (per-node) or `progress` events — pick whichever event reliably fires on first GPU activity for the prompt. `execution_start` is the canonical "ComfyUI started this prompt" signal; prefer it over per-node events.

### Part 4 — `.env.example` documentation

Update the watchdog section's three blocks. Each gets a sentence noting the sentinel and the queue-time semantics:

```
# Image generation watchdog. Default 600000 (10 minutes).
# Timer resets when ComfyUI starts executing the job — queue wait time
# doesn't count against the budget. Set to 0 to disable the watchdog
# entirely (single-user installs may prefer no force-abort).
IMAGE_JOB_TIMEOUT_MS=600000
```

Repeat the comment for video and stitch with their respective default values.

### Part 5 — No client-side changes

The queue tray, SSE consumers, and Studio loops are unaffected. The watchdog is server-side only; clients see no behavior change in normal operation. They only see a difference if the watchdog *was* firing before — those jobs no longer get killed mid-execution.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "timeoutMs" src/lib/comfyws.ts` shows the new field on the job shape and the reset logic on `execution_start`.
- `grep -n "timeoutMs > 0" src/lib/comfyws.ts` shows the sentinel guard in both `addJob` and the `execution_start` handler.
- `Job.timeoutId` is typed as `NodeJS.Timeout | null` (or equivalent) and all reads handle null.
- The `execution_start` handler clears any existing `timeoutId` before setting a new one.
- `.env.example` documents the sentinel and queue-time semantics for all three job types.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. **Queue-wait scenario.** Start a long video generation. While it's running, queue a second video. Watch the second job sit in the queue (no progress events). Wait 16 minutes from the moment the second job's POST returns. Confirm it does NOT get killed by the watchdog. When the first job finishes and ComfyUI starts executing the second, the timer begins fresh.
2. **Execution timeout still works.** Set `VIDEO_JOB_TIMEOUT_MS=10000` (10 seconds — artificially short). Submit a video generation. When ComfyUI starts executing (you'll see the first progress events), wait 11 seconds. Confirm the job is force-aborted with a watchdog timeout error. Reset the env var.
3. **Sentinel disables watchdog.** Set `VIDEO_JOB_TIMEOUT_MS=0`. Submit a video generation. Confirm no timeout fires regardless of how long it runs. Reset the env var.
4. **Image regression check.** Generate an image. Confirm normal completion. Watchdog defaults still apply.
5. **Stitch regression check.** Stitch a project. Confirm normal completion.
6. **Disk-avoidance check.** After several jobs have completed: `ssh <gpu-vm> ls /models/ComfyUI/output/` should show no orphan files.

---

## Out of scope

- Renaming the env vars or changing their default values.
- Adding a per-job override (different timeouts for different generations of the same type). Single env var per type is fine.
- A "remaining time" surface in the queue tray. Not needed.
- Reset logic on other ComfyUI events (`executing` per-node, `progress`). Only `execution_start` resets the budget.
- Watchdog logic for the LLM call timeouts (`POLISH_TIMEOUT_MS`, `STORYBOARD_TIMEOUT_MS`). Those are HTTP-call timeouts, not job watchdogs — separate concern, leave them alone.
- Surfacing "this job is currently in queue, not yet executing" as a separate state in the UI. Could be a future improvement; not part of this batch.
- Backfilling existing in-flight jobs at deploy time. Restart the app between PR merge and the next generation; in-flight jobs are short-lived enough that this is fine.

---

## Documentation

In CLAUDE.md, find the `IMAGE_JOB_TIMEOUT_MS` / `VIDEO_JOB_TIMEOUT_MS` / `STITCH_JOB_TIMEOUT_MS` documentation. Update to reflect:

> Job watchdog timeouts. Timer resets when ComfyUI starts executing the job — queue-wait time does not count against the budget. Set any to `0` to disable that type's watchdog entirely.

In the `ComfyWSManager` description, add a sentence:

> Watchdog timers are queue-aware: the `execution_start` event resets the timer so jobs sitting in ComfyUI's queue don't burn their budget. The sentinel value 0 disables the watchdog for that job type.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
