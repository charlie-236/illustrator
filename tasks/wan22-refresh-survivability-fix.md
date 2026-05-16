# Batch — Refresh survivability fix (abort vs. disconnect)

PR #19 broke the headline value-prop of the queue UX: refreshing the page during a generation kills tray visibility into a still-running job. The job shows as `aborted` despite ComfyUI still consuming GPU on the VM and the file still landing locally when generation completes.

Root cause: SSE stream close on the server fires `removeJob`, which since PR #16 cleans up the VM file and adds a `recently-completed` entry with status `error: aborted`. But SSE close on its own can mean three things:

1. User pressed Abort — should clean up.
2. Browser refreshed — should keep job running, do nothing.
3. Browser crashed / network died — indistinguishable from #2; collapse to "leave it alone."

Cases #2 and #3 collapse together. The fix is to **stop treating SSE stream close as a signal of user intent**. Abort becomes an explicit endpoint call. SSE close on its own does nothing to job state.

Re-read CLAUDE.md before starting. This batch touches the comfyws job-lifecycle in a load-bearing way; read those tests carefully.

---

## What's changing

### Stream close behavior

Today, when the SSE response stream closes on the server (whether from the client closing the tab, refreshing, losing wifi, or pressing an in-app abort that closes the SSE):

- The route's `req.signal.addEventListener('abort')` handler fires.
- It calls `manager.removeJob(promptId)`, which cancels watchdog, marks `recentlyCompleted` with `error: aborted`, and SSH-cleans the VM file.

After this batch:

- Stream close fires only "stop pushing events to this particular subscriber." It removes the SSE controller from the job's subscriber list (which is currently a single controller per job — see "Subscriber refactor" below).
- It does **not** remove the job, cancel the watchdog, mark `recentlyCompleted`, or clean up the VM file.
- The job continues running on the VM, completes naturally (or hits the watchdog), and finalizes via the existing `finalizeVideoJob` / `expireJob` paths — which include their own SSH cleanup.

### Explicit abort endpoint

A new endpoint is the only way for the client to signal "user wants to abort":

```
POST /api/jobs/[promptId]/abort
```

Or extend whatever endpoint pattern already exists for in-tab abort (read the queue-UX abort code from PR #19 — it's likely already a fetch call somewhere; if so, just point it at this new endpoint instead of relying on stream-close).

The endpoint:

1. Calls `manager.abortJob(promptId)` (new method, see below).
2. Returns 200 with `{ ok: true }` (or 404 if the prompt isn't an active job).

### Job manager — split `removeJob` into two methods

Today `removeJob` does both "user aborted" cleanup and "stream subscriber went away" cleanup. Split:

**`abortJob(promptId)`** — explicit user abort. Existing `removeJob` behavior:

- Clear watchdog.
- Issue ComfyUI cancel POST if applicable (the existing path for in-flight cancellation — keep whatever's there).
- SSH-clean the VM file via the existing `sshCleanupVideo(filenamePrefix)` (fire-and-forget, glob is idempotent).
- Add `recentlyCompleted` entry with `status: 'error', errorMessage: 'Aborted'`.
- Remove from active jobs map.
- Notify any remaining subscribers with the abort event so the SSE stream pushes a clean final message before the controller closes.

**`removeSubscriber(promptId, controller)`** — silent. Just unhooks the controller from the job's subscriber list. No state mutation beyond that. The job continues.

Stream-close handlers in the routes call `removeSubscriber`. The abort endpoint calls `abortJob`. **Stream close should never call `abortJob`.**

### Subscriber refactor (multiple subscribers per job)

Today each job has a single SSE controller pushing events. After refresh, the comfyws layer has no way to "reattach" — but the `/api/jobs/active` polling path was meant to handle this. The polling path works (it returns active jobs) but stream-close was destroying those jobs before the next poll ran.

After this fix:

- Stream close → job stays alive → next poll sees it → tray repopulates → progress visible. Good.
- That's actually sufficient. The polling fallback handles the refresh case as designed; we don't need true multi-subscriber SSE.

So: don't refactor for multi-subscriber SSE. Polling stays the recovery mechanism. The subscriber model can stay single-controller-per-job; `removeSubscriber` is just `job.subscriber = null` (or equivalent).

If the existing job structure has `controller: ResponseController | null`, the implementation is:

```ts
removeSubscriber(promptId: string, controller: ResponseController): void {
  const job = this.jobs.get(promptId);
  if (job?.subscriber === controller) {
    job.subscriber = null;
  }
  // Job stays in the map. Watchdog still ticks. Completion still fires.
}
```

When `finalizeVideoJob` later fires and the job has no subscriber, it just doesn't try to push events. The DB row still updates, the file still lands locally, the `recentlyCompleted` entry is still added (as `done`, not `error`). The next `/api/jobs/active` poll will see the `done` entry and the queue UX will fire the completion notifications.

### Route changes

In `src/app/api/generate-video/route.ts` and `/api/generate/route.ts` (image route — same fix, same pattern):

```ts
req.signal.addEventListener('abort', () => {
  manager.removeSubscriber(promptId, controller);
  try { controller.close(); } catch { /* already closed */ }
});
```

The `controller.close()` line is fine — that's just the local response controller. The job manager's state stays intact.

### Recently-completed cache: handle late finalization for refreshed clients

After refresh, the polling client expects to see jobs transition `running → done` via the `recentlyCompleted` cache. Verify:

- `finalizeVideoJob` adds to `recentlyCompleted` with `status: 'done'` regardless of whether a subscriber existed.
- `expireJob` adds with `status: 'error', errorMessage: 'Watchdog timeout'`.
- `execution_error` handler adds with `status: 'error', errorMessage: <ComfyUI error>`.
- `abortJob` adds with `status: 'error', errorMessage: 'Aborted'`.

All four branches must populate `recentlyCompleted`. If any of them are gated on "has subscriber" (which would have been the natural way to write them), un-gate. The cache must be subscriber-independent.

The polling endpoint `/api/jobs/active` (or whatever PR #19 named it) needs to merge active jobs and recently-completed jobs in its response. Verify the existing implementation does this — the smoke test failure suggests the active-jobs endpoint may also need a small adjustment.

### Browser unload cleanup — leave it alone

Browsers fire `pagehide` / `beforeunload` when refreshing or closing. Some apps use this to send a `navigator.sendBeacon` to clean up server state. **Don't add this.** The whole point of this fix is that refresh shouldn't trigger cleanup. If the user wants to abort, they press Abort.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -rn "removeJob\b" src/` returns no matches in production code paths — the method is renamed/split.
- `grep -rn "abortJob\b" src/` shows the new method definition and exactly one call site (the abort endpoint).
- `grep -rn "removeSubscriber\b" src/` shows the new method definition and call sites in both `/api/generate` and `/api/generate-video` route files.
- The abort endpoint exists and returns 200/404 appropriately.
- Stream-close handlers call `removeSubscriber`, not `abortJob` and not the old `removeJob`.

Manual smoke test (deferred to user):

1. **Refresh during generation (the failing case from PR #19).** Start a video generation. Refresh the page within the first 2 minutes. Wait 5–10 seconds. Confirm: tray repopulates with the in-flight job, progress updates resume, generation completes normally, file lands in gallery, full notification chain fires.

2. **Confirm via VM that the job kept running.** During step 1, between the refresh and completion, run `ssh a100-core 'nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv'`. GPU utilization should remain high — proof the job didn't get cancelled by the refresh.

3. **Explicit abort still works.** Start a video. Press the abort button in the queue tray. Confirm: tray entry transitions to `error: Aborted` immediately, GPU utilization drops within seconds (ComfyUI cancel kicks in), no orphan webm appears on the VM.

4. **Tab close.** Start a video, close the tab entirely. Open a new tab to Studio within ~30 seconds. Confirm: tray repopulates with the in-flight job. Wait for completion. Confirm: file lands, gallery has the new video.

5. **Browser crash simulation.** Start a video. Force-quit the browser. Reopen. Same expectation as step 4.

6. **No regression on completion path.** Start a video and just leave the tab open. Wait for natural completion. Confirm: tray transitions running → done, file appears in gallery, notification chain fires.

7. **No regression on watchdog.** This is hard to test without artificially extending generation past the 15min watchdog. Skip if not easily testable; rely on the unit/integration tests if any exist.

8. **Image generations.** Start an image generation (~30s). Refresh during it. Confirm same survivability behavior.

---

## Out of scope

- True multi-subscriber SSE. The polling fallback is sufficient and lower-complexity. If at some point the 5s polling granularity feels laggy on refresh, that's the moment to revisit; not now.
- Any changes to the UI's queue tray rendering or notification chain — the underlying state shape is unchanged.
- Persistence of jobs across server restarts. In-memory only, single-user app, server restart kills queue visibility (file still lands; gallery picks it up). Same as before.
- `beforeunload` / `pagehide` handlers. Don't add them.
- Any change to ComfyUI cancel logic. The existing path for in-flight cancellation in `abortJob` is whatever was there before, just extracted from the old `removeJob`.

---

## Documentation

In CLAUDE.md, find the "Queue UX" subsection added by PR #19. Replace any text that says "stream close cleans up" or similar with:

> SSE stream close is treated as silent — it just stops pushing events to that subscriber. The job continues on the VM. To intentionally abort a running job, the client calls `POST /api/jobs/[promptId]/abort`. This separation is what makes refresh survivability work: a refresh closes the SSE stream, the job stays alive on the server, the next `/api/jobs/active` poll on mount finds it, and the tray reattaches.

Find the API routes table and add the abort endpoint.

In AGENTS.md, if there's a section on common pitfalls or "things that have bitten us before," add a one-liner:

> SSE stream close ≠ user intent. Don't treat client disconnect as an abort signal — that conflates "user pressed cancel" with "browser refreshed" and breaks refresh survivability. Aborts must be explicit endpoint calls.

When done, push and create the PR via `gh pr create` per AGENTS.md. Include in the PR description: confirmation that all 8 manual smoke-test steps pass, and a screenshot of the queue tray immediately after a refresh, showing the live job reattached.
