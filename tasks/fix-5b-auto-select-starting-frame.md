# Quick fix — Phase 5b: scene's suggested starting frame doesn't auto-populate

Phase 5b's smoke test #4 ("Scene 2+ generate — confirm previous scene's canonical clip is auto-selected as i2v starting frame") fails. When the user taps "Generate this scene" on Scene 2, Studio opens with the prompt and frames pre-filled, but the starting-frame selection from `sceneContext.suggestedStartingClipId` doesn't materialize.

The 5b prompt instructed:

```ts
if (sc.suggestedStartingClipId) {
  setUseStartingFrame(true);
  setSelectedStartingClipId(sc.suggestedStartingClipId);
  // The existing extract-last-frame fetch fires off this; no new logic needed
}
```

The "no new logic needed" comment was optimistic. The existing GalleryPicker → starting frame flow does more than just set state — it likely triggers an extract-last-frame fetch and populates a base64 image into a separate state field. Just setting the clip ID isn't enough.

Diagnose and fix by mirroring the GalleryPicker flow exactly.

Re-read CLAUDE.md before starting. Disk-avoidance is unaffected.

---

## Investigation

Before changing code, trace the working path:

1. **Read `src/components/Studio.tsx`** to find the GalleryPicker integration. The picker passes a selected clip back to Studio via some callback (likely `onPick(clip)` or similar). Find that handler.

2. **Trace what the handler does.** Typical pattern: it sets `selectedStartingClipId`, then either fires `/api/extract-last-frame/[clipId]` directly or sets state that a `useEffect` watches and the effect fires the fetch. The fetch returns a base64 frame which is stored in state (something like `startingFrameImage`).

3. **Identify the missing step in the apply-trigger effect.** The 5b implementation set the clip ID and the toggle, but probably skipped the extract-last-frame step. Or set state in an order that didn't trigger the watcher effect. Or set state on a render where the effect's dependencies hadn't yet updated.

4. **Confirm by inspection or temporary console log.** Tap "Generate this scene" on Scene 2 and observe in DevTools whether the extract-last-frame request fires. If it does and the response comes back fine but the UI doesn't reflect it, the issue is rendering / state. If it doesn't fire at all, the issue is the apply-trigger effect.

## Fix

Mirror the GalleryPicker's working path exactly. Two acceptable shapes:

**(a) Call the same handler.** If the GalleryPicker callback handler is named (e.g., `handleStartingClipPicked(clipId)`), extract that handler so it's callable from the apply-trigger effect too:

```ts
const handleStartingClipPicked = useCallback(async (clipId: string) => {
  setSelectedStartingClipId(clipId);
  setUseStartingFrame(true);
  // ... existing extract-last-frame fetch + state population
}, [/* deps */]);
```

Then in the apply-trigger effect:

```ts
if (sc.suggestedStartingClipId) {
  await handleStartingClipPicked(sc.suggestedStartingClipId);
}
```

(Or `void handleStartingClipPicked(...)` if the effect is sync and we want fire-and-forget.)

**(b) Reproduce the steps inline.** If the existing handler is small, just inline the same calls in the apply-trigger effect — `setSelectedStartingClipId`, `setUseStartingFrame(true)`, AND the extract-last-frame fetch + image-state population.

(a) is cleaner. Prefer it unless extracting introduces dependency cycles or requires meaningful refactor.

## Edge cases

- **`suggestedStartingClipId` references a clip that was deleted.** The chaining-suggestion logic in ProjectDetail validates the clip exists before passing it through — but defensive code in the apply-trigger should also handle the case (extract-last-frame returns 404 → fall back to no starting frame, log warning, don't crash).
- **`suggestedStartingClipId` is null.** Already handled (the `if (sc.suggestedStartingClipId)` guard skips this branch). Studio defaults to no starting frame, t2v mode.
- **User has previously selected a different clip in this Studio session.** The apply-trigger effect runs on `projectContextTrigger` change, which includes scene triggers. The scene's suggestion overrides whatever was previously picked. That's correct behavior — the scene context is the authoritative source when triggered.
- **Async race.** If the extract-last-frame fetch is async and takes a moment, the user might see the form populate (prompt, frames) before the starting-frame thumbnail loads. That's fine — the starting-frame thumbnail has its own loading state (or appears on completion). The whole effect doesn't need to be synchronous.

## Out of scope

- Refactoring the GalleryPicker integration generally.
- Caching extract-last-frame results across multiple calls for the same clip.
- A loading indicator specific to the apply-trigger flow. The existing extract-last-frame loading UI handles it.
- Changing the chaining-suggestion logic in ProjectDetail (`resolveCanonicalClipId`). The fix is purely in Studio's apply-trigger.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- The Studio apply-trigger effect, when receiving a `sceneContext` with a non-null `suggestedStartingClipId`, results in the same UI state as if the user had picked that clip via GalleryPicker.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. **Re-run Phase 5b smoke test #4.** Generate Scene 1 of a fresh storyboard. Tap "Generate this scene" on Scene 2. Confirm Studio opens in video mode with the starting-frame toggle ON, Scene 1's canonical clip selected as the source, and the last-frame thumbnail visible in the i2v section. Tap Generate. Confirm the resulting clip uses Scene 1's last frame as its first frame.
2. **Override after auto-select.** Tap "Generate this scene" on Scene 3. The auto-suggestion populates Scene 2's canonical. Open the GalleryPicker, pick a different clip. Confirm the selection updates correctly and the new clip's last frame replaces the auto-suggested one.
3. **Toggle off after auto-select.** Tap "Generate this scene" on Scene 4. The auto-suggestion populates. Toggle starting frame OFF. Confirm the t2v form takes over and Generate produces a t2v output.
4. **Deleted clip case.** Set Scene 2's canonicalClipId to a clip, then delete that clip from the gallery. Tap "Generate this scene" on Scene 3. Confirm: ProjectDetail's resolution falls back to next-eligible (or null), so either a different clip auto-suggests or no starting frame is set. No crash, no error toast.
5. **Scene 1 (no predecessor).** Tap "Generate this scene" on Scene 1. Confirm starting frame is OFF (no suggestion); Studio is in t2v mode.
6. **Regression: GalleryPicker still works.** From a fresh Studio video session (not triggered from a scene), open GalleryPicker manually and pick a starting clip. Confirm it still works as before — the fix doesn't break the original flow.

---

## Documentation

No CLAUDE.md changes — the documented behavior was correct; the implementation didn't match. The fix aligns implementation with documentation.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
