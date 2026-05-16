# Batch — Cross-cutting fixes (5 issues)

Five issues from QA that don't share files but are each small and isolated. Bundled because each fix is too small to deserve its own batch.

1. **Queue auto-removal.** Image/video queue items linger after completion. Want auto-remove after 60 seconds.
2. **Gallery duplicates on first load.** Items display twice when Gallery first loads after app start; filtering resolves.
3. **Regression: WAN high/low toggle disappeared.** The high_noise/low_noise toggle for Wan 2.2 video LoRAs is gone from Studio.
4. **Lora download toast — show high/low assignment.** When a Wan 2.2 LoRA is downloaded, the success toast should mention whether high/low was auto-detected.
5. **Tablet crypto.randomUUID error.** IngestPanel batch download crashes on tablet with `crypto.randomUUID is not a function`.

Re-read CLAUDE.md before starting. Disk-avoidance unaffected.

---

## Required changes

### Issue 1 — Queue auto-removal after completion

**Symptom.** The image/video queue UI accumulates items indefinitely. Even completed items stay visible.

**Fix.** After a job's status becomes `completed` (or `errored`, or `aborted`), schedule its removal from the queue display 60 seconds later.

In whatever component manages the queue state (likely `QueueContext.tsx` or `QueueTray.tsx`), add a removal timer when a job transitions to a terminal state:

```ts
const TERMINAL_DISPLAY_MS = 60 * 1000;

function transitionToTerminal(jobId: string, finalState: 'completed' | 'errored' | 'aborted') {
  setJobs((prev) =>
    prev.map((j) => (j.id === jobId ? { ...j, state: finalState, terminalAt: Date.now() } : j))
  );

  setTimeout(() => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
  }, TERMINAL_DISPLAY_MS);
}
```

If the user manually dismisses a job before the 60s timer fires, that's fine — the timer's `setJobs` filter will no-op (the job already isn't in the list).

If a new job is added while old jobs are pending removal, no interaction — each job's timer is independent.

Edge case: if the page is reloaded while jobs are pending removal, the timers are lost. On reload, the queue refetches active jobs (existing behavior); completed jobs not in the active fetch don't appear. Acceptable — reload is the natural full reset.

Make the timeout configurable via env var if you want flexibility:

```ts
const TERMINAL_DISPLAY_MS = parseInt(process.env.NEXT_PUBLIC_QUEUE_TERMINAL_DISPLAY_MS ?? '60000', 10);
```

But default 60s is fine without env var. Don't gate on env complexity.

### Issue 2 — Gallery duplicates on first load

**Symptom.** When opening the Gallery tab fresh after app start, every item displays twice. Applying any filter then resolves the issue.

**Diagnostic.** Classic React effect bug. Most likely causes:

- `useEffect` with no dependency array, firing twice in StrictMode dev (this would only manifest in dev; verify in production build).
- Two parallel fetches racing — a mount fetch and a focus fetch both firing on initial render.
- State setter being called with the new items APPENDED to existing items instead of replacing.
- `useEffect` dependency array missing a value, causing two fires that both append.

**Fix.** Read `src/components/GalleryTab.tsx` (or equivalent). Find the data-fetching effect. Verify:

1. The effect has a proper dependency array (not missing, not empty when it should depend on something).
2. The state setter REPLACES the items list, not appends:
   ```ts
   // CORRECT:
   setItems(data.records);
   
   // WRONG (causes duplicates if effect fires twice):
   setItems((prev) => [...prev, ...data.records]);
   ```
3. If using infinite scroll / pagination, the "load more" path does append, but the initial load should always be a clean replace.

If the issue is React 18 StrictMode double-mounting: add an abort signal to the fetch to make the effect idempotent:

```ts
useEffect(() => {
  const controller = new AbortController();
  void (async () => {
    const res = await fetch('/api/gallery', { signal: controller.signal });
    if (controller.signal.aborted) return;
    const data = await res.json();
    setItems(data.records);
  })();
  return () => controller.abort();
}, [/* deps */]);
```

The abort on cleanup means the first effect run gets cancelled if React StrictMode mounts the component twice; only the second run's fetch lands.

After fixing, verify by hard-refreshing the app multiple times; gallery should never show duplicates.

### Issue 3 — Regression: WAN high/low toggle disappeared

**Symptom.** The high_noise/low_noise checkboxes for Wan 2.2 video LoRAs are gone from Studio's video mode LoRA picker.

**Background.** Implemented in the `wan-lora-expert-scope` batch. Per the implementation, each LoRA in the picker should show two checkboxes ("Applies to high noise" / "Applies to low noise"), defaulting to both checked.

**Diagnostic.** Possibly removed by:
- A subsequent batch that refactored the LoRA picker UI.
- The strip-hardcoded-service-identities batch (unlikely, but possible if it accidentally removed UI state).
- A merge conflict during one of the recent merges.

**Fix.** Read the current Studio LoRA picker for video mode. Find the WanLoraSpec rendering. Confirm the high/low checkboxes are present. If absent, restore them per the original wan-lora-expert-scope batch's spec:

For each LoRA row in the video LoRA picker:

```tsx
<div className="flex items-center gap-3">
  {/* Existing LoRA selector / strength input */}
  <label className="flex items-center gap-2 min-h-12">
    <input
      type="checkbox"
      checked={lora.appliesToHigh ?? true}
      onChange={(e) => updateLora(idx, { appliesToHigh: e.target.checked })}
      className="w-5 h-5"
    />
    <span className="text-sm text-zinc-300">High noise</span>
  </label>
  <label className="flex items-center gap-2 min-h-12">
    <input
      type="checkbox"
      checked={lora.appliesToLow ?? true}
      onChange={(e) => updateLora(idx, { appliesToLow: e.target.checked })}
      className="w-5 h-5"
    />
    <span className="text-sm text-zinc-300">Low noise</span>
  </label>
</div>
```

The toggles read from / write to the WanLoraSpec's `appliesToHigh` and `appliesToLow` fields (existing). Defaults to true/true if undefined.

The values flow into the workflow build at submit time — the existing `applyUserLoras` in `wan22-workflow.ts` consumes them. No backend change needed; only the missing UI.

### Issue 4 — Lora download toast: show high/low assignment

**Symptom.** When a Wan 2.2 LoRA is downloaded via CivitAI ingest, the success toast just says "downloaded." User wants visibility into whether the high_noise/low_noise auto-detection assigned the LoRA correctly.

**Fix.** When the ingest completes for a Wan 2.2 LoRA (i.e., `LoraConfig.baseModel === 'wan22'` or whatever the marker is), include the detected scope in the success message.

In `src/lib/civitaiIngest.ts` (or wherever the post-ingest message is emitted), after the LoRA is created/updated, inspect the resulting flags:

```ts
function summarizeLoraScope(applyHigh: boolean, applyLow: boolean): string {
  if (applyHigh && applyLow) return ' (both transformers — verify; you may want to set high or low only)';
  if (applyHigh && !applyLow) return ' (high noise transformer)';
  if (!applyHigh && applyLow) return ' (low noise transformer)';
  return ' (neither transformer — disabled)';
}

// In the success message:
const scopeNote = summarizeLoraScope(lora.appliesToHigh, lora.appliesToLow);
const message = `Downloaded ${lora.friendlyName}${scopeNote}`;
```

The "(both transformers — verify; you may want to set high or low only)" wording flags to the user that the auto-detection didn't match a known pattern; they should verify in the LoRA editor.

For non-Wan LoRAs (SDXL, Pony, SD1.5, Flux), the high/low concept doesn't apply — no scope note in the message. Add a check:

```ts
if (lora.baseModel === 'wan22') {
  message += scopeNote;
}
```

Verify the actual baseModel value used in the schema (might be `'wan22'`, `'wan-2.2'`, or similar — match the existing convention).

### Issue 5 — Tablet crypto.randomUUID error

**Symptom.** Batch model download from IngestPanel crashes on tablet with `TypeError: crypto.randomUUID is not a function`.

**Background.** `crypto.randomUUID()` is gated to secure contexts (HTTPS or localhost). When the tablet accesses the app over HTTP across the network (e.g., `http://192.168.x.x:3001`), the browser exposes `crypto.subtle` and `crypto.randomUUID` as undefined.

**Fix.** Replace `crypto.randomUUID()` with a polyfill that works in all contexts.

Find the call site at `src/components/IngestPanel.tsx:127` (per the error message). Replace with a safe ID generator:

```ts
function safeRandomId(): string {
  // Prefer crypto.randomUUID when available (secure contexts only)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: Math.random-based UUID-shaped string
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
```

Then replace `crypto.randomUUID()` with `safeRandomId()` at the failing line.

The fallback is sufficient for client-side dedup IDs in IngestPanel (these aren't security-critical UUIDs — they're just unique strings for tracking pending downloads). Math.random collisions in this scope are vanishingly unlikely.

If `crypto.randomUUID` is called elsewhere in the codebase, sweep for it:

```bash
grep -rn "crypto.randomUUID" src/
```

Replace each call with `safeRandomId()`. If it's used in many places, extract `safeRandomId` to a shared util like `src/lib/safeRandomId.ts` and import.

For server-side code (e.g., Node.js routes): server runs in a "secure context" by definition, so `crypto.randomUUID` works. The polyfill is only needed for client-side code.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- Queue items auto-remove 60 seconds after entering a terminal state.
- Gallery first-load shows each item once, not twice.
- Studio's video LoRA picker shows "High noise" / "Low noise" checkboxes per LoRA row, with 44px tap targets.
- Wan 2.2 LoRA download toasts include the detected scope.
- IngestPanel batch download works on tablet (no crypto.randomUUID crash).
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. **Queue auto-remove.** Generate an image. Wait for it to complete. Wait 60 more seconds. Confirm the completed item is no longer in the queue tray.
2. **Queue auto-remove on error.** Trigger an error (e.g., disconnect ComfyUI mid-generation). Confirm the errored item is also auto-removed after 60s.
3. **Gallery first load.** Hard-refresh app (Ctrl+Shift+R). Open Gallery as the first action. Confirm each item appears exactly once. No filtering needed.
4. **Wan high/low toggles.** Open Studio, switch to video mode. Add a Wan 2.2 LoRA. Confirm two checkboxes ("High noise" / "Low noise") appear next to the LoRA row. Toggle each; values persist.
5. **Wan high/low workflow integration.** Set a LoRA with high=true, low=false. Generate a video. Inspect the workflow JSON (via debug endpoint or logs) to confirm the LoRA loader appears in the high transformer chain only.
6. **CivitAI download toast — high noise detected.** Download a CivitAI Wan 2.2 LoRA whose filename contains "high_noise". Confirm toast says "Downloaded X (high noise transformer)".
7. **CivitAI download toast — both default.** Download a CivitAI LoRA with no recognizable pattern. Confirm toast includes the "(both transformers — verify...)" scope note.
8. **Tablet crypto fix.** From the tablet (over HTTP), open Models tab. Trigger batch download. Confirm it works without crashing.
9. **Desktop crypto regression.** From localhost, same batch download. Confirm still works (the polyfill doesn't break the non-tablet path).
10. **Disk-avoidance regression.** Generate an image and a video. Confirm `ssh <gpu-vm> ls /models/ComfyUI/output/*.png 2>&1` returns "no such file."

---

## Out of scope

- User-configurable terminal display duration (60s is fine for now; env var optional).
- A "clear all completed" button on the queue. The auto-remove handles this.
- Pagination for the queue tray (it's already short-lived).
- Refactoring the gallery fetch into a more sophisticated state library (React Query, SWR). The existing pattern + abort-on-cleanup is enough.
- Server-side support for `crypto.randomUUID` polyfill (server contexts have it natively).
- A "verify high/low scope" UI prompt on download. The toast wording flag is enough.
- Generalizing the auto-remove to all status displays in the app.
- Animations on queue item removal.

---

## Documentation

In CLAUDE.md, under the relevant existing sections, add brief notes:

> **Queue auto-removal.** Completed / errored jobs auto-remove from the queue tray 60 seconds after entering terminal state. Default `TERMINAL_DISPLAY_MS = 60_000`. Reload always shows fresh state from the active-jobs fetch.

> **Wan LoRA scope toggles.** Studio's video LoRA picker exposes per-LoRA "High noise" / "Low noise" checkboxes. Defaults match the auto-detected scope from CivitAI ingest (or both true if no pattern matched). Manual override via Models tab editor.

> **CivitAI ingest toast.** For Wan 2.2 LoRAs, the success toast includes the detected expert scope ("high noise transformer", "low noise transformer", or "both — verify").

> **Insecure-context UUID polyfill.** `safeRandomId()` (in `src/lib/safeRandomId.ts` or inlined) replaces `crypto.randomUUID()` for client-side ID generation. Required because tablet access over HTTP doesn't expose `crypto.randomUUID`.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
