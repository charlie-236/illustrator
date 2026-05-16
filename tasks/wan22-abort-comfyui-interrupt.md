# Batch — Wire abortJob to ComfyUI's /interrupt

`abortJob` cleans up server-side bookkeeping but doesn't tell ComfyUI to stop the running workflow. When the user clicks Abort, the tray transitions to `error: Aborted` instantly, but ComfyUI keeps the GPU busy until the workflow naturally completes — wasting GPU-minutes on output the user just told us to discard.

Disk leakage isn't an issue here: the existing 1-minute sweeper on `/output` and `/temp` covers any file that lands. This fix is purely about GPU-time + responsiveness.

Re-read CLAUDE.md before starting.

---

## Required changes

### `src/lib/comfyws.ts` — `abortJob`

After `clearTimeout` and before `sshCleanupVideo`, fire-and-forget POST to ComfyUI's `/interrupt` endpoint:

```ts
fetch(`${COMFYUI_URL}/interrupt`, { method: 'POST' }).catch((err) => {
  console.error(`[comfyws] /interrupt failed for ${promptId}:`, err);
});
```

Notes:
- `COMFYUI_URL` is the existing constant pointing at `http://127.0.0.1:8188` (or whatever the route uses for its `/view` calls). Match the existing reference — don't introduce a new env var.
- Fire-and-forget. Don't `await`. The cleanup logic should not block on `/interrupt`'s response; if ComfyUI is unreachable the abort still proceeds.
- `/interrupt` is workflow-global (no `promptId` parameter). It cancels whatever is executing in ComfyUI's queue right now — which, for our single-user app, is the job being aborted. If the user has queued multiple jobs and aborts one that *isn't* the head of ComfyUI's queue, this will incorrectly cancel whichever one ComfyUI is currently executing. That's a known ComfyUI API limitation, not something we can route around. Acceptable for Phase 1; flag in the PR description so it's visible if/when it bites.

That's the entire change.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "/interrupt" src/lib/comfyws.ts` shows exactly one match, inside `abortJob`.
- The fetch is not `await`ed and has a `.catch` handler.

Manual smoke test (deferred to user):

1. Start a video generation. Within 30 seconds, click Abort.
2. Run `ssh a100-core 'nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv'` repeatedly. GPU utilization should drop to near-idle within ~5 seconds of the abort click. Before this batch it would have stayed pegged for the remaining ~13 minutes.
3. Confirm no regression on the abort tray UX itself (entry transitions to `error: Aborted`, no orphan webm in the gallery, no orphan in `/output` after the 1-minute sweeper runs).

---

## Out of scope

- Per-prompt cancellation. ComfyUI's `/interrupt` is workflow-global; there's no per-`promptId` cancel API. If/when multi-job queueing surfaces this as a real problem, the fix is to thread requests through the ComfyUI queue more carefully — separate batch.
- Calling `/interrupt` during `expireJob` (watchdog timeout). Out of scope; if the watchdog fires, ComfyUI is already misbehaving and we should surface the failure rather than hide it. Re-evaluate if watchdog timeouts ever become routine.
- Calling `/interrupt` on `removeSubscriber`. The whole point of the prior batch was that subscriber removal does nothing to job state. Don't touch.

---

## Documentation

In CLAUDE.md's queue UX subsection, find the description of abort behavior. Add one line:

> `abortJob` also fires `POST /interrupt` to ComfyUI fire-and-forget, releasing the GPU immediately rather than letting the cancelled workflow finish naturally.

When done, push and create the PR via `gh pr create` per AGENTS.md.
