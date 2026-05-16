# Quick fix — Chat surface UX (3 issues)

Three chat-surface UX issues. Two are corrections to my previous specs; one is a real layout bug.

1. **Auto-scroll during streaming is wrong.** Text arrives faster than the user can read; auto-scrolling away from where they're reading is annoying. Should not auto-scroll at all.
2. **First message hidden, scrollbar can't reach it.** Layout bug — there's vertical space at the top of the message list that prevents scrolling to the very first message.
3. **Side margins still too large.** The 85ch cap from the prior batch isn't enough on Galaxy Tab A9+ landscape; user wants the chat to fill more of the available width.

Re-read CLAUDE.md before starting. Disk-avoidance unaffected.

---

## Required changes

### Issue 1 — Remove auto-scroll during streaming

**Symptom.** As tokens stream in, the chat scrolls to keep the latest content in view. User can't read what was already there because the viewport keeps moving.

**Background.** My prior 7a prompt explicitly specified auto-scroll-to-bottom behavior with a "freeze if user scrolls up" override. Reversing that decision: don't auto-scroll AT ALL during streaming. The user controls scroll position entirely.

**Fix.** Remove the auto-scroll behavior in `ChatView.tsx`. Find the scroll-management code (likely a `useEffect` watching message updates or token arrivals that calls `scrollIntoView` or similar). Delete it.

**Keep one specific scroll behavior:** when the user sends a NEW message (not during streaming, but at the moment of submission), scroll to the bottom so they can see their just-sent message and the response forming. This is a one-shot scroll, not an ongoing follow.

```ts
async function handleSend() {
  // ... existing setup ...
  setIsRequestInFlight(true);

  // ONE-SHOT scroll to bottom at send time
  // (User just submitted; they want to see their message + incoming response)
  setTimeout(() => {
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, 50); // Slight delay so the new message bubble has rendered

  // ... rest of existing send flow ...
}
```

After that one-shot scroll at send time, the viewport doesn't move on its own. As tokens stream in, the scroll position stays where the user has it. If they want to follow along, they manually scroll. If they want to read earlier content, they scroll up. Neither action is fought by the UI.

This applies to all streaming flows: send, regenerate, edit-and-continue. None of them auto-scroll during streaming.

### Issue 2 — First message inaccessible (scrollbar can't reach it)

**Symptom.** Per the screenshot, the very first message in the chat is partially or fully hidden at the top of the message list. The scrollbar can't reach far enough up to expose it.

**Diagnostic.** Likely causes:

1. **Sticky/fixed header** on the message list container is overlapping the first message. The scrollable area's top is occluded by the chat header (with chat name, token counter, settings gear).
2. **Padding-top on the scrollable container** isn't being accounted for — content is positioned correctly but `scrollTop = 0` doesn't actually expose the top.
3. **Auto-scroll on mount** is positioning at bottom instead of letting user scroll up freely.

**Fix.** Read the current ChatView layout. The header should be OUTSIDE the scrollable message list, not floating over it. Layout shape:

```tsx
<div className="chat-view flex flex-col h-screen">
  {/* Header — fixed height, not part of scroll area */}
  <header className="flex-shrink-0 ...">
    {/* Chat name, token counter, settings gear */}
  </header>

  {/* Message list — flexible height, scrollable */}
  <div ref={messageListRef} className="chat-message-list flex-1 overflow-y-auto">
    <div className="chat-message-list-inner">
      {messages.map((m) => <ChatMessage key={m.id} message={m} />)}
    </div>
  </div>

  {/* Composer — fixed at bottom */}
  <footer className="flex-shrink-0 ...">
    {/* Textarea + Send button */}
  </footer>
</div>
```

The `flex-1 overflow-y-auto` on the message list means it fills the space between header and footer, with its own scrollbar. The first message is the first child of `chat-message-list-inner`; scrolling all the way up reveals it.

If the current layout uses `position: absolute` or `position: fixed` on the header, change it to a flex layout with the header as a sibling of the scrollable area, not an overlay.

If there's `padding-top` on the scrollable container, that's fine — it just adds breathing room above the first message. But there shouldn't be anything BLOCKING access to the first message.

Verify by hard-refreshing the page on a chat with many messages. The page should load with view at the bottom (latest messages visible). Scroll all the way up — the first user message should be fully visible at the top of the viewport, no part of it cut off.

### Issue 3 — Wasted side space on tablet (final fix)

**Symptom.** Per the screenshot, the chat prose has noticeable empty margin on left and right at Galaxy Tab A9+ landscape resolution (~1340x800).

**Background.** Prior batch capped chat-prose width at 85ch. At 19px Merriweather, 85ch ≈ 1100-1200px, which leaves visible side margins at 1340px viewport.

**Fix.** Remove the line-length cap on tablet/desktop entirely. Trust the user's viewport.

In `globals.css`:

```css
.chat-prose {
  font-family: 'Merriweather', Charter, 'Iowan Old Style', Cambria, Georgia, serif;
  font-size: 1.1875rem;        /* 19px base */
  line-height: 1.65;
  color: rgb(244 244 245);
  /* Removed: max-width: 66ch / 85ch / etc. */
  /* Width is now constrained by the chat-message-list container, not the prose itself */
}

.chat-message-list {
  width: 100%;
  /* Side padding only — no max-width here either */
  padding: 1rem clamp(1rem, 3vw, 2rem);
}

.chat-message-list-inner {
  width: 100%;
  /* Optional: cap at very large displays to prevent absurd line lengths on 4K monitors */
  max-width: 1600px;
  margin: 0 auto;
}

@media (min-width: 1280px) {
  .chat-prose {
    font-size: 1.25rem;          /* 20px on wide screens */
    line-height: 1.7;             /* Longer lines need more line-height */
  }
}

@media (max-width: 768px) {
  .chat-prose {
    font-size: 1.0625rem;         /* 17px on phones */
  }
}
```

Key changes:
- `chat-prose` no longer has `max-width`. It fills its container.
- `chat-message-list` has horizontal padding only (1rem on phones, up to 2rem on wide tablets), no max-width.
- `chat-message-list-inner` has a sanity cap of 1600px for genuinely huge displays (so a 4K desktop monitor doesn't produce 200-character lines), but tablet-and-below is unconstrained.

At Galaxy Tab A9+ landscape (~1340px wide), the result:
- 1340px viewport
- Minus ~64px side padding (32px each side at clamp() top end)
- ≈ 1276px usable width for prose
- At 19px font, ≈ 90-95 characters per line

90-95 cpl is wider than the typographic ideal of 65-75, but at 1.7 line-height and 19-20px font, it's still readable. And it respects what the user is asking for: use the available space.

The composer / footer should match the same width constraints — same padding, no separate max-width. So the input field appears to span the chat width.

**Apply the user's previous typography wishes consistently.** This fix should not regress any of the typography from the prior batch:
- Merriweather font (or Charter fallback)
- 1.65 line-height
- 2em paragraph margin
- Dialogue coloring
- `<think>` collapse styling

Just the width cap is changing.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- During streaming, the message list does NOT auto-scroll. User scroll position is respected throughout streaming.
- When the user sends a new message, the list scrolls once to the bottom (so they see their message + incoming response).
- The first message in a chat is fully visible when the user scrolls to the top of the message list.
- No vertical content is occluded by the header or any other floating UI.
- Chat prose fills the available viewport width minus reasonable side padding (~32px max on tablet).
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet, Galaxy Tab A9+):

1. **No auto-scroll during streaming.** Send a directive that triggers a long response (1000+ tokens). While streaming, scroll up to read earlier messages. Confirm the viewport STAYS where you scrolled — does not jump to the bottom or follow the streaming text. Continue scrolling around freely while the stream runs.
2. **One-shot scroll on send.** Scroll up in a chat to the middle. Type and send a new message. Confirm the view scrolls smoothly to the bottom showing your new message + the incoming response. (Just once, at send. Then no more auto-scroll for the rest of the streaming.)
3. **First message accessible.** Open a chat with 5+ turns. Scroll to the very top. Confirm the first user message is fully visible — top of the bubble, not cut off, not hidden behind the header.
4. **Width on landscape tablet.** Open a chat on Galaxy Tab A9+ in landscape. Confirm prose fills most of the viewport width. Side padding is comfortable (~32px) but not excessive.
5. **Width on portrait tablet.** Same chat in portrait. Confirm prose still fills width with appropriate padding.
6. **Width on phone.** Open in phone-sized viewport (or shrink browser window to ~400px). Confirm prose fills the screen with smaller side padding.
7. **Width on desktop.** Open in browser at full HD or larger. Confirm prose has the 1600px sanity cap (or whatever was set) and centers on the viewport — doesn't produce 200-character lines on a 4K display.
8. **Typography preserved.** All prior typography decisions still in place: Merriweather font, 1.65 line-height (1.7 on wide screens), 2em paragraph margin, dialogue coloring, `<think>` collapse, scroll behavior unchanged otherwise.
9. **Disk-avoidance regression.** Generate an image and a video. Confirm `ssh <gpu-vm> ls /models/ComfyUI/output/*.png 2>&1` returns "no such file."

---

## Out of scope

- A user setting to choose between auto-scroll and manual-scroll behavior.
- A "scroll to bottom" floating button that appears when the user is scrolled up. Could be a future polish; not this batch.
- Changing the typography decisions from the prior batch (font, size, line-height). Width-only change.
- Per-message scroll-into-view on regenerate / edit. Existing one-shot-on-send behavior is enough.
- Custom scrollbar styling.
- Animated scroll on tab switch / chat switch.

---

## Documentation

In CLAUDE.md, under the existing Phase 7 section, update to reflect the behavior changes:

> **Scroll behavior.** During streaming, the message list does NOT auto-scroll. User retains full control. One-shot scroll-to-bottom fires only at send time so the user sees their just-sent message and incoming response. Otherwise scroll position is sticky.

> **Width.** Chat prose fills available viewport width minus ~32px side padding (clamp-scaled for narrower devices). Sanity cap of 1600px applies to very wide displays (4K, ultrawide). Tablet-and-below: unconstrained beyond viewport.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
