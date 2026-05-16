# Batch — Phase 7b followups: streaming display, edit UX, typography refresh

A bundle of UX issues from using 7b on the tablet. Five concerns:

1. **Incomplete final sentence visible during streaming.** Prose streams in word-by-word; the trailing fragment is mid-sentence and visually messy. Hide whatever follows the last sentence-ending punctuation until the next punctuation mark arrives (or the stream completes).
2. **Branch chevrons too small / too dark.** Barely visible on PC, unusable on tablet. Need to be larger, brighter, with proper tap targets.
3. **Edit textareas too small.** LLM responses are hundreds of words; the edit textarea is a few lines. Same for editing user prompts. Both need to scale to content.
4. **After editing assistant response, UI reverts to first branch.** Should stay on the new branch (the edit IS the new active branch).
5. **Typography for long-form on tablet.** Per-research best practices: bigger body text, more line height, cleaner font, double paragraph spacing, capped line length.

Re-read CLAUDE.md before starting. Disk-avoidance unaffected — pure UI changes.

All changes touch `ChatView.tsx` and `ChatMessage.tsx`. Bundling because they share styling primitives and one round of testing covers all five.

---

## Critical: tablet UX is the whole point of this batch

This batch exists because the chat surface didn't follow tablet-first principles tightly enough. Every fix below should be checked at tablet viewport (iPad-sized, ~1024px wide) before declaring done. The PC viewport is incidental — chat is for tablet use.

Tap targets ≥44px throughout. Confirm by inspection, not by hope.

---

## Required changes

### Issue 1 — Hide incomplete final sentence during streaming

**Symptom.** When prose streams in token-by-token, the visible end of the message is whatever fragment of a word/sentence has arrived so far. Looks messy: "She walked into the kitch" then "She walked into the kitche" then "She walked into the kitchen and" — visible word formation is distracting.

**Fix.** During streaming only (when `streamingMsgId === message.id`), find the last sentence-ending punctuation in the streamed content and only display up to that point. Show a small subtle indicator that more is coming.

In `ChatMessage.tsx`, add a `streamingIncomplete` mode. When the message is currently streaming:

```ts
function trimToLastCompleteSentence(text: string): string {
  // Sentence-ending: period, question mark, exclamation point, closing quote after punctuation
  // Match the LAST such terminator and trim everything after it
  const match = text.match(/^(.*[.!?…][\s"\u201D')]*)\s*\S*$/s);
  if (match) return match[1];
  // No complete sentence yet — show nothing (or a placeholder)
  return '';
}
```

Render logic:

```tsx
const isStreaming = streamingMsgId === message.id;
const displayContent = isStreaming
  ? trimToLastCompleteSentence(message.content) || message.content // fallback if no sentence ended yet, show partial so first sentence-in-progress is visible
  : message.content;

const hasIncomplete = isStreaming && displayContent.length < message.content.length;
```

Render `displayContent` through the existing markdown + dialogue pipeline. After it, if `hasIncomplete`, render a subtle pulsing indicator (existing blinking cursor `▊` style, dimmer):

```tsx
{hasIncomplete && (
  <span className="text-zinc-500 animate-pulse ml-1" aria-label="Writing">▊</span>
)}
```

Important nuances:

- The fallback (`|| message.content`) handles the very early streaming state where no full sentence has arrived yet. Without it, the message bubble would be empty for several seconds. With it, the partial first sentence shows until the first terminator arrives, then snap-trims to the complete portion. Acceptable UX.
- On `done` event, `isStreaming` becomes false, full content renders. Final fragment (if any) becomes visible. This is correct — the model deliberately stopped there.
- The trim regex handles dialogue: `She said, "I'm leaving."` ends correctly. The `\S*$` at the end captures any trailing word-fragment.
- Edge case: model emits no sentence-ending punctuation at all (rare in prose, common in code blocks). The fallback shows full content; not ideal but not broken.

Don't apply this trim during the markdown re-render debounce optimization — apply it at the final render step on the trimmed string. This means markdown re-parses on the trimmed content during streaming, which means slightly less work per token (shorter strings to parse). Bonus.

### Issue 2 — Branch chevrons: bigger, brighter, real tap targets

**Symptom.** Currently small, dark, hard to see on PC, unusable on tablet.

**Fix.** Redesign the chevron group as a proper tablet-grade control:

```tsx
{message.branchCount > 1 && (
  <div className="flex items-center gap-2 mb-3" role="group" aria-label="Branch navigation">
    <button
      onClick={handlePrevBranch}
      disabled={message.branchPosition <= 1}
      className="min-h-12 min-w-12 flex items-center justify-center rounded-lg
                 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600
                 disabled:opacity-30 disabled:cursor-not-allowed
                 text-zinc-100 transition-colors"
      aria-label="Previous branch"
    >
      <ChevronLeft className="w-6 h-6" />
    </button>
    <span className="text-sm font-medium text-zinc-300 min-w-12 text-center tabular-nums">
      {message.branchPosition} / {message.branchCount}
    </span>
    <button
      onClick={handleNextBranch}
      disabled={message.branchPosition >= message.branchCount}
      className="min-h-12 min-w-12 flex items-center justify-center rounded-lg
                 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600
                 disabled:opacity-30 disabled:cursor-not-allowed
                 text-zinc-100 transition-colors"
      aria-label="Next branch"
    >
      <ChevronRight className="w-6 h-6" />
    </button>
  </div>
)}
```

Key changes from the 7b shipping version:
- 48px tap targets (min-h-12 min-w-12)
- Solid background (zinc-800) so chevrons are clearly visible against the message bubble
- Higher contrast text (zinc-100 not zinc-400)
- Clear disabled state via opacity, not invisibility
- 24px chevron icons (w-6 h-6) — large enough to read
- Tabular numerals on the counter so it doesn't shift width as branches multiply
- Use `lucide-react` icons (already in the project, per the existing imports)

If `lucide-react` isn't available or the project uses a different icon library, substitute with whatever's already imported. Don't introduce a new dependency.

### Issue 3 — Edit textareas: scale to content

**Symptom.** Edit textareas are tiny (likely default browser sizing or a fixed `rows={3}` or similar). Long content needs a tall textarea or it's miserable to edit.

**Fix.** Two parts:

#### Part 3a — Auto-grow on content

Use a textarea that grows with content. Either install `react-textarea-autosize` if not already in the project, or implement inline:

```tsx
import { useRef, useEffect } from 'react';

function AutoGrowTextarea({ value, onChange, minRows = 6, maxRows = 30, ...props }: ...) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseInt(getComputedStyle(el).lineHeight, 10) || 24;
    const minHeight = lineHeight * minRows;
    const maxHeight = lineHeight * maxRows;
    const newHeight = Math.max(minHeight, Math.min(maxHeight, el.scrollHeight));
    el.style.height = `${newHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, minRows, maxRows]);

  return <textarea ref={ref} value={value} onChange={onChange} {...props} />;
}
```

#### Part 3b — Apply with sensible defaults

User message edit: `minRows={4}`, `maxRows={20}`. User directives are typically 1-3 lines but can be longer.

Assistant message edit: `minRows={12}`, `maxRows={40}`. Assistant prose is typically 200-800 words; needs serious vertical space.

Both use the same body typography as the rendered message (Issue 5) — same font, same size, same line-height. Editing should feel continuous with reading.

```tsx
<AutoGrowTextarea
  value={editedContent}
  onChange={(e) => setEditedContent(e.target.value)}
  minRows={message.role === 'assistant' ? 12 : 4}
  maxRows={message.role === 'assistant' ? 40 : 20}
  className="prose-textarea w-full p-4 bg-zinc-900 border-2 border-zinc-700
             rounded-lg focus:border-violet-500 focus:outline-none
             text-zinc-100 leading-relaxed resize-none"
  autoFocus
/>
```

The `prose-textarea` class applies the same font/size as rendered prose (defined in Issue 5).

`resize-none` because the auto-grow handles sizing; manual resize would fight it.

### Issue 4 — Branch persistence after assistant edit

**Symptom.** Editing an assistant message creates a new branch (correct per 7b), but after the edit completes the UI shows branch index 0 instead of the new one.

**Diagnosis.** The PATCH for assistant edit:
1. Creates a new sibling Message
2. Updates `Chat.activeBranchesJson` to point at the new branch index
3. Returns the updated chat

But the client likely refetches the chat AND maintains its own local branch state, and the local state isn't being updated to match the server's new `activeBranchesJson`.

**Fix.** When the PATCH response comes back, the client should:
1. Update its local `chat` state from the response (which includes the new `activeBranchesJson`)
2. Re-run `resolveActivePath` against the updated state
3. Render the new active path — which now ends at the edited branch

Find the assistant-edit save handler in `ChatView.tsx`. After the PATCH succeeds and the response is parsed:

```ts
async function handleSaveAssistantEdit(messageId: string, newContent: string) {
  const res = await fetch(`/api/chats/${chatId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: newContent }),
  });
  if (!res.ok) {
    // ... error handling
    return;
  }
  const data = await res.json() as { newMessage: MessageRecord; chat: ChatRecord };

  // Update LOCAL state from server response — this is the load-bearing fix
  setChat(data.chat);
  setMessages([...messages, data.newMessage]);
  // Or simpler: refetch the whole chat
  // await loadChat();

  setEditingMessageId(null); // exit edit mode
}
```

The simpler fix: after a successful PATCH, refetch the full chat. The 7b prompt mentioned refetch as the standard pattern; verify it's actually being called here.

Common bug shape: the handler updates `messages` locally (appending the new branch) but doesn't update `chat.activeBranchesJson`. When `resolveActivePath` runs against `messages + chat.activeBranchesJson`, it walks the tree using the OLD activeBranches map — which has no entry for the newly-edited parent, defaulting to branch 0 (the original). The new branch (with higher branchIndex) is correct in the data but the renderer skips past it.

The fix is making sure both `messages` AND `chat.activeBranchesJson` update in lockstep from the PATCH response. Simplest path: refetch the chat from `/api/chats/[id]`.

The same bug likely affects the regenerate flow (where regeneration creates a new branch and should auto-switch to it). Verify by inspection; if regenerate doesn't refetch the chat afterward, fix it the same way.

### Issue 5 — Typography refresh per tablet research

Best practices from typography research and tablet-specific UX guides converge on:

| Property | Value | Source |
|---|---|---|
| Body font | Merriweather (serif, designed for screens) or Charter | USWDS, on-screen reading optimization |
| Body size | 18-20px (1.125-1.25rem) | Medium / publishing platforms; tablet sustained reading |
| Line height | 1.6-1.7 | WCAG 2.2 SC 1.4.12 floor is 1.5; 1.6+ for long-form |
| Line length | 50-75 characters, 65 ideal | Bringhurst; eye-tracking studies |
| Paragraph spacing | 2em (per user request: "double space") | User explicit; matches modern long-form best practice |
| Color | High contrast: zinc-100 on zinc-950 | WCAG AAA |
| Single-column, left-aligned | — | USWDS, accessibility |

#### Part 5a — Add Merriweather

Use `@fontsource/merriweather` (NPM package, self-hosted, no Google Fonts request at runtime). If `@fontsource/*` isn't already in the project, install it:

```bash
npm install @fontsource/merriweather
```

In `src/app/layout.tsx` (or wherever fonts are imported), add:

```ts
import '@fontsource/merriweather/400.css';
import '@fontsource/merriweather/700.css';
import '@fontsource/merriweather/400-italic.css';
```

If the project already uses a different font infrastructure (Next.js's `next/font` with Google Fonts, Tailwind's font-family stack, etc.), match that pattern instead. The end goal: `font-family: 'Merriweather', Georgia, serif;` available in CSS for the chat prose.

If self-hosting via @fontsource conflicts with the project's existing font setup, fall back to: `font-family: Charter, 'Iowan Old Style', 'Sitka Text', Cambria, Georgia, serif;` — system font stack. Charter is on most Apple devices; the rest are reasonable fallbacks. No external font load needed.

#### Part 5b — Define a chat-prose typography class

In the project's stylesheet (`src/app/globals.css` or wherever app-wide CSS lives), define:

```css
.chat-prose {
  font-family: 'Merriweather', Charter, 'Iowan Old Style', Cambria, Georgia, serif;
  font-size: 1.1875rem;        /* 19px */
  line-height: 1.65;
  color: rgb(244 244 245);      /* zinc-100 */
  max-width: 66ch;              /* line length cap */
}

.chat-prose p {
  margin-bottom: 2em;           /* user-requested double space */
}

.chat-prose p:last-child {
  margin-bottom: 0;
}

.chat-prose .dialogue {
  color: rgb(196 181 253);      /* violet-300, existing dialogue color */
}

.chat-prose em {
  font-style: italic;
}

.chat-prose strong {
  font-weight: 700;
}

/* Used by the edit textarea so editing matches reading typography */
.prose-textarea {
  font-family: 'Merriweather', Charter, 'Iowan Old Style', Cambria, Georgia, serif;
  font-size: 1.1875rem;
  line-height: 1.65;
}
```

Apply `chat-prose` to the rendered assistant message body in `ChatMessage.tsx`. The wrapper around markdown output:

```tsx
<div className="chat-prose">
  {/* markdown render output here */}
</div>
```

The `max-width: 66ch` keeps lines comfortable — wider viewports don't produce 200-character lines.

#### Part 5c — User messages keep their compact style

User messages (the directives) are scaffolding, not prose. Keep them small and dim:

```css
.chat-directive {
  font-family: ui-sans-serif, system-ui, sans-serif;  /* sans, distinct from prose */
  font-size: 0.875rem;          /* 14px — smaller than prose */
  line-height: 1.5;
  color: rgb(161 161 170);      /* zinc-400 — dim */
  font-style: italic;
}
```

The visual contrast between directive (small sans italic) and prose (larger serif regular) reinforces the asymmetric mental model: user gives directives, assistant produces prose.

#### Part 5d — Compose the chat layout

The message list container should center the chat-prose width nicely on wide viewports:

```css
.chat-message-list {
  max-width: 66ch;
  margin: 0 auto;
  padding: 1rem;
}
```

If the existing layout has constraints (sidebar, etc.), adapt — the goal is the prose itself is capped at 66ch, however that's achieved.

### Part 6 — Verify markdown rendering

The dialogue heuristic and `<think>` collapse from 7a should still work. The new typography just changes font/size/spacing; the markdown pipeline is unchanged.

After the typography refresh:
- Italic prose (`*emphasis*`) renders italic in Merriweather italic — visually distinct from regular
- Bold (`**strong**`) renders bold
- Dialogue spans render in violet-300 against the zinc-100 prose body — still distinct, still readable
- `<think>` collapse renders in monospace (existing styling), distinct from prose

Run through these visually after the typography lands.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- During streaming, assistant message content is trimmed to the last sentence-ending punctuation (with a subtle indicator that more is coming).
- Branch chevrons render as 48px tap targets with high-contrast styling.
- Edit textareas auto-grow with content; assistant edits start at ~12 rows, user edits at ~4 rows.
- After editing an assistant message, the displayed branch is the new edited branch (not branch 0).
- Chat prose renders in Merriweather (or Charter fallback) at 19px / line-height 1.65 / 66ch max-width.
- Paragraphs in prose have 2em bottom margin.
- User directives render in small sans serif italic, distinct from assistant prose.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — TABLET, not PC):

1. **Streaming display.** Send a directive. Watch streaming. Confirm the visible end of the message stops at sentence-ending punctuation; trailing fragment hides until the next punctuation arrives. Once `done` fires, the full content (including any fragment if the model stopped mid-sentence) is visible.
2. **Branch chevrons visibility.** In a chat with multiple branches, confirm chevrons are clearly visible without squinting. Tap each chevron — confirm the tap target feels comfortable on tablet (no precise stylus-tap needed).
3. **Branch chevrons disabled state.** When at branch 1 of 3, confirm the left chevron looks disabled but is still visible. Tap it; nothing happens.
4. **User message edit textarea.** Tap edit on a user directive. Confirm the textarea is at least 4 rows tall by default. Type or paste a long directive — confirm it grows with content up to the max.
5. **Assistant message edit textarea.** Tap edit on an assistant message containing 500+ words of prose. Confirm the textarea opens at ~12 rows tall. The full content is comfortably visible, not crammed into a tiny box. Type more — grows. Paste a 2000-word block — grows to the max, then scrolls.
6. **Edit + save: branch persistence.** Edit an assistant message, save (without continue). Confirm the displayed message immediately becomes the new edited content (NOT the original). Reload the page; confirm the edited branch is still active.
7. **Edit + Save & continue: branch persistence.** Same flow but with Save & continue. Confirm the streamed continuation appends to the edit. Reload; confirm the edit+continuation branch is active.
8. **Regenerate: branch persistence.** Regenerate an assistant message. Confirm the new branch is active immediately, not the old branch 0.
9. **Typography read-test.** Open a chat with several long assistant messages. Sit at tablet reading distance. Read for 60 seconds. Confirm:
   - Text is comfortable to read at distance (not squinting)
   - Lines don't run too long across the screen
   - Paragraph breaks are clearly visible
   - Italics and bold render with appropriate emphasis
   - Dialogue is visibly highlighted (violet) without being garish
10. **User directive contrast.** Confirm user directives (sans serif, small, italic, dim) are visually distinct from assistant prose. The reader should be able to scan the page and immediately see "this is what I said" vs "this is the story."
11. **Markdown smoke.** Confirm `*emphasis*` renders italic, `**strong**` renders bold, code blocks render in monospace.
12. **Dialogue heuristic.** Confirm `"quoted text"` in prose renders in violet, distinct from surrounding text.
13. **Disk-avoidance regression.** Generate an image and a video in Studio. Confirm `ssh <gpu-vm> ls /models/ComfyUI/output/*.png 2>&1` returns "no such file."

---

## Out of scope

- Per-user font preference / size adjustment. Default is the only mode for now.
- Light mode. Loom is dark-only.
- A reading-mode toggle that hides the composer to maximize prose space. Possible future improvement; not this batch.
- Highlighting the currently-streaming token in a special color. The blinking indicator at end is enough.
- Text-to-speech / read-aloud. Out of scope.
- Adjustable line-height in settings. Default is the only mode.
- Different fonts for different chats. One typography system for all chats.
- Animations on branch transitions. Snap-render is fine.
- Showing branch metadata (date created, token count) on hover. Out of scope.
- Optimizing markdown re-render performance during streaming beyond what 7a established. The trim-to-last-sentence change actually helps perf (shorter strings to parse per token).
- Image embedding within prose. 7c handles characters; 7d may extend; not this batch.
- Scroll-to-streaming-message logic changes. Existing behavior fine.

---

## Documentation

In CLAUDE.md, under the existing Phase 7b section, add:

> **Typography.** Chat prose uses Merriweather (self-hosted via @fontsource) at 19px / line-height 1.65 / max-width 66ch / paragraph margin 2em — tablet long-form best practices per WCAG 2.2 SC 1.4.12 and Bringhurst's measure rule. User directives render in small sans-serif italic to visually distinguish scaffolding from prose. The chat-prose class lives in globals.css; the prose-textarea class matches it for in-place editing.

> **Streaming display.** During token streaming, assistant message content is trimmed to the last sentence-ending punctuation; trailing fragment hides until the next terminator arrives or `done` fires. Reduces visual jitter from word-by-word formation; markdown re-parse runs on the trimmed string for free perf win.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
