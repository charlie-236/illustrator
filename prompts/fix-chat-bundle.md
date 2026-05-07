# Batch — Chat fixes bundle (10 issues from tablet QA)

A bundle of ten chat-surface issues from real-world tablet use. All touch `ChatView.tsx` and/or `ChatMessage.tsx`. Bundling because the surfaces overlap and one round of testing covers everything.

The order in this prompt reflects implementation priority — bugs first (streaming regression, edit-doesn't-rerun, stop tokens), then missing features (stop pre-token, delete responses), then UX (typography, sizing, no-warning).

Re-read CLAUDE.md before starting. Disk-avoidance unaffected.

---

## Critical: tablet UX is the recurring theme

The recurring complaint across these issues is that the chat surface keeps shipping with PC-comfortable controls that don't translate to tablet. The fix isn't just "make it bigger" — every interactive element this batch touches needs ≥44px tap targets and high-contrast styling. Verify at tablet viewport before declaring done.

---

## Required changes

### Issue 14 — Streaming regression (URGENT — diagnose first)

**Symptom.** Response no longer streams in token-by-token. Waits for entire response, then displays all at once.

**Diagnostic.** Recent changes that could plausibly cause this:
- The trim-to-last-sentence display change in `fix-7b-display-and-typography.md`. The fallback (`|| message.content`) was meant to preserve streaming visibility before any sentence-ending punctuation arrives. If the agent implemented the trim without the fallback, streaming would appear to "wait" until the first complete sentence.
- The shared `consumeChatStream` helper introduced in 7b. If callbacks aren't firing per-token, streaming wouldn't render.
- React batching changes — if `setStreamingContent` updates are batched too aggressively, the UI doesn't reflect token arrivals.

**Fix.** Read the current implementation of `ChatView.tsx` and `ChatMessage.tsx`. Verify in this order:

1. Open Network tab in browser dev tools. Send a message. Confirm the SSE stream is delivering token events with content. If yes, the bug is client-side (rendering); if no, the bug is server-side (Aphrodite call shape).
2. If client-side: confirm `setStreamingContent` is being called per-token (add a brief `console.log` to verify). If not called, the stream consumer is broken.
3. If `setStreamingContent` IS called but the UI doesn't update: check the `displayContent` computation in `ChatMessage.tsx`. The trim-to-last-sentence may be returning empty for in-progress sentences. The fallback should be:

```ts
const displayContent = isStreaming
  ? (trimToLastCompleteSentence(message.content) || message.content)
  : message.content;
```

The `|| message.content` is critical — without it, an in-progress first sentence renders as empty. With it, the partial content renders until the first sentence terminator arrives, then snaps to the trimmed version. If the agent has only the trimmed version (no fallback), streaming will appear stalled.

4. If the streaming consumer in `consumeChatStream` only fires its `onToken` callback after stream completion, that's the bug — token events should fire as they arrive.

Fix whichever of the above is broken. Acceptance: tokens arrive visibly during streaming on tablet.

### Issue 13 — Strip stop tokens from displayed/persisted content

**Symptom.** `<|im_end|>` and similar stop tokens appear in LLM responses.

**Diagnostic.** Aphrodite should strip stop tokens before emitting, but doesn't always. Some templates include them in the chat completion output. We need a defensive strip on the server side.

**Fix.** In `src/app/api/chats/[id]/send/route.ts` (and the regenerate / continue routes), accumulate the raw streamed content as today, but apply a stop-token strip before:
- Persisting the final content to the Message row
- Emitting the `done` SSE event with `content`

Strip pattern:

```ts
const STOP_TOKEN_PATTERNS = [
  /<\|im_end\|>/g,
  /<\|endoftext\|>/g,
  /<\|eot_id\|>/g,
  /<\|im_start\|>/g,
  /\[INST\]/g,
  /\[\/INST\]/g,
  /<s>/g,
  /<\/s>/g,
];

function stripStopTokens(text: string): string {
  let cleaned = text;
  for (const pattern of STOP_TOKEN_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.trim();
}
```

Apply at the same point where the final `content` is computed. Don't strip during the streaming `token` events — only strip on the final `done` (and on persistence). The streaming display will briefly show the token as it arrives, then snap to the stripped version on `done`. Acceptable.

If you want to also strip during streaming for cleaner display: apply the strip to `accumulator` before each `setStreamingContent` call. Slightly more work per token but visually cleaner. Either approach is acceptable.

### Issue 11 — Edit prompt should auto-regenerate

**Symptom.** After editing a user prompt and saving, nothing happens. No new response generated.

**Background.** Original 7b spec said: edit user message → hard truncate → user manually sends new directive. Changing this: edit user message → hard truncate → automatically regenerate from the edited prompt.

**Fix.** In `src/app/api/chats/[id]/messages/[msgId]/route.ts`, the PATCH handler for user messages currently truncates and updates. Change semantics: after the truncate-and-update, the response is the same shape as Issue's regenerate route — it streams a new assistant response based on the edited prompt.

Server flow:

1. Validate input.
2. Confirm message is a user message.
3. Hard truncate descendants (existing logic).
4. Update the user message's content (existing logic).
5. **Build the message context** — active path from root to the edited message inclusive.
6. **Stream a new assistant response** from Aphrodite, using the same SSE pattern as `/send` and `/regenerate`. Create a new assistant Message row as a child of the edited user message.
7. On done, persist the assistant content. Update `chat.activeBranchesJson` if needed (probably not — new branch is index 0 since previous descendants are deleted).

The response shape is now SSE (not JSON). Update the client handler in `ChatView.tsx` to consume the SSE stream the same way it consumes `/send` and `/regenerate`.

The chain: user edits prompt → confirms (after Issue 10 removes the warning, this is just save) → server truncates + updates + streams new response → client renders streaming → done.

### Issue 12 — Delete LLM responses

**Symptom.** No way to delete an assistant response from the UI.

**Fix.** Add a Delete button to assistant message actions, alongside Edit and Regenerate.

Server side: add DELETE handler at `src/app/api/chats/[id]/messages/[msgId]/route.ts`:

```ts
export async function DELETE(req, { params }) {
  // ... resolve params ...
  // Fetch the message; confirm it belongs to this chat
  // Cascade delete the message AND all its descendants (any branches downstream)
  // Update activeBranchesJson to remove entries for parents that no longer have descendants
  // Return updated chat
}
```

Cascade behavior: deleting a message also deletes all its descendants on every branch. This is destructive — confirm via dialog client-side ("Delete this message and everything after it?").

If the deleted message has siblings (branches), deletion behavior:
- If this is the active branch: switch active to branchIndex 0 of the remaining siblings (lowest remaining), OR the leftmost remaining.
- If no siblings remain at this parent: the parent's active descendant chain just ends.

Client side: in `ChatMessage.tsx`'s assistant action row, add Delete button next to Edit/Regenerate/Continue. Tap → confirm dialog → DELETE → refetch chat.

Confirm dialog wording: "Delete this response? Any messages after it will also be deleted."

Visual treatment: red destructive icon (trash), distinct from the other action buttons.

### Issue 6 — Stop button works before first token

**Symptom.** Stop button is disabled or non-functional until streaming actually begins. User can't cancel a slow-starting request.

**Fix.** The Stop button should be enabled the moment the request starts (i.e., as soon as `handleSend` POSTs to the route). Currently it's likely gated on `streamingMsgId !== null` — which only becomes truthy when the `assistant_message_started` event arrives.

Track an additional state: `isRequestInFlight` (or similar). Set true when the fetch begins; set false on `done`, `error`, or abort.

```ts
const [isRequestInFlight, setIsRequestInFlight] = useState(false);
const abortControllerRef = useRef<AbortController | null>(null);

async function handleSend() {
  setIsRequestInFlight(true);
  abortControllerRef.current = new AbortController();
  try {
    const res = await fetch('/api/chats/[id]/send', {
      // ...
      signal: abortControllerRef.current.signal,
    });
    // ... stream handling
  } finally {
    setIsRequestInFlight(false);
    abortControllerRef.current = null;
  }
}

function handleStop() {
  abortControllerRef.current?.abort();
}
```

Show Stop button when `isRequestInFlight === true`, NOT when `streamingMsgId !== null`. The two are different — request can be in flight before tokens arrive (network latency, model load).

Server side: when the request is aborted before any tokens have been emitted, the user message is still persisted (existing 7a behavior). No assistant message exists yet (since `assistant_message_started` never fired). On the client, the user bubble shows; no assistant bubble appears. User can re-send.

If the abort happens after `assistant_message_started` but before any tokens: the assistant message exists with empty content. Persist as-is (existing behavior). Renders as empty bubble — UI handles this gracefully (already does post-7a-fix).

### Issue 10 — Remove warning on prompt edit

**Symptom.** Editing a user prompt shows a confirm dialog warning that descendants will be deleted. User finds this friction.

**Fix.** Remove the confirm dialog. Save action on user-message edit goes directly to the truncate-and-regenerate flow.

In `ChatMessage.tsx`'s user-message edit handler, find the confirm dialog. Delete it. Save button calls the PATCH handler directly.

Risk: user accidentally edits and loses downstream content. Acceptable per user's preference. The branching system means destructive actions are rare in practice (regenerate creates branches, doesn't destroy); user-edit truncate is the one explicit destructive case, and the user has explicitly opted into "no warning."

### Issue 7 — Larger prompt editor (user-message edit textarea)

**Symptom.** When editing a user prompt, the textarea is small even after the prior fix-7b-display batch. Looking at the screenshot, the textarea displays ~25 lines but the rows feel crammed.

**Fix.** Bump user-message edit textarea sizing. The prior batch specified `minRows={4}, maxRows={20}` for user edits. Increase to `minRows={8}, maxRows={40}`.

Also verify the `prose-textarea` class is being applied (matching the Merriweather typography of the rendered prose). If the screenshot shows small/condensed text in the textarea, the styling didn't land.

In `ChatMessage.tsx`'s user-edit textarea:

```tsx
<AutoGrowTextarea
  value={editedContent}
  onChange={(e) => setEditedContent(e.target.value)}
  minRows={8}
  maxRows={40}
  className="prose-textarea w-full p-4 bg-zinc-900 border-2 border-zinc-700
             rounded-lg focus:border-violet-500 focus:outline-none
             text-zinc-100 leading-relaxed resize-none"
  autoFocus
/>
```

Same sizing for assistant edits stays at the larger `minRows={12}, maxRows={50}` from the prior batch.

### Issue 8 — Prompt history typography

**Symptom.** User prompts in the chat history render as small dim italic sans-serif. Hard to read on tablet.

**Background.** I previously scoped user messages as "scaffolding, not prose" with deliberately compact styling. User feedback contradicts that framing — when scrolling through chat history, user prompts ARE part of the read flow.

**Fix.** Unify typography. User and assistant messages use the same Merriweather font and similar sizing. Distinguish by background color and alignment, not by font/size.

In `globals.css`, replace the existing `.chat-directive` class:

```css
.chat-directive {
  font-family: 'Merriweather', Charter, 'Iowan Old Style', Cambria, Georgia, serif;
  font-size: 1.0625rem;        /* 17px — slightly smaller than prose's 19px */
  line-height: 1.65;
  color: rgb(228 228 231);      /* zinc-200 — clearly readable but slightly dimmer */
  font-style: normal;           /* not italic */
  max-width: 66ch;
}

.chat-directive p {
  margin-bottom: 1.5em;
}
```

In `ChatMessage.tsx`, the user message bubble uses `.chat-directive`. Visual distinction from prose comes from:
- Distinct background color (e.g., `bg-zinc-800/50` — subtle but present)
- Slightly different padding or border treatment
- Right-alignment (current behavior — keeps it visually distinct from prose)
- Optional small "you said:" prefix or icon

The goal: scanning the chat, you can immediately tell user vs assistant messages, but reading them isn't an exercise in eye strain.

### Issue 9 — Larger Edit / Regenerate / Delete buttons

**Symptom.** Per the screenshot (PromptResponseButtons.png with yellow circles), the per-message action buttons (Edit, Regenerate, etc.) are small and dark. Same problem the prior batch fixed for branch chevrons — that fix didn't propagate to the action buttons.

**Fix.** Apply the same treatment from the branch-chevron fix to all per-message action buttons. In `ChatMessage.tsx`:

```tsx
<div className="flex items-center gap-2 mt-3" role="group" aria-label="Message actions">
  <button
    onClick={handleEdit}
    className="min-h-12 min-w-12 flex items-center justify-center rounded-lg
               bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600
               text-zinc-100 transition-colors"
    aria-label="Edit message"
  >
    <Pencil className="w-5 h-5" />
  </button>

  {message.role === 'assistant' && (
    <>
      <button
        onClick={handleRegenerate}
        className="min-h-12 min-w-12 flex items-center justify-center rounded-lg
                   bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600
                   text-zinc-100 transition-colors"
        aria-label="Regenerate response"
      >
        <RotateCw className="w-5 h-5" />
      </button>

      <button
        onClick={handleDelete}
        className="min-h-12 min-w-12 flex items-center justify-center rounded-lg
                   bg-zinc-800 hover:bg-zinc-700 active:bg-red-900/50
                   text-zinc-100 hover:text-red-400 transition-colors"
        aria-label="Delete response"
      >
        <Trash2 className="w-5 h-5" />
      </button>
    </>
  )}
</div>
```

Match the styling of the branch chevrons (same backgrounds, same hover states, same sizing). The Delete button picks up a red hover state since it's destructive.

### Issue 18 — Wasted side space on tablet

**Symptom.** Chat surface leaves significant horizontal space empty at tablet widths (Galaxy Tab A9+ in landscape ≈ 1340×800).

**Fix.** Make the chat-prose width responsive instead of a hard 66ch cap:

```css
.chat-prose {
  font-family: 'Merriweather', Charter, 'Iowan Old Style', Cambria, Georgia, serif;
  font-size: 1.1875rem;        /* 19px */
  line-height: 1.65;
  color: rgb(244 244 245);
  max-width: min(85ch, 100%);
}

@media (max-width: 768px) {
  .chat-prose {
    font-size: 1.0625rem;        /* 17px on small phones — narrower viewport */
    max-width: 100%;
  }
}

@media (min-width: 1280px) {
  .chat-prose {
    font-size: 1.25rem;          /* 20px on wide screens */
    line-height: 1.7;             /* longer lines need more line-height */
  }
}
```

The `max-width: min(85ch, 100%)` allows up to 85 characters at large screens (within the typographic range when paired with line-height 1.7) but caps at viewport width on narrow screens. Pair with the existing `.chat-message-list` container that centers the prose with reasonable side padding.

The line length expansion from 66ch → 85ch is intentional — narrower line lengths leave too much wasted horizontal space on landscape tablets; wider lines paired with more line-height stay readable.

The container holding the message list:

```css
.chat-message-list {
  width: 100%;
  max-width: min(85ch, 100%);
  margin: 0 auto;
  padding: 1rem clamp(1rem, 4vw, 2.5rem);
}
```

`clamp(1rem, 4vw, 2.5rem)` gives 16px padding on narrow phones, scales up to 40px on wide tablets, capped at 40px so it doesn't get crazy on desktop. Result: phone fills the screen; tablet has comfortable padding; desktop centers without excess.

The composer at the bottom should match the same width constraints — same max-width, same centering.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- Streaming visibly progresses token-by-token during response generation.
- Stop tokens (`<|im_end|>`, etc.) do not appear in displayed or persisted content.
- Editing a user message + saving streams a new assistant response automatically (no manual re-send).
- Assistant messages have a Delete button. Tapping it confirms then deletes.
- Stop button works the moment Send is tapped (before any tokens arrive).
- No confirm dialog appears when saving a user-message edit.
- User-message edit textarea is at least 8 rows tall by default and auto-grows.
- User prompts in the chat history render in Merriweather at ~17px, distinct from assistant prose by background/alignment, not by tiny size.
- Per-message action buttons (Edit, Regenerate, Delete) are 48px tap targets with high-contrast styling.
- Chat prose width responsively scales from 100% on phones to 85ch on wide tablets.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — TABLET):

1. **Streaming.** Send a directive. Confirm tokens visibly arrive over time, not all at once at end.
2. **Stop tokens.** Send a directive. After response completes, search the rendered text for `<|`. Should be absent. Check the DB row directly — also absent.
3. **Edit user prompt.** Tap Edit on a user prompt. No warning appears. Modify content, Save. New assistant response automatically streams.
4. **Delete assistant response.** Tap Delete on an assistant message. Confirm dialog appears with clear language. Confirm. Message + descendants deleted. Conversation truncates.
5. **Stop pre-token.** Send a directive. Tap Stop within 1 second (before any tokens arrive). Confirm: request aborts cleanly, user message is still persisted, no assistant message appears, composer re-enables.
6. **Stop mid-stream.** Send a directive; tap Stop after a few tokens have arrived. Partial content persists in assistant bubble.
7. **User edit textarea size.** Tap Edit on a long user prompt. Confirm textarea opens at ~8 rows minimum and grows with content.
8. **Prompt history typography.** Scroll through a chat with several turns. User prompts should be readable at tablet distance (not tiny). Distinct from assistant prose visually but comparable typography.
9. **Action buttons.** Tap each button (Edit, Regenerate, Delete) on tablet. Tap targets feel comfortable; no precise tapping required.
10. **Width on landscape tablet.** Open chat on Galaxy Tab A9+ in landscape. Confirm prose fills available width comfortably (no large empty side margins).
11. **Width on portrait phone.** Same chat in portrait. Confirm prose fills width without overflowing.
12. **Disk-avoidance regression.** Generate an image and a video. Confirm `ssh <gpu-vm> ls /models/ComfyUI/output/*.png 2>&1` returns "no such file."

---

## Out of scope

- Adding a "stop and discard" option (vs current "stop and keep partial"). Current keep-partial is correct.
- Adding undo for delete operations.
- Animating message deletion.
- Customizable typography (per-user font/size preferences).
- Right-to-left layout support.
- Scroll-to-message after edit-regenerate (existing scroll-to-bottom is fine).
- Per-chat width preferences.

---

## Documentation

In CLAUDE.md, under the existing Phase 7b section, add a "Followup fixes" subsection summarizing the behavior changes:

> **User-message edit auto-regenerates.** Editing a user prompt and saving now triggers immediate streaming of a new assistant response. Original 7b spec required manual re-send; revised based on use feedback.
>
> **Assistant-message delete cascades.** Deleting an assistant message removes it and all descendants on every branch.
>
> **Stop button works pre-token.** Tracking `isRequestInFlight` separately from `streamingMsgId` means Stop is reachable from the moment Send fires.
>
> **Stop tokens stripped server-side.** `<|im_end|>` and similar are stripped before persistence and emission via a defensive regex pass in the `done` handling of send/regenerate/edit-and-continue routes.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
