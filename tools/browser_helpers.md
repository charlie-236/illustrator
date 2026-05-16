# browser_helpers.md — Playwright MCP helpers (VS Code stack)

This file is for the **VS Code Operator** running with the Microsoft
Playwright MCP toolset. It documents the durable selectors and
inline scripts for the two persistent role tabs (Architect on
Copilot M365, Reviewer on gemini.google.com) and the per-event
tabs you spawn for QA / Historian / Diagnostician.

If you're on the Cowork stack, read
`tools/browser_helpers_cowork.md` instead.

> **About the selectors below.** Selectors for Copilot M365 and
> Gemini have drifted in the past and will drift again. The values
> here are the canonical ones at the time of writing, but if any
> helper returns null or behaves oddly, run the **DOM probe
> procedure** at the end of this file before assuming a deeper bug.
> Selectors marked `TODO` are intentionally unfilled: probe the
> live DOM and update this file.

## Tool surface (Playwright MCP)

The MCP tools available in this stack:

- `browser_navigate(url)` — navigate the active tab to a URL
- `browser_evaluate(function, args?)` — run JS in the page context
  and return the result. JS can be `async`; you don't need IIFE
  wrapping. The function is serialized; closures over Operator-side
  variables won't work — pass values via `args`.
- `browser_click(ref)` — click via snapshot ref (preferred for
  flaky CSS selectors)
- `browser_snapshot()` — accessibility tree snapshot of the page;
  used for recovery when a selector breaks
- `browser_file_upload(paths)` — after clicking a file picker
  button, attach files
- `browser_press_key(key)` — keyboard input (use sparingly; prefer
  inserting text via `browser_evaluate` so React state updates
  fire)
- `browser_tab_new(url)` / `browser_tab_close()` / `browser_tab_select(index)`
  — multi-tab management

When in doubt, prefer `browser_evaluate` against the selectors
documented below. It's deterministic, cheap, and timeout-bounded.

## Architect tab (Copilot M365 — claude-4.7)

Tab URL pattern: `https://m365.cloud.microsoft/chat/*` (varies by
tenant; the URL you land on after sign-in is the durable one).

### Verify the model selector reads "Claude 4.7"

```js
// TODO: probe the Copilot M365 model picker
// Look for an element whose label/aria reflects the active model.
// Common patterns to try first:
//   document.querySelector('button[aria-label*="model"]')
//   document.querySelector('[data-testid*="model-picker"]')
// Return the visible text. Operator parses it.
async () => {
  const candidates = [
    'button[aria-label*="model"]',
    '[data-testid*="model-picker"]',
    '[role="combobox"][aria-label*="model"]',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) return { selector: sel, text: (el.innerText || el.getAttribute('aria-label') || '').trim() };
  }
  return null;
}
```

If the helper returns null after probing all candidates, the
selector has drifted. Run the DOM probe (end of file).

### Verify extended thinking is enabled

```js
// TODO: probe the Copilot M365 thinking toggle
async () => {
  const candidates = [
    'button[aria-label*="thinking"]',
    'button[aria-label*="reasoning"]',
    '[data-testid*="thinking-toggle"]',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) {
      const pressed = el.getAttribute('aria-pressed') === 'true';
      return { selector: sel, on: pressed };
    }
  }
  return null;
}
```

### Send a message to the Architect tab

```js
// TODO: probe the Copilot M365 composer + send button
async ({ text }) => {
  // The composer is typically contenteditable. document.execCommand
  // preserves newlines and triggers React state changes reliably.
  const composer = document.querySelector(
    '[contenteditable="true"][role="textbox"], div[contenteditable="true"]'
  );
  if (!composer) throw new Error('composer not found');
  composer.focus();
  document.execCommand('insertText', false, text);

  // Wait briefly for React to register the input
  await new Promise(r => setTimeout(r, 200));

  const send = document.querySelector(
    'button[aria-label*="Send" i], button[data-testid*="send"]'
  );
  if (!send) throw new Error('send button not found');
  if (send.disabled) throw new Error('send button disabled (composer empty?)');
  send.click();
  return { sent: true, length: text.length };
}
```

Pass the message via the `args` second argument to
`browser_evaluate`: `browser_evaluate(fn, { text: yourMessageString })`.

For long messages (over ~10k chars), the composer can lag. The
`document.execCommand('insertText', ...)` path is generally fine
for prompts up to ~40k chars; beyond that, paste in chunks with a
500ms gap.

### Wait for the Architect's response to complete

Strategy: poll an "is streaming" indicator until it goes false, then
re-verify after a short delay (Copilot M365 sometimes flickers the
indicator between tool-use and text streaming).

```js
// TODO: probe the streaming-indicator selector on Copilot M365.
// Replace `[data-testid="streaming-indicator"]` once you've
// confirmed the live attribute.
async () => {
  const start = Date.now();
  const TIMEOUT_MS = 600_000;  // 10 min hard cap
  let pollCount = 0;

  while (Date.now() - start < TIMEOUT_MS) {
    pollCount++;
    const streaming = document.querySelector('[data-testid="streaming-indicator"]');
    const isStreaming = streaming
      ? (streaming.getAttribute('data-streaming') === 'true' || streaming.innerText.trim().length > 0)
      : false;

    if (!isStreaming) {
      // Re-verify after a short delay to filter flicker between
      // tool-use and text streaming
      await new Promise(r => setTimeout(r, 1500));
      const recheck = document.querySelector('[data-testid="streaming-indicator"]');
      const stillIdle = !recheck || recheck.getAttribute('data-streaming') !== 'true';
      if (stillIdle) {
        // Capture the last assistant response
        const responses = document.querySelectorAll(
          '[data-testid="assistant-message"], [role="region"][aria-label*="response"]'
        );
        const last = responses[responses.length - 1];
        return {
          ok: true,
          text: last ? (last.innerText || '').trim() : '',
          pollCount,
          elapsedMs: Date.now() - start,
        };
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return { ok: false, reason: 'timeout', elapsedMs: Date.now() - start };
}
```

### Attach a repomix archive to the Architect tab

```
1. browser_click on the attach button
2. browser_file_upload(paths=['/tmp/repo-snapshot.xml'])
3. Wait ~2s for the upload to register
4. Verify a file chip appeared near the composer
```

The attach button selector is TODO. Probe it.

## Reviewer tab (Gemini Pro)

Tab URL: `https://gemini.google.com/app/*`

### Verify Gemini model is Pro

```js
async () => {
  const sel = document.querySelector('button[aria-label="Open mode picker"]');
  return sel ? (sel.innerText || '').replace(/\n/g, ' ').trim() : null;
}
```

If this returns anything other than "Pro" (e.g. "Flash" or
"Flash-Lite"), **STOP** and write SESSION-STALL. Do not proceed.

### Send a message to the Reviewer tab

```js
async ({ text }) => {
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
}
```

### Wait for the Reviewer's response

Strategy: poll the latest `.model-response-text` until it stops
changing, with an `aria-busy` cross-check.

```js
async () => {
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
      // New response has started; check if it's done
      const reVerify = (() => {
        const lb = document.querySelector('[aria-busy]');
        return lb ? lb.getAttribute('aria-busy') : null;
      })();
      if (reVerify === 'false') {
        const r = document.querySelectorAll('.model-response-text');
        const last = r[r.length - 1];
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
}
```

### Attach files (rare for Gemini)

Gemini has a file-attach affordance but the Reviewer doesn't
typically need repo context — it's given the artifact to review
inline. If you need to attach, click the attach button:

```js
async () => {
  const btn = document.querySelector('button[aria-label="Add files"]');
  if (!btn) throw new Error('Gemini attach button not found');
  btn.click();
  return { clicked: true };
}
```

then call `browser_file_upload(paths=['/tmp/some-file.txt'])`.

## Per-event Copilot M365 tabs (QA / Historian / Diagnostician)

These spawn fresh per item or event. Use the same selectors as the
Architect tab. Workflow:

1. `browser_tab_new('https://m365.cloud.microsoft/chat/')`
2. Wait for the page to be ready (composer present).
3. Verify the model selector matches the per-role tier requirement
   in `agents/OPERATOR.md`.
4. Click the attach button, upload `/tmp/repo-snapshot.xml`.
5. Send the role's Bootstrap Block (templates at the end of
   `agents/OPERATOR.md`).
6. Wait for acknowledgment; parse headers (`## QA model identity`,
   `## QA understanding`, etc.).
7. Proceed with the role-specific request.
8. After verdict, close the tab: `browser_tab_close()`.

## Operator notes on tool selection

- **Selector-based steady-state**: prefer `browser_evaluate`
  against the durable selectors. Deterministic, cheap, timeout-
  bounded.
- **Snapshot-and-click**: for recovery when a selector breaks, or
  for one-off UI interactions where writing a selector isn't worth
  the maintenance burden.
- **Navigation**: always `browser_navigate`. Never use
  `window.location` from inside `browser_evaluate` — the running
  script's context dies on navigation and you lose the return
  value.
- **File uploads**: always use `browser_file_upload` after
  triggering the file picker via click. Don't try to set
  `<input type="file">` values from JS — modern browsers reject
  that for security.
- **Keyboard input**: prefer `document.execCommand('insertText')`
  inside `browser_evaluate` over `browser_press_key` loops; the
  former preserves newlines and triggers React/Angular state
  changes reliably for rich editors. Use
  `browser_press_key('Enter')` only for submitting after text is
  in the field, if Enter alone isn't enough.

## DOM probe procedure (when a selector has drifted)

If a helper returns null or behaves unexpectedly:

1. Take a snapshot: `browser_snapshot()`. This is the accessibility
   tree — much smaller than the full DOM and labels usually let
   you spot what changed.
2. If the snapshot's not enough, dump narrow slices of the live
   DOM via `browser_evaluate`:

   ```js
   () => Array.from(document.querySelectorAll('button'))
     .filter(b => /model|mode|claude|gemini|gpt|thinking|reason/i.test(b.innerText + ' ' + (b.getAttribute('aria-label') || '')))
     .map(b => ({
       text: b.innerText.trim().slice(0, 60),
       aria: b.getAttribute('aria-label'),
       testid: b.getAttribute('data-testid'),
       pressed: b.getAttribute('aria-pressed'),
       disabled: b.disabled,
     }))
   ```

3. Once you've identified the new attribute / class / structure,
   update the corresponding helper in this file and commit it on
   a follow-up batch (or, in autonomous sessions, file an Operator
   observation and have Architect schedule a "browser_helpers.md
   refresh" item).

4. Sanity-check by re-running the helper that was broken.

## Recovery and resilience

- If a tab loses its login session mid-loop, write SESSION-STALL.
  Don't try to re-authenticate from the sandbox.
- If a `browser_evaluate` call returns `null` from a selector that
  should always match, **don't proceed as if everything is fine**
  — that's the canary for a DOM change. Halt and probe.
- If a send fails with "send button disabled", the composer state
  isn't what you think — re-snapshot and re-insert text.
- If a poll times out without a streaming-finished signal, **don't
  assume the response is partial-but-ok**. Either retry the poll
  with a longer cap (give it 5 more minutes) or write SESSION-STALL
  and let the User intervene.
