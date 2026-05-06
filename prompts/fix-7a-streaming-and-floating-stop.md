# Quick fix — Phase 7a: assistant content disappears on `done`; redundant floating Stop button

Two issues in `src/components/ChatView.tsx`. Both small, both isolated, both shipping in one batch.

1. **Stale-closure bug.** Assistant prose streams in correctly but disappears the moment the SSE `done` event fires. The Message row is correctly persisted in the DB — reloading the page brings the prose back. The bug is purely client-side rendering state; the data is fine.

2. **Redundant Stop button.** A second Stop button floats over the streaming assistant message bubble (in addition to the Stop button next to the composer). The one near the composer is enough; the floating one is visual noise.

Re-read CLAUDE.md before starting. Disk-avoidance is unaffected.

---

## Issue 1: Stale-closure bug in `handleSend`

### Diagnosis (already done by QA)

`handleSend` in `ChatView.tsx` is async. It captures `streamingMsgId` (React state) from its closure at invocation time. Initial value: `null`.

Inside the same function, the `assistant_message_started` SSE event calls `setStreamingMsgId(<new id>)` to record which message is streaming. This **schedules** a React state update — it does not mutate the closure-captured local variable. The function continues executing with `streamingMsgId === null` in scope.

When the `done` event later runs:

```ts
setMessages((prev) =>
  prev.map((m) =>
    m.id === streamingMsgId ? { ...m, content: finalContent } : m,
  ),
);
```

`streamingMsgId` is still `null` (the original closure value). No row matches `m.id === null`. No row is updated. The assistant message stays at the empty `content: ''` it was created with when `assistant_message_started` pushed it onto the list.

Then `setStreamingMsgId(null)` removes the streaming overlay (the live-rendered streaming content). The now-empty assistant Message in the list renders as a blank bubble — visually, the prose disappears.

The same stale-closure read appears in the `case 'error'` branch and the outer `catch` block. All three need the fix.

### Fix

Capture the assistant message id in a function-scoped `let` at the top of `handleSend`. Set it inside the `assistant_message_started` case alongside the existing `setStreamingMsgId(...)` call. Use the local variable in the three places that need to identify the assistant row to update content on (done's `setMessages`, error's `setMessages`, catch's `setMessages`).

Skeleton:

```ts
async function handleSend() {
  // ... existing pre-fetch setup ...

  // Local capture for the assistant message id — sidesteps the closure issue
  // where setStreamingMsgId(...) schedules an update but doesn't mutate the
  // closure-captured `streamingMsgId` value.
  let assistantMsgId: string | null = null;

  try {
    // ... existing fetch + reader setup ...

    while (true) {
      // ... read chunk, parse SSE events ...

      switch (eventName) {
        case 'user_message_saved': {
          // ... existing ...
          break;
        }
        case 'assistant_message_started': {
          assistantMsgId = data.id as string;     // NEW: capture locally
          setStreamingMsgId(assistantMsgId);      // existing: state update for overlay rendering
          setMessages((prev) => [
            ...prev,
            { id: assistantMsgId!, /* ... empty content, etc. */ },
          ]);
          // ... existing setStreamingContent('') etc.
          break;
        }
        case 'token': {
          // ... existing setStreamingContent appender ...
          break;
        }
        case 'done': {
          if (assistantMsgId) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId ? { ...m, content: finalContent } : m,
              ),
            );
          }
          setStreamingMsgId(null);
          setStreamingContent('');
          // ... existing token counter update etc.
          break;
        }
        case 'error': {
          if (assistantMsgId) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, content: streamingContentSnapshot /* whatever local accumulator holds */ }
                  : m,
              ),
            );
          }
          setStreamingMsgId(null);
          setStreamingContent('');
          // ... existing toast / error display ...
          break;
        }
      }
    }
  } catch (err) {
    // Abort lands here. Persist whatever streamed so far to the bubble.
    if (assistantMsgId) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, content: streamingContentSnapshot /* whatever local accumulator holds */ }
            : m,
        ),
      );
    }
    setStreamingMsgId(null);
    setStreamingContent('');
    // ... existing error handling ...
  }
}
```

Three load-bearing things:

1. **`assistantMsgId` is declared with `let`, not `const`** — assignable on the `assistant_message_started` event.
2. **The state setters (`setStreamingMsgId(null)`, `setStreamingContent('')`) are unchanged.** Those don't have the closure problem; they're just clearing state, no read needed.
3. **The local accumulator that holds the full streamed content** (the variable that builds up via the `token` events; might already be named something like `streamingContentLocal` or similar) is what `done` and `error` and `catch` should write into the message's `content`. Use whatever local exists; if the existing code reads from React state (`streamingContent`) at those points, that's another stale-closure bug — switch to the local accumulator.

If `streamingContent` (the React state) is being read inside `done`/`error`/`catch` to compute `finalContent`, that's also the closure problem and needs the same fix: keep a `let streamingContentLocal = ''` accumulator at the top of `handleSend`, append to it inside the `token` case alongside the `setStreamingContent` call, and read from the local in the terminal cases. Verify by reading the existing implementation; fix if needed.

### Out of scope for Issue 1

- A broader refactor to use refs (`useRef`) for streaming state. Possible future cleanup; not this batch.
- Changes to the SSE event shape on the server.
- Changes to DB persistence (the row is already persisted correctly per QA).
- Visual treatment of the assistant bubble (typography, layout, etc.).
- Loading indicators, progress bars, or any other UI additions during streaming.

### Acceptance for Issue 1

- `grep -n "let assistantMsgId" src/components/ChatView.tsx` returns one match (the new local capture).
- `grep -n "m.id === streamingMsgId" src/components/ChatView.tsx` returns nothing — the stale read is gone from `done`, `error`, and `catch`.
- `grep -n "m.id === assistantMsgId" src/components/ChatView.tsx` returns three matches (or however many sites had the original stale read).
- `setStreamingMsgId` and `setStreamingContent` calls remain unchanged in their existing positions.
- The local accumulator pattern (if fixed) is consistent: write at `token`, read at `done`/`error`/`catch`.

Manual smoke test:

1. **Happy path.** Send a fresh message in a new chat. Watch prose stream in. Confirm prose **remains visible** after the `done` event fires (no flash-and-disappear). Send a follow-up directive in the same chat — confirm history shows both turns.
2. **Reload regression.** After step 1, reload the page. Confirm history still shows both turns and the rendered content matches what was visible before reload.
3. **Stop mid-stream.** Send a long directive. Tap Stop while still streaming. Confirm partial content remains visible in the bubble (exercises the `catch` path). Reload — confirm same partial content persists.
4. **Error path.** If practical, force an error mid-stream (kill Aphrodite, or set `WRITER_LLM_ENDPOINT` to a bad URL). Confirm partial content (if any) persists; error toast displays; UI recovers cleanly.

---

## Issue 2: Remove the floating Stop button over the streaming bubble

### Symptom

When an assistant message is streaming, two Stop buttons are visible:

1. A floating Stop button overlaid on (or below) the streaming message bubble.
2. A Stop button near the composer (where the Send button normally lives, swapped during streaming).

The composer-side Stop is sufficient. The floating one is redundant noise.

### Fix

Remove the floating Stop button from the streaming-bubble rendering. Keep the composer-side Stop unchanged.

Inside the message-rendering section of `ChatView.tsx`, find the streaming-message render path (the branch where the message is the one currently identified by `streamingMsgId`). Remove whatever JSX renders the floating Stop button. Likely shape:

```tsx
{isStreaming && (
  <button onClick={handleStop} className="...">
    <StopIcon /> Stop
  </button>
)}
```

Or possibly inside an absolute-positioned wrapper. Find and delete.

The `handleStop` function and its bindings stay — the composer-side Stop still uses it.

### Out of scope for Issue 2

- Changing the composer-side Stop button's position, color, label, or behavior.
- Adding a different streaming indicator (the existing blinking cursor in the bubble stays; that's not the floating button).
- Changing the disabled state of Send during streaming.
- Any other UI cleanup.

### Acceptance for Issue 2

- During streaming, only one Stop button is visible (the composer-side one).
- Tapping the composer-side Stop still aborts the stream and triggers the `catch` path.
- The blinking cursor (or whatever indicates streaming inside the bubble) stays.
- No regression in non-streaming UI.

Manual smoke test:

1. Send a message. While streaming, confirm only one Stop button is visible (next to the composer area). The streaming bubble has no Stop button overlaid.
2. Tap the composer-side Stop. Confirm the stream aborts; partial content persists per Issue 1's fix.
3. Send another message and let it complete normally. Confirm no UI artifact remains where the floating button used to be (no blank space, no leftover container).

---

## Combined acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- Both Issue 1 and Issue 2 acceptance items pass.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

---

## Documentation

No CLAUDE.md changes — both fixes are bug-fix-only, no architectural shift.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
