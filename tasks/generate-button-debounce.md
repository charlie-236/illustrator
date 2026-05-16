# Batch — Generate button debounce

Tablet usage means soft-tap latency, occasional double-taps, and finger drift. The Studio Generate buttons (image and video) currently fire on every click without any debouncing. A double-tap submits twice, queueing two identical generations the user only meant to submit once. Wastes GPU minutes; clutters the queue tray.

Fix: brief disabled state on the Generate buttons immediately after submit, regardless of whether the form-state lock has propagated yet.

Re-read CLAUDE.md before starting.

---

## What to build

In `src/components/Studio.tsx`, add a `submitting` state that goes true on Generate click and reverts to false after a short debounce window OR after the SSE init event arrives — whichever is sooner.

```ts
const [submitting, setSubmitting] = useState(false);

async function handleGenerate() {
  if (submitting) return;  // double-tap guard
  setSubmitting(true);

  // Existing handleGenerate body...
  // Note: the body already has its own state management for the SSE flow.
  // We're just adding the submitting overlay on top of that.

  // Reset the submitting flag after a short fixed window. The flag's job is
  // strictly to absorb the second tap of a double-tap; it's not the form lock.
  // The actual form lock is whatever existing state the SSE flow uses.
  setTimeout(() => setSubmitting(false), 800);
}
```

The 800ms window is a tablet-friendly debounce — long enough to absorb intentional double-taps and finger-drift double-fires, short enough that the user can legitimately submit two different generations back-to-back.

Apply the same pattern to `handleGenerateVideo`. Same `submitting` flag, or a parallel `videoSubmitting` flag — agent's call. A single shared flag is fine since only one of the two Generate buttons is visible at a time (mode toggle determines which).

### Wire submitting into the buttons

Both Generate buttons already have a `disabled` attribute keyed off form validity (`!p.checkpoint` for image, `videoGenerateDisabled` for video). Extend with `submitting`:

```tsx
{/* Image Generate */}
<button
  onClick={() => void handleGenerate()}
  disabled={!p.checkpoint || submitting}
  className="..."
>
  {p.batchSize > 1 ? `Generate ×${p.batchSize}` : 'Generate'}
</button>

{/* Video Generate */}
<button
  onClick={() => void handleGenerateVideo()}
  disabled={videoGenerateDisabled || submitting}
  className="..."
>
  Generate Video
</button>
```

The existing `disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100` Tailwind classes already give the right visual cue when disabled. No new styling needed.

### Don't show a spinner on the button

The Generate button briefly going gray-and-unresponsive is enough feedback. A spinner overlay on the button itself implies "the work is happening" — but the work happens in the queue tray, not on the button. The button just disabled itself for 800ms. Keep the visual subtle.

If the queue tray's "Queued" entry is the visible feedback (which it is, per Phase 1.2b and the queue tray Queued status batch), that's already the right place for "your job is happening" feedback. The button doesn't need to compete with it.

### Why a fixed 800ms instead of "until the SSE init arrives"

Two reasons:

1. **The SSE init might arrive in <100ms** (image route) or in **>2 seconds** (video route, depending on ComfyUI queue depth). Either way, the user could double-tap during that window. A fixed 800ms catches the realistic finger-drift case regardless of route latency.

2. **If the SSE never arrives** (network error, route bug), the button needs to re-enable so the user can retry. A timer-based reset guarantees this. Tying the reset to "SSE init arrived" risks leaving the button stuck if init never comes.

The 800ms is independent of and additive to whatever queue-management state the SSE flow does for itself. If the SSE flow already disables submit when there's an active job, fine — that's a different lock. This batch's only job is "absorb a double-tap."

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- Both Generate buttons (image and video) gate `disabled` on a `submitting` flag in addition to existing form-validity checks.
- The `submitting` flag goes true at click time and resets via a fixed-duration `setTimeout` (800ms).
- `grep -n "submitting" src/components/Studio.tsx` shows the new state and its usage in both button branches.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. Open Studio in image mode. Tap Generate. Confirm the button briefly grays out, then re-enables. Confirm one job appears in the queue tray.
2. Open Studio. Tap Generate twice in quick succession (within ~500ms). Confirm only one job appears in the queue tray.
3. Open Studio. Tap Generate. Wait for the job to start (queue tray shows it as "Queued" or "Running"). Tap Generate again. Confirm a second job appears (the first 800ms window has elapsed; this is intentional behavior — two real submissions).
4. Same flow in video mode. Confirm Generate Video has the same debounce behavior.
5. Tap Generate with the form invalid (e.g., no checkpoint selected). Confirm nothing happens, no queue entry created. The button stays disabled the whole time.

---

## Out of scope

- Spinner overlay on the button.
- A configurable debounce duration in `.env`. 800ms is a tablet-tuned constant; if it ever needs adjustment that's a one-line code edit.
- Changing the existing form-lock or queue-management logic. The new debounce is additive.
- Applying the same pattern to other buttons (Polish, Stitch, etc.) — those have their own flows and aren't part of this batch.
- Server-side idempotency keys to prevent duplicate submissions if the debounce somehow fails. The client-side debounce is sufficient for the failure mode it addresses (double-tap).
- Using the new `useTransition` React 19 pattern or other concurrent-mode plumbing. Plain `useState` + `setTimeout` is right-sized.

---

## Documentation

No CLAUDE.md changes needed. The behavior is small enough to live in the code as a self-explanatory comment ("// 800ms double-tap guard").

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
