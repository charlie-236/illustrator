# Quick fix — `comfyws.ts` cleanup hygiene (post-refactor)

Two small state-machine gaps in `src/lib/comfyws.ts`. Both surfaced by careful QA review of cleanup paths. The job-refactor batch introduced helpers (`cleanupJob`, `performAbortCleanup`, etc.) and partially fixed one of these gaps — but not all of them. This batch closes the remaining holes.

1. **`flushJobsOnReconnect` skips cleanup for video jobs.** When the WS drops mid-generation and reconnects, the manager polls ComfyUI's history endpoint. If the prompt finished or failed during the disconnect window, both terminal branches push an SSE error, clear `activePromptId` (already done — see the comment below), and delete the job from the map. **Neither branch calls `cleanupJob(job)`**, so any `.webm` waiting on the VM disk is stranded. This is the only routinely-reachable disk-stranding path in the codebase — a network blip during a 30s-5min video generation is plausible (office WiFi, Tailscale renegotiation, sleep events).

2. **`abortJob` doesn't clear `activePromptId`.** Every other end-of-job site clears it: `expireJob` line where `activePromptId === promptId`, `execution_success`, `execution_error`, `executing(null)`, `flushJobsOnReconnect`'s two branches. Only `abortJob` omits this. The omission isn't user-visible — `onBinary` already drops frames where the job lookup fails — but state-machine consistency matters. One-line fix.

Re-read CLAUDE.md before starting. Disk-avoidance contract is what this batch protects.

**Note:** `flushJobsOnReconnect` already clears `activePromptId` in both branches per the post-refactor code — that part of follow-up 2 is already done. The remaining follow-up 2 fix is only in `abortJob`.

---

## Required changes

### Part 1 — `flushJobsOnReconnect` calls `cleanupJob` for video jobs

Find `flushJobsOnReconnect` in `src/lib/comfyws.ts`. The function loops over pending jobs and queries ComfyUI's `/history/<promptId>`. Two terminal branches:

- **Success-during-disconnect branch** (`statusStr === 'success'`): "Generation completed during reconnection but the output was lost. Please retry."
- **Error-during-disconnect branch** (`statusStr === 'error'`): "Generation failed on the GPU server."

Each branch ends with `this.jobs.delete(promptId);`. **Immediately after** the `delete` call in **both** branches, add:

```ts
this.cleanupJob(job);
```

`cleanupJob(job)` is the existing private helper (introduced by the M1 refactor) that performs type-discriminated cleanup: SSH-deletes the VM file for video jobs, kills ffmpeg + unlinks output for stitch jobs, no-ops for image jobs. The helper is the right abstraction — both branches just need to call it.

Use `cleanupJob`, not a direct `sshCleanupVideo` call. The refactor consolidated cleanup behind this helper precisely so call sites stay uniform; bypassing it would introduce drift.

`cleanupJob` is fire-and-forget internally (it uses `void this.sshCleanupVideo(...)`). Don't `await` the call here either — the reconnect flush should continue processing other in-flight jobs without blocking.

`cleanupJob` is idempotent for the relevant cases:
- For video: the underlying `rm -f` glob no-ops if no file exists.
- For image: it's a no-op switch case (the helper has nothing to do).
- For stitch: stitch isn't reachable here anyway (stitch never queues to ComfyUI), but the helper handles it safely if it ever were.

### Part 2 — `abortJob` clears `activePromptId`

Find `abortJob` in `src/lib/comfyws.ts`. Locate the `this.jobs.delete(promptId)` call near the end of the method.

**Immediately before** `this.jobs.delete(promptId)`, add:

```ts
if (this.activePromptId === promptId) this.activePromptId = null;
```

The conditional matters — `abortJob` may be called for a queued job that wasn't actively executing on the GPU, in which case `activePromptId` points at a different job (or null) and shouldn't be touched.

This brings `abortJob` into line with the other end-of-job code paths that already clear `activePromptId` when their job ends.

The placement is intentional: clearing `activePromptId` before `this.jobs.delete(promptId)` keeps the same ordering as `expireJob` (which clears `activePromptId` early in the method, before the delete). Mirror the existing pattern.

### Part 3 — No other changes

Don't touch:
- The job-type discriminated union or any of the helper methods (`cleanupJob`, `performAbortCleanup`, `dispatchFinalize`, etc.). They have the right shape.
- `expireJob`, `finalizeVideoJob`, `finalizeImageJob`, `execution_error` handler, `executing` handler, `execution_success` handler, `onBinary`. All unchanged.
- The reconnection logic itself (the polling, the timeout window, anything around the `/history` fetch).
- The abort logic itself (the `/interrupt` POST inside `performAbortCleanup`, the SSE error emission, the controller close).
- `removeSubscriber` — that's the silent client-disconnect path; never calls cleanup intentionally.

Resist the temptation to refactor `flushJobsOnReconnect` while you're in there. The two branches share enough structure that someone might want to extract a shared helper. Don't — that's scope creep. The two-line addition in this batch is the entire fix.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -c "this.cleanupJob(job)" src/lib/comfyws.ts` returns at least 3 (the existing call in `expireJob`, plus the 2 new calls in `flushJobsOnReconnect`).
- The two new `cleanupJob` calls in `flushJobsOnReconnect` are inside the `statusStr === 'success'` and `statusStr === 'error'` branches, immediately after `this.jobs.delete(promptId)`.
- `grep -c "this.activePromptId = null" src/lib/comfyws.ts` returns 1 more than pre-fix (was 6 — `expireJob`, `executing(null)`, `execution_success`, `execution_error`, and the two `flushJobsOnReconnect` branches; now 7 with `abortJob`).
- The new `activePromptId` clear in `abortJob` is conditional on `this.activePromptId === promptId` and placed immediately before `this.jobs.delete(promptId)`.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — both bugs are awkward to reproduce on demand):

1. **Code-inspection check (primary).** Run `git diff src/lib/comfyws.ts` after the agent's commit. Confirm:
   - The two new `this.cleanupJob(job);` calls are inside `flushJobsOnReconnect`'s success-branch and error-branch, after `this.jobs.delete(promptId)`.
   - The new `if (this.activePromptId === promptId) this.activePromptId = null;` line in `abortJob` is immediately before `this.jobs.delete(promptId)`.
   - Nothing else in the file changed.
   - Total diff is ~3-4 lines.

2. **Behavior smoke (best-effort).** If you can synthesize a WS disconnect mid-video-generation (e.g., briefly kill the PM2 SSH tunnel during a Wan generation), confirm the reconnect flush errors the job AND `ssh <gpu-vm> ls /models/ComfyUI/output/*.webm 2>&1` returns "no such file" within ~5 seconds of the reconnect. If you can't synthesize the disconnect window reliably, skip — code inspection is the load-bearing check.

3. **Abort regression.** Start a video generation, abort it via the queue tray. Confirm the abort still works as before (job errored, no orphan files on the VM, queue tray clears). The `activePromptId` clear is internal state — no user-visible difference.

4. **Disk-avoidance regression check.** After several generations and aborts: `ssh <gpu-vm> ls /models/ComfyUI/output/` returns "no such file or directory."

---

## Out of scope

- Extracting a shared helper from `flushJobsOnReconnect`'s two branches. Tempting but unnecessary churn.
- Adding stitch-specific handling in `flushJobsOnReconnect`. Stitch jobs don't queue through ComfyUI — they exec ffmpeg directly on mint-pc — so they never appear in the reconnect flush. `cleanupJob` handles stitch correctly anyway via its switch statement.
- Refactoring `cleanupJob` or `performAbortCleanup`. Both have the right shape post-M1.
- Changing the reconnection polling cadence, the `/history` timeout, or the watchdog behavior.
- Changing the abort flow's behavior (when the `/interrupt` POST fires, SSE error shape, SSE close timing).
- Adding observability (logs, metrics) around either path.

---

## Documentation

In CLAUDE.md, find the description of `flushJobsOnReconnect` (in the "Global WebSocket singleton" section). Update the existing description to note cleanup behavior:

> `flushJobsOnReconnect()` polls `/history/{promptId}` (5 s timeout) for each pending job. `status_str === 'success'` → push "completed but image lost, please retry" error and call `cleanupJob` to remove any VM-side artifact; `status_str === 'error'` → push "failed on GPU server" error and call `cleanupJob`; anything else (empty, still running, fetch failure) → leave the job in place so events can resume on the new connection.

The `abortJob` `activePromptId` clear is internal-only and doesn't need documenting — it brings the method into line with the existing pattern across other end-of-job sites.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
