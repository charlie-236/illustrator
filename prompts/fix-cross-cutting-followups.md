# Quick fix — Cross-cutting bundle followups (3 issues)

Three regressions from `fix-cross-cutting-bundle.md` that didn't land cleanly. All small, all in the queue tray + Studio LoRA picker.

1. **Queue items still don't auto-clear** after 60 seconds.
2. **WAN high/low toggles still not visible** in Studio video LoRA picker (DB value IS being saved correctly via auto-detect, just no UI to show or change it).
3. **Queue elapsed-time counter keeps incrementing** after a job completes — was probably introduced by the auto-clear attempt.

Re-read CLAUDE.md before starting. Disk-avoidance unaffected.

---

## Required changes

### Issue 1 — Queue auto-clear (diagnose, don't assume)

**Symptom.** Items stay in the queue tray indefinitely after completion, despite the prior batch's spec for 60-second auto-removal.

**Diagnostic.** Read the current queue state management. Most likely shapes of the bug:

1. The `setTimeout` was added in the wrong place — e.g., wrapped around the wrong state transition, or only firing for one terminal state (`completed`) but not others (`errored`, `aborted`).
2. The `setTimeout` callback's `setJobs` filter doesn't actually remove the job — possibly references a stale closure or wrong field.
3. The terminal-state transition is happening in a different code path than where the timeout was wired up. E.g., if jobs transition via SSE events but the auto-clear was added to a polling path.
4. The fix wasn't applied at all, despite the prior batch saying so.

**Fix.** Diagnose the actual cause:

1. **Add a `console.log` at the terminal-transition site** — wherever a job's status changes to completed/errored/aborted. Confirm it fires when a generation finishes.
2. **Add a `console.log` at the timeout callback** — where the 60s removal happens. Confirm it fires 60s after step 1.
3. **Add a `console.log` inside the `setJobs((prev) => prev.filter(...))` callback** — confirm `prev` contains the job, the filter removes it, and the new state lacks it.

Whichever console.log doesn't fire identifies the broken link.

Common bug shape: in many React state-management patterns, the terminal transition lives in MULTIPLE places (one for each event source — SSE complete, polling-detected complete, manual abort, etc.). The fix needs to be applied at every transition site, not just one.

```ts
// Helper that ANY terminal transition uses:
function markJobTerminal(jobId: string, state: 'completed' | 'errored' | 'aborted') {
  setJobs((prev) =>
    prev.map((j) => (j.id === jobId ? { ...j, state, terminalAt: Date.now() } : j))
  );
  setTimeout(() => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
  }, 60_000);
}
```

Sweep every place the queue transitions a job to a terminal state. Each one should call `markJobTerminal` (or similar). Don't just patch one site and assume the rest are wired up.

After fix, smoke-test BOTH happy-path completion AND error/abort to confirm both auto-clear paths fire.

### Issue 2 — WAN high/low toggles still not visible

**Symptom.** DB value is being saved correctly (auto-detect from CivitAI ingest works). The Studio video LoRA picker doesn't show the checkboxes.

**Diagnostic.** The prior batch's prompt said to find the picker and add the checkboxes. The agent may have:

1. Added the checkboxes to the wrong file (a different LoRA picker — there might be one for image LoRAs and a separate one for video LoRAs).
2. Added the checkboxes inside a conditional that's never true (e.g., `{showHighLow && ...}` where `showHighLow` is never set).
3. Added the checkboxes to a code branch that isn't reached for Wan 2.2 LoRAs (e.g., a generic LoRA renderer that's bypassed by a specialized WanLoRA renderer).
4. Removed the checkboxes during a subsequent edit and didn't re-add.

**Fix.** Read the Studio component's video-mode LoRA picker. Find where each WanLoraSpec renders. Add the checkboxes there.

Specific files to check:

- `src/components/Studio.tsx` — main Studio component
- `src/components/LoRAPicker.tsx` (or similar) — if there's a dedicated picker component
- `src/components/WanLoRAPicker.tsx` — if there's a Wan-specific picker

The render shape per LoRA row in video mode:

```tsx
<div className="flex flex-col gap-2 p-3 border rounded-lg">
  {/* Existing LoRA select + strength input */}
  <div className="flex items-center gap-2">
    {/* existing controls */}
  </div>

  {/* High/low scope toggles — Wan 2.2 only */}
  {isWanLora(lora) && (
    <div className="flex items-center gap-4 pt-2 border-t border-zinc-700">
      <label className="flex items-center gap-2 min-h-12 cursor-pointer">
        <input
          type="checkbox"
          checked={lora.appliesToHigh ?? true}
          onChange={(e) => updateLora(idx, { ...lora, appliesToHigh: e.target.checked })}
          className="w-5 h-5"
        />
        <span className="text-sm text-zinc-300">High noise</span>
      </label>
      <label className="flex items-center gap-2 min-h-12 cursor-pointer">
        <input
          type="checkbox"
          checked={lora.appliesToLow ?? true}
          onChange={(e) => updateLora(idx, { ...lora, appliesToLow: e.target.checked })}
          className="w-5 h-5"
        />
        <span className="text-sm text-zinc-300">Low noise</span>
      </label>
    </div>
  )}
</div>
```

The `isWanLora(lora)` check ensures the toggles only appear for Wan 2.2 LoRAs (not SDXL, Pony, Flux, etc., where high/low doesn't apply). Source the check from the LoRA's `baseModel` field — if it's `'wan22'` or whatever the convention is.

If the picker initializes WanLoraSpec values from saved LoRAConfig records (with auto-detected high/low values), the checkboxes pre-populate correctly. Verify by adding a Wan LoRA to the picker — checkboxes should reflect the auto-detected scope, not always default to (true, true).

### Issue 3 — Queue elapsed-time counter doesn't stop

**Symptom.** The "Generating... 0:42" elapsed-time display on a queued/running job continues incrementing past completion. Job appears to be running forever in the UI display.

**Cause.** When the auto-clear was added (Issue 1), the elapsed-time `setInterval` (the one that ticks each second to update the displayed elapsed time) wasn't cleared when the job transitioned to terminal state.

**Fix.** In the queue-rendering code, find the elapsed-time hook (likely a `useEffect` with `setInterval`). Make sure the interval is cleared in two cases:

1. Component unmount (existing cleanup)
2. **When the job transitions to a terminal state** — new condition

```ts
useEffect(() => {
  if (job.state === 'completed' || job.state === 'errored' || job.state === 'aborted') {
    return; // Don't start a new interval; existing terminal state shows static elapsed
  }
  const interval = setInterval(() => {
    setElapsed(Math.floor((Date.now() - job.startedAt) / 1000));
  }, 1000);
  return () => clearInterval(interval);
}, [job.state, job.startedAt]);
```

The dependency on `job.state` means the effect re-runs when the state changes. The early return in terminal states means no new interval starts, and the cleanup (`clearInterval`) from the previous run fires automatically.

For the displayed elapsed time on terminal jobs: show the final elapsed time captured at the moment of terminal transition, not the live ticker. Add `terminalAt` (or similar) to the job state so the displayed time is `(terminalAt - startedAt) / 1000`, frozen.

```tsx
const displayElapsed =
  job.state === 'completed' || job.state === 'errored' || job.state === 'aborted'
    ? Math.floor(((job.terminalAt ?? Date.now()) - job.startedAt) / 1000)
    : elapsed;
```

The displayed value is now frozen for terminal jobs and live for in-progress jobs.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- Queue items auto-remove 60 seconds after entering a terminal state (completed, errored, or aborted).
- Studio's video LoRA picker displays "High noise" / "Low noise" checkboxes for each Wan 2.2 LoRA in the stack.
- Checkbox values reflect the LoRA's saved high/low flags (not always defaulting to checked).
- Queue elapsed-time counter stops at terminal state; displays the final elapsed time frozen until auto-clear.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. **Queue auto-clear (completion).** Generate an image. Wait for completion. Wait 60 more seconds. Confirm the item is gone from the queue tray.
2. **Queue auto-clear (error).** Trigger an error (kill ComfyUI mid-generation). Wait 60 seconds. Confirm errored item is gone.
3. **Queue auto-clear (abort).** Abort a generation. Wait 60 seconds. Confirm aborted item is gone.
4. **WAN toggle visibility.** Open Studio, switch to video mode. Add a Wan 2.2 LoRA whose DB record has appliesToHigh=true, appliesToLow=false (verify via Models tab if needed). Confirm the High noise checkbox is checked, Low noise is unchecked. Toggle each; confirm UI reflects the change.
5. **WAN toggle non-Wan regression.** Add a non-Wan LoRA (SDXL or Pony) to the image-mode picker. Confirm no high/low checkboxes appear (non-Wan models don't need them).
6. **WAN toggle workflow integration.** Set a LoRA with high=true, low=false. Generate a video. Inspect the workflow JSON (debug endpoint, logs, or local file) — confirm the LoRA appears in the high-noise transformer chain only.
7. **Elapsed timer stops on completion.** Watch a generation complete. Confirm the elapsed time display freezes at the moment of completion (e.g., "0:38") and doesn't keep ticking.
8. **Elapsed timer stops on error.** Same for error case.
9. **Elapsed timer stops on abort.** Same for abort case.
10. **Disk-avoidance regression.** Generate an image and a video. Confirm `ssh <gpu-vm> ls /models/ComfyUI/output/*.png 2>&1` returns "no such file."

---

## Out of scope

- Changing the 60-second auto-clear duration.
- Adding a "clear all completed" manual button.
- Per-user preferences for auto-clear behavior.
- Persisting the WAN toggle UI state separately from the LoRA's stored flags.
- Animated transitions on auto-clear or terminal-state changes.

---

## Documentation

No CLAUDE.md changes needed — these are bug-fix-only on already-documented behavior.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
