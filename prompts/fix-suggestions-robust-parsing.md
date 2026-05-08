# Quick fix — Suggestions diagnostics + robust parsing

The pills "flash for a few seconds then disappear" symptom is most likely **the LLM not emitting parseable `[SUGGESTION N]` blocks** — `parseSuggestions` returns `[]`, the skeleton shows during the 10-second LLM call, then disappears because zero suggestions to render. Midnight Miqu and similar creative-writing models don't follow strict structured-output instructions reliably.

This batch:
1. **Adds server-side diagnostic logging** so we can SEE what the LLM is actually emitting.
2. **Robust parser** — accepts multiple plausible formats from the LLM, not just the strict `[SUGGESTION N]` block format.
3. **Empty-state UI** so the user sees "Couldn't generate suggestions" instead of pills silently vanishing.

Re-read CLAUDE.md before starting. Disk-avoidance unaffected.

---

## Required changes

### Part 1 — Server: log raw LLM response and parsed count

In `src/app/api/chats/[id]/messages/[msgId]/suggestions/route.ts`, after the LLM response is read but before parsing:

```ts
// Existing:
responseText = data.choices?.[0]?.message?.content ?? '';

// NEW: diagnostic logging
console.log('[suggestions] msgId:', msgId);
console.log('[suggestions] raw LLM response (first 1000 chars):',
  responseText.slice(0, 1000));

const suggestions = parseSuggestions(responseText);

// NEW: log parse result
console.log('[suggestions] parsed count:', suggestions.length);
if (suggestions.length === 0 && responseText.length > 0) {
  console.log('[suggestions] parse FAILED — full response:', responseText);
}
```

These logs go to the server console (npm run dev terminal). After this batch lands, the user can:
1. Send a chat directive
2. Wait for response
3. Check terminal for `[suggestions]` log lines
4. See exactly what the LLM is emitting

These logs are **kept permanently** — not "remove after diagnosis." They're useful for ongoing debugging, no perf cost (one log per chat turn). If they get noisy, gate behind `process.env.SUGGESTIONS_DEBUG === '1'` env flag.

### Part 2 — Robust parser

Current parser only matches the strict `[SUGGESTION N]` / `LABEL:` / `PROMPT:` format. Local LLMs frequently emit:
- Numbered lists: `1. Label: ... Prompt: ...`
- Plain numbered without keys: `1. <short label>\n<longer prompt>`
- Markdown headers: `**Suggestion 1**: <label>\n<prompt>`
- Just three paragraphs separated by blank lines

Replace `parseSuggestions` with a multi-strategy parser that tries each format in order:

```ts
function parseSuggestions(text: string): Suggestion[] {
  if (!text || text.trim().length === 0) return [];

  // Strategy 1: strict [SUGGESTION N] / LABEL: / PROMPT: format
  const strict = parseStrictFormat(text);
  if (strict.length >= 2) return strict.slice(0, 3);

  // Strategy 2: numbered list with LABEL/PROMPT keys
  const numbered = parseNumberedFormat(text);
  if (numbered.length >= 2) return numbered.slice(0, 3);

  // Strategy 3: markdown heading format (## Suggestion 1, etc.)
  const markdown = parseMarkdownFormat(text);
  if (markdown.length >= 2) return markdown.slice(0, 3);

  // Strategy 4: paragraph fallback — split on double-newlines, treat each as both label+prompt
  const paragraphs = parseParagraphFallback(text);
  if (paragraphs.length >= 2) return paragraphs.slice(0, 3);

  // None matched — return empty array (UI shows empty state)
  return [];
}

function parseStrictFormat(text: string): Suggestion[] {
  const blocks = text.split(/\[SUGGESTION\s*\d+\]/i).filter((b) => b.trim().length > 0);
  const suggestions: Suggestion[] = [];
  for (const block of blocks) {
    const labelMatch = block.match(/LABEL\s*:\s*(.+?)(?:\n|$)/i);
    const promptMatch = block.match(/PROMPT\s*:\s*([\s\S]+?)(?=\n\[SUGGESTION|\nLABEL\s*:|$)/i);
    if (labelMatch && promptMatch) {
      const label = cleanLabel(labelMatch[1]);
      const prompt = cleanPrompt(promptMatch[1]);
      if (label && prompt) suggestions.push({ label, prompt });
    }
    if (suggestions.length === 3) break;
  }
  return suggestions;
}

function parseNumberedFormat(text: string): Suggestion[] {
  // Matches: "1." or "1)" followed by content; LABEL/PROMPT keys optional
  const blocks = text.split(/\n\s*\d+[\.\)]\s+/).filter((b) => b.trim().length > 0);
  // First block before "1." is preamble; skip if no LABEL keyword
  const startIdx = blocks[0].match(/LABEL\s*:/i) ? 0 : 1;
  const suggestions: Suggestion[] = [];
  for (let i = startIdx; i < blocks.length; i++) {
    const block = blocks[i];
    const labelMatch = block.match(/LABEL\s*:\s*(.+?)(?:\n|$)/i);
    const promptMatch = block.match(/PROMPT\s*:\s*([\s\S]+?)(?=\n\s*\d+[\.\)]|\nLABEL\s*:|$)/i);
    if (labelMatch && promptMatch) {
      const label = cleanLabel(labelMatch[1]);
      const prompt = cleanPrompt(promptMatch[1]);
      if (label && prompt) suggestions.push({ label, prompt });
    } else {
      // Fallback: first line is label, rest is prompt
      const lines = block.trim().split(/\n+/);
      if (lines.length >= 2) {
        const label = cleanLabel(lines[0]);
        const prompt = cleanPrompt(lines.slice(1).join(' '));
        if (label && prompt) suggestions.push({ label, prompt });
      }
    }
    if (suggestions.length === 3) break;
  }
  return suggestions;
}

function parseMarkdownFormat(text: string): Suggestion[] {
  // Matches: "## Suggestion 1" or "**Suggestion 1**" or "### 1." etc
  const blocks = text.split(/\n+(?:#{1,3}\s+|^\*\*)\s*(?:Suggestion\s*)?\d+[\.\):\*]*\s*\*?\*?/im)
    .filter((b) => b.trim().length > 0);
  const suggestions: Suggestion[] = [];
  for (const block of blocks) {
    const labelMatch = block.match(/LABEL\s*:\s*(.+?)(?:\n|$)/i) || block.match(/^(.+?)(?:\n|$)/);
    const promptMatch = block.match(/PROMPT\s*:\s*([\s\S]+?)$/i);
    if (labelMatch && promptMatch) {
      const label = cleanLabel(labelMatch[1]);
      const prompt = cleanPrompt(promptMatch[1]);
      if (label && prompt) suggestions.push({ label, prompt });
    } else if (labelMatch) {
      // Label is first line; prompt is rest
      const lines = block.trim().split(/\n+/);
      if (lines.length >= 2) {
        const label = cleanLabel(lines[0]);
        const prompt = cleanPrompt(lines.slice(1).join(' '));
        if (label && prompt) suggestions.push({ label, prompt });
      }
    }
    if (suggestions.length === 3) break;
  }
  return suggestions;
}

function parseParagraphFallback(text: string): Suggestion[] {
  // Last-resort: split on double newlines; first sentence = label, rest = prompt
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 20);
  const suggestions: Suggestion[] = [];
  for (const para of paragraphs) {
    const cleaned = para.replace(/^[\d\.\-\*\s]+/, '').trim();  // strip leading numbering
    const sentenceMatch = cleaned.match(/^([^.!?\n]+[.!?])/);
    if (sentenceMatch) {
      const label = cleanLabel(sentenceMatch[1]);
      const prompt = cleanPrompt(cleaned);
      if (label && prompt) suggestions.push({ label, prompt });
    } else {
      const label = cleanLabel(cleaned.slice(0, 60));
      const prompt = cleanPrompt(cleaned);
      if (label && prompt) suggestions.push({ label, prompt });
    }
    if (suggestions.length === 3) break;
  }
  return suggestions;
}

function cleanLabel(s: string): string {
  return s
    .trim()
    .replace(/^[\*\_\-\#\d\.\)\s]+/, '')   // strip leading markdown / numbering
    .replace(/[\*\_]+/g, '')                // strip bold/italic markdown
    .replace(/^["'""'']|["'""'']$/g, '')   // strip surrounding quotes
    .replace(/\.$/, '')                     // strip trailing period
    .slice(0, 80)                           // cap length
    .trim();
}

function cleanPrompt(s: string): string {
  return s
    .trim()
    .replace(/^[\*\_\-\s]+/, '')
    .replace(/[\*\_]{2,}/g, '')
    .slice(0, 1000)                         // cap length
    .trim();
}
```

Each strategy returns `Suggestion[]` (could be 0-3). The cascade tries them in order; first one with ≥2 results wins. The 2-results threshold means "if a strategy parses 2 of 3, that's good enough — use it." Strict format only requires 1 to short-circuit (since it's the most specific match).

The 4-strategy fallback handles essentially any reasonable text the LLM produces. Edge case: model outputs prose with no clear structure at all → all 4 strategies fail → empty array. That case becomes the empty-state UI in Part 4.

### Part 3 — Tighten the system prompt

Current prompt asks for `[SUGGESTION N]` blocks with `LABEL:` and `PROMPT:` keys. Add explicit examples and stronger formatting emphasis:

In `src/lib/writerSuggestionsPrompt.ts`, append after the existing rules:

```ts
export const SUGGESTIONS_SYSTEM_PROMPT = `... existing prompt ...

EXAMPLE OUTPUT (follow this format exactly):

[SUGGESTION 1]
LABEL: She runs from the bar
PROMPT: She bolts toward the back exit, weaving through tables and patrons. Her heart pounds as she shoves through the door into the alley, the cold night air slamming into her. She doesn't look back.

[SUGGESTION 2]
LABEL: Cut to next morning
PROMPT: Skip ahead to the next morning. She wakes in her own bed, the events of last night blurry. Sunlight streams through the curtains. She tries to piece together what happened after she left the bar.

[SUGGESTION 3]
LABEL: She confronts him directly
PROMPT: She stands her ground and locks eyes with him across the room. Her voice steady but quiet, she demands to know why he was watching her. The bartender pauses mid-pour. The room falls silent.

Output exactly the three [SUGGESTION N] blocks above, with LABEL and PROMPT lines. Do NOT use markdown headers, asterisks, numbered lists, or any other format. Begin your response with "[SUGGESTION 1]" — no preamble.`;
```

Concrete examples + "begin with [SUGGESTION 1]" massively increases compliance for instruction-following weak models.

### Part 4 — Client: empty-state UI

When `pillsAvailable` is an empty array (suggestions ran but parsed nothing), don't silently render nothing. Show a small text indicator so the user knows the system tried but didn't get useful suggestions:

In `ChatView.tsx`, the suggestions render block:

```tsx
{showPills && (
  <div className="suggestions-row">
    {pillsLoading ? (
      <>
        <div className="suggestion-skeleton" />
        <div className="suggestion-skeleton" />
        <div className="suggestion-skeleton" />
      </>
    ) : pillsAvailable && pillsAvailable.length > 0 ? (
      pillsAvailable.map((s, i) => (
        <button
          key={i}
          className="suggestion-pill"
          onClick={() => {
            setComposerText(s.prompt);
            updateTokenCount(s.prompt);
          }}
        >
          {s.label}
        </button>
      ))
    ) : pillsAvailable && pillsAvailable.length === 0 ? (
      <p className="text-xs text-zinc-600 italic px-2 py-2">
        Couldn&apos;t generate suggestions for this turn.
      </p>
    ) : null}
  </div>
)}
```

The empty-state message renders only when:
- Loading is done (`!pillsLoading`)
- Suggestions were attempted (`pillsAvailable !== null` — distinct from "never tried")
- Result was empty (`pillsAvailable.length === 0`)

If the LLM is reliably producing unparseable output, the user sees this message and knows to either tweak the system prompt, change the model, or send a manual directive. Better than mysterious skeleton-then-nothing.

If `pillsAvailable === null` (suggestions never returned, e.g., timeout or chat just opened), no empty-state message — just no pills at all.

### Part 5 — Verify suggestions request actually fires from regenerate flow

Double-check: the `requestSuggestions` call is in `onStreamDone`, which is shared across send / regenerate / edit-and-continue. Verify by inspection:

```ts
function onStreamDone(msgId: string, finalContent: string, newTokenCount: number) {
  // ... existing ...
  if (settingsSuggestionsEnabled) {
    void requestSuggestions(msgId);
  }
}
```

This fires for every stream completion. If regenerate or edit-and-continue have their OWN `onDone` handlers that don't call requestSuggestions, fix to use the shared `onStreamDone`. (Likely already correct — the prompt earlier specified shared usage.)

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- Server console shows `[suggestions]` logs on every chat turn.
- Multi-strategy parser at minimum handles strict + numbered + markdown + paragraph fallbacks.
- System prompt contains concrete `[SUGGESTION N]` examples.
- UI shows "Couldn't generate suggestions" empty state when parsing returns 0 suggestions.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. **Diagnostic logs visible.** Send a chat directive. Watch the npm run dev terminal. Confirm you see:
   ```
   [suggestions] msgId: cmovv5cx60007njd4ke5bpss1
   [suggestions] raw LLM response (first 1000 chars): ...
   [suggestions] parsed count: 3 (or 2, or 1, or 0)
   ```
   The `raw LLM response` log shows EXACTLY what the LLM emitted. If the format doesn't match `[SUGGESTION N]` blocks, you now know.

2. **Pills appear with strict format.** If the LLM follows `[SUGGESTION N]` format, parsed count is 3, pills render normally.

3. **Pills appear with numbered format.** If the LLM emits `1. ... 2. ... 3. ...`, the numbered parser catches it. Parsed count is 3 (or 2), pills render.

4. **Empty-state with bad format.** If the LLM emits prose with no parseable structure, parser returns 0. UI shows "Couldn't generate suggestions for this turn."

5. **Iterate on system prompt.** If the LLM consistently fails to follow format despite the new examples, the user can edit `SUGGESTIONS_SYSTEM_PROMPT` further or switch models. The diagnostic logs make this iteration loop tight.

6. **DB inspection.** `psql $DATABASE_URL -c 'SELECT "suggestionsJson" FROM "Message" WHERE role = '"'"'assistant'"'"' ORDER BY "createdAt" DESC LIMIT 3;'` shows actual persisted suggestions. Should match what the parser returned.

7. **Disk-avoidance regression.** Generate an image and a video. Confirm `ssh <gpu-vm> ls /models/ComfyUI/output/*.png 2>&1` returns "no such file."

---

## Out of scope

- Streaming the suggestions endpoint. Still not worth it.
- A "regenerate suggestions" button. If parsed empty, user types their own.
- Different system prompts per model. One canonical prompt; tweak as needed.
- Removing the diagnostic logs. Keep them — they're cheap and ongoing-useful.
- Validating that label/prompt have specific lengths (3-8 words, 30-60 words). Cap-and-trim approach is enough; LLM output will be "close enough."
- Suggestion variety enforcement (e.g., "ensure these are narratively distinct"). Trust the model + system prompt; if output is repetitive, that's a system-prompt iteration concern.
- Adding a "diversity score" or rejection of too-similar suggestions.
- Translating suggestions to other languages.

---

## Documentation

In CLAUDE.md, under the existing Phase 7 / Suggestions section, add:

> **Robust parsing.** `parseSuggestions` cascades through four format strategies: strict `[SUGGESTION N]` blocks, numbered lists, markdown headers, paragraph fallback. First strategy with ≥2 results wins. Designed for local LLMs that don't follow strict structured-output instructions reliably.
>
> **Diagnostic logging.** Server logs `[suggestions]` with the raw LLM response (first 1000 chars) and parsed count on every suggestions request. Useful for tuning the system prompt or troubleshooting parser misses. Permanent — no toggle.
>
> **Empty-state UI.** When parsing returns 0 suggestions (LLM didn't follow format), the UI shows "Couldn't generate suggestions for this turn" instead of silently rendering nothing.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
