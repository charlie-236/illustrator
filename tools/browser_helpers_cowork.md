# browser_helpers_cowork.md — Claude in Chrome MCP helpers (Cowork stack)

This file is for the **Cowork Operator** running with the Claude in
Chrome MCP toolset. It documents the durable selectors and inline
scripts for the two persistent role tabs (Architect on claude.ai
inside the Illustrator project, Reviewer on gemini.google.com) and
the per-event tabs you spawn for QA / Historian / Diagnostician on
claude.ai.

If you're on the VS Code stack, read `tools/browser_helpers.md`
instead.

> **About the selectors below.** Selectors for claude.ai and Gemini
> have drifted in the past and will drift again. The values here
> are the canonical ones at the time of writing, but if any helper
> returns null or behaves oddly, run the **DOM probe procedure** at
> the end of this file before assuming a deeper bug.

## Tool surface (Claude in Chrome MCP)

The MCP tools available in this stack include:

- `mcp__Claude_in_Chrome__navigate(url)` — navigate to a URL
- `mcp__Claude_in_Chrome__javascript_tool(script)` — run JS in the
  page context. The script body must be wrapped in an IIFE because
  the MCP doesn't auto-await async functions. Pattern:

  ```js
  (async () => {
    // your async code
    return resultValue;
  })()
  ```

  If you don't IIFE-wrap, the MCP returns the Promise object
  instead of its resolved value.
- `mcp__Claude_in_Chrome__click_element_at(x, y)` — click by
  coordinates from a screenshot
- `mcp__Claude_in_Chrome__send_text_at(x, y, text)` — type at
  coordinates
- `mcp__Claude_in_Chrome__take_screenshot()` — visual recovery
  when selectors fail
- Tab/window management primitives (names vary by Cowork version;
  check the live tool list)

The IIFE wrapping requirement is the single most important
difference from the Playwright MCP surface. **Forgetting to wrap an
async function** will return a Promise stringification ("[object
Promise]" or similar) and break parsing.

## Architect tab (claude.ai inside the Illustrator project)

Tab URL: `https://claude.ai/project/<illustrator-project-id>/new`
(initial) or `https://claude.ai/chat/<chat-id>` (after conversation
starts).

### Verify the model is Claude Opus 4.7 Adaptive

```js
(async () => {
  const btn = document.querySelector('[data-testid="model-selector-dropdown"]');
  if (!btn) return null;
  return (btn.innerText || '').replace(/\n/g, ' ').trim();
})()
```

Expected return: a string containing "Opus 4.7" (or current best
Opus tier). If it returns null, the selector has drifted — probe
the DOM.

### Verify extended thinking is on

```js
(async () => {
  const toggle = document.querySelector('[data-testid="thinking-toggle"]');
  if (!toggle) return { found: false };
  return {
    found: true,
    on: toggle.getAttribute('aria-pressed') === 'true',
  };
})()
```

If `on: false`, the session must halt — extended thinking is
required for Architect-tier work.

### Send a message to the Architect tab

```js
(async ({ text }) => {
  const composer = document.querySelector('div[contenteditable="true"][role="textbox"]');
  if (!composer) throw new Error('claude.ai composer not found');
  composer.focus();
  document.execCommand('insertText', false, text);
  await new Promise(r => setTimeout(r, 300));
  const send = document.querySelector('button[aria-label="Send message"]');
  if (!send) throw new Error('claude.ai send button not found');
  if (send.disabled || send.getAttribute('aria-disabled') === 'true') {
    throw new Error('claude.ai send button disabled');
  }
  send.click();
  return { sent: true, length: text.length };
})()
```

Pass the text via the IIFE's argument object.

### Stash-then-send for long messages

For messages over ~20k characters (e.g. when you're pasting a full
PR diff to the Architect), `document.execCommand('insertText')` can
lag the page. Stash the text in `window.__pending_message` first via
a separate `javascript_tool` call, then have the send function
consume it:

```js
// Call 1: stash
(async ({ text }) => { window.__pending_message = text; return { stashed: text.length }; })()

// Call 2: send
(async () => {
  const text = window.__pending_message;
  if (!text) throw new Error('no pending message');
  const composer = document.querySelector('div[contenteditable="true"][role="textbox"]');
  composer.focus();
  document.execCommand('insertText', false, text);
  await new Promise(r => setTimeout(r, 500));
  const send = document.querySelector('button[aria-label="Send message"]');
  send.click();
  delete window.__pending_message;
  return { sent: true, length: text.length };
})()
```

### Wait for the Architect's response to complete

Strategy: poll the streaming indicator on `[data-is-streaming]`,
then re-verify on `.font-claude-response` after 1.2 seconds (the
streaming attribute briefly flickers between tool-use and text).

```js
(async () => {
  const start = Date.now();
  const TIMEOUT_MS = 600_000;
  const initial = (() => {
    const r = document.querySelectorAll('.font-claude-response');
    return { responseCount: r.length };
  })();
  let pollCount = 0;

  while (Date.now() - start < TIMEOUT_MS) {
    pollCount++;
    const root = document.querySelector('[data-is-streaming]');
    const isStreaming = root && root.getAttribute('data-is-streaming') === 'true';
    if (!isStreaming) {
      // Re-verify after 1.2s — streaming flickers off briefly
      // between tool-use chunks
      await new Promise(r => setTimeout(r, 1200));
      const reCheck = document.querySelector('[data-is-streaming]');
      const stillIdle = !reCheck || reCheck.getAttribute('data-is-streaming') !== 'true';
      if (stillIdle) {
        const responses = document.querySelectorAll('.font-claude-response');
        const last = responses[responses.length - 1];
        const responseText = last ? (last.innerText || '').trim() : '';
        return {
          ok: true,
          text: responseText,
          pollCount,
          elapsedMs: Date.now() - start,
          initialResponseCount: initial.responseCount,
          finalResponseCount: responses.length,
        };
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return { ok: false, reason: 'timeout', elapsedMs: Date.now() - start };
})()
```

### Trigger project knowledge refresh (after a merge)

The Illustrator project's `project_knowledge_search` doesn't auto-
update on git push. After every merge, trigger a manual refresh
before invoking role-side Claudes:

```js
(async () => {
  // Navigate to the project settings or find the refresh button.
  // TODO: probe the exact selector — the refresh affordance is in
  // the project sidebar.
  const candidates = [
    'button[aria-label*="sync"]',
    'button[aria-label*="refresh"]',
    '[data-testid="resync-project-knowledge"]',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) { el.click(); return { clicked: sel }; }
  }
  return { clicked: null, note: 'selectors all missed; run DOM probe' };
})()
```

If the helper can't find the refresh button programmatically, fall
back to navigating to the project's settings page and screenshotting
to find it visually. The User shouldn't have to do this manually
mid-session, but if it comes to it, write SESSION-STALL.

## Reviewer tab (Gemini Pro)

Tab URL: `https://gemini.google.com/app/*`

### Verify Gemini model is Pro

```js
(async () => {
  const sel = document.querySelector('button[aria-label="Open mode picker"]');
  return sel ? (sel.innerText || '').replace(/\n/g, ' ').trim() : null;
})()
```

If this returns anything other than "Pro" (e.g. "Flash" or
"Flash-Lite"), **STOP** and write SESSION-STALL. Do not proceed.

### Send a message to the Reviewer tab

```js
(async ({ text }) => {
  const composer = document.querySelector('rich-textarea div[contenteditable="true"]');
  if (!composer) throw new Error('Gemini composer not found');
  composer.focus();
  document.execCommand('insertText', false, text);
  await new Promise(r => setTimeout(r, 300));
  const send = document.querySelector('button[aria-label="Send message"]');
  if (!send) throw new Error('Gemini send button not found');
  if (send.disabled || send.getAttribute('aria-disabled') === 'true') {
    throw new Error('Gemini send button disabled');
  }
  send.click();
  return { sent: true };
})()
```

### Wait for the Reviewer's response

Strategy: poll the latest `.model-response-text` until it stops
changing, with an `aria-busy` cross-check.

```js
(async () => {
  const start = Date.now();
  const TIMEOUT_MS = 300_000;
  const initial = (() => {
    const r = document.querySelectorAll('.model-response-text');
    return { responseCount: r.length };
  })();
  let pollCount = 0;

  while (Date.now() - start < TIMEOUT_MS) {
    pollCount++;
    const responses = document.querySelectorAll('.model-response-text');
    if (responses.length > initial.responseCount) {
      const reVerify = (() => {
        const lb = document.querySelector('[aria-busy]');
        return lb ? lb.getAttribute('aria-busy') : null;
      })();
      if (reVerify === 'false') {
        const r = document.querySelectorAll('.model-response-text');
        const last = r[r.length - 1];
        const responseText = last ? (last.innerText || '').trim() : '';
        delete window.__pending_message;
        return {
          ok: true,
          text: responseText,
          pollCount,
          elapsedMs: Date.now() - start,
          initialResponseCount: initial.responseCount,
          finalResponseCount: responses.length,
        };
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return { ok: false, reason: 'timeout', elapsedMs: Date.now() - start };
})()
```

### Watch for the "Stop response" stuck-button bug

Gemini's mid-response Stop button has been observed to stay
visible after the response finishes, occasionally with an empty
message body. If you see this state on a poll, refresh the page
(`mcp__Claude_in_Chrome__navigate(currentUrl)`) and re-send the
last message. Don't try to "click Stop" — that confuses the
underlying state.

### Attach files (rare for Gemini)

Gemini has a file-attach affordance but the Reviewer doesn't
typically need repo context — it's given the artifact to review
inline. If you do need to attach, click the attach button:

```js
(async () => {
  const btn = document.querySelector('button[aria-label="Add files"]');
  if (!btn) throw new Error('Gemini attach button not found');
  btn.click();
  return { clicked: true };
})()
```

Then trigger the host-side file picker (the exact mechanism depends
on which Claude in Chrome version Cowork is shipping; consult the
live tool list for the file-upload primitive).

## Per-event claude.ai tabs (QA / Historian / Diagnostician)

These spawn fresh per item or event, inside the Illustrator project
so they have `project_knowledge_search` access.

1. `mcp__Claude_in_Chrome__navigate('https://claude.ai/new?project=<illustrator-project-id>')`
2. Wait for the page to be ready (composer + project knowledge
   indicator both visible).
3. Verify the model selector matches the per-role tier requirement
   in `agents/OPERATOR_cowork.md`.
4. Send the role's Bootstrap Block (templates at the end of
   `agents/OPERATOR_cowork.md`). The bootstrap directs the role to
   read its brief from project knowledge.
5. Wait for acknowledgment; parse headers (`## QA model identity`,
   `## QA understanding`, etc.).
6. Proceed with the role-specific request.
7. After verdict, the chat closes naturally (you just stop using
   it; claude.ai doesn't require explicit close).

## Operator notes on tool selection

- **Always IIFE-wrap async code** for `javascript_tool` calls.
  Forgetting this returns a Promise object instead of the resolved
  value.
- **Navigation kills running scripts.** Never call
  `window.location = ...` from inside `javascript_tool` — use
  `mcp__Claude_in_Chrome__navigate` instead. The running script's
  context is destroyed on navigation and you lose the return value.
- **Long-message stashing** is the safest way to deliver >20k char
  payloads to the composer. The stash-then-send pattern above is
  the canonical form.
- **Re-verification on streaming-finished signals** matters.
  claude.ai flickers `data-is-streaming` between tool-use and text
  streaming; the 1.2-second re-verify is essential. Without it, you
  capture partial responses.

## DOM probe procedure (when a selector has drifted)

If a helper returns null or behaves unexpectedly:

1. Take a screenshot: `mcp__Claude_in_Chrome__take_screenshot()`.
   This tells you what the UI currently looks like.
2. Dump narrow slices of the live DOM via `javascript_tool`:

   ```js
   (async () => Array.from(document.querySelectorAll('button'))
     .filter(b => /model|mode|claude|gemini|opus|sonnet|thinking|reason|sync|refresh/i
       .test(b.innerText + ' ' + (b.getAttribute('aria-label') || '')))
     .map(b => ({
       text: b.innerText.trim().slice(0, 60),
       aria: b.getAttribute('aria-label'),
       testid: b.getAttribute('data-testid'),
       pressed: b.getAttribute('aria-pressed'),
       disabled: b.disabled,
     }))
   )()
   ```

3. Once you've identified the new attribute / class / structure,
   update the corresponding helper in this file and commit it on a
   follow-up batch.
4. Sanity-check by re-running the helper that was broken.

## Recovery and resilience

- If a tab loses its login session mid-loop, write SESSION-STALL.
  Don't try to re-authenticate from the sandbox.
- If a `javascript_tool` call returns `null` from a selector that
  should always match, **don't proceed as if everything is fine**
  — that's the canary for a DOM change. Halt and probe.
- If a send fails with "send button disabled", the composer state
  isn't what you think — re-screenshot and re-insert text.
- If a poll times out without a streaming-finished signal, don't
  assume the response is partial-but-ok. Either retry the poll with
  a longer cap (give it 5 more minutes) or write SESSION-STALL.
- If you ever see Gemini's "Stop response" button stuck with no
  reply body, refresh the tab and re-send.
- If the Illustrator project's `project_knowledge_search` returns
  noticeably stale results (e.g., references a file you know was
  deleted in a recent merge), trigger a manual refresh and wait
  ~30 seconds before retrying.
