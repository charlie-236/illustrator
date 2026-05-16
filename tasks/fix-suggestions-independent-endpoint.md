# Quick fix — Independent SUGGESTIONS_LLM_* env vars

The suggestions feature currently calls `WRITER_LLM_ENDPOINT` (Midnight Miqu 70B), which takes 30-60 seconds to produce structured output. The user wants to route suggestions through a small instruction-tuned model (e.g., the polisher's Qwen2.5 Coder 32B) for 5-10 second responses.

Pattern matches the existing split: separate env vars per feature, even if multiple features happen to point at the same endpoint. `POLISH_LLM_ENDPOINT`, `STORYBOARD_LLM_ENDPOINT`, `WRITER_LLM_ENDPOINT` already exist as independent slots — `SUGGESTIONS_LLM_ENDPOINT` joins them.

Re-read CLAUDE.md before starting. Disk-avoidance unaffected.

---

## Required changes

### Part 1 — Add SUGGESTIONS_LLM_* env vars

In `.env.example`, add a new section after the existing writer config (and before/after the polish section, wherever feels natural):

```
# ── LLM / Suggestions ──────────────────────────────────────────────────────
# Endpoint for the post-response "suggested next prompts" feature. Three pill
# suggestions appear above the composer after each chat response; this is the
# model that generates them.
#
# Independent from POLISH/STORYBOARD/WRITER endpoints. May point at the same
# physical service as another feature, but is configured separately so it can
# be moved without affecting other features.
#
# Best fit: small instruction-tuned model (e.g., Qwen2.5 Coder 32B Instruct,
# Llama 3.1 8B Instruct). Creative-writing models like Midnight Miqu work but
# are slow at structured output. Coder/Instruct models respond in 5-10s; large
# creative models take 30-60s.
SUGGESTIONS_LLM_ENDPOINT=http://127.0.0.1:11438/v1/chat/completions

# Model identifier passed as the `model` field. Same conventions as other
# LLM_MODEL vars (HF repo id for HF-served models, file path for GGUFs).
SUGGESTIONS_LLM_MODEL=Qwen/Qwen2.5-Coder-32B-Instruct

# Generation timeout in milliseconds. Default 30s — small instruction-tuned
# models should respond well within this; bump up if using a larger model.
SUGGESTIONS_TIMEOUT_MS=30000

# Sampling. Temperature 0.7 works well for Coder-Instruct models on structured
# output (lower than creative-writing's 0.9); max_tokens 500 is enough for
# three labeled suggestions with room to spare.
SUGGESTIONS_TEMPERATURE=0.7
SUGGESTIONS_MAX_TOKENS=500
```

The user will copy these into their actual `.env` and fill in their endpoint/model — typically pointing at the polisher's address since they already have that running.

### Part 2 — Update the suggestions route to read the new vars

In `src/app/api/chats/[id]/messages/[msgId]/suggestions/route.ts`, find:

```ts
const endpoint = process.env.WRITER_LLM_ENDPOINT;
const model = process.env.WRITER_LLM_MODEL;

if (!endpoint || !model) {
  return NextResponse.json({ suggestions: [] });
}
```

Replace with:

```ts
const endpoint = process.env.SUGGESTIONS_LLM_ENDPOINT;
const model = process.env.SUGGESTIONS_LLM_MODEL;

if (!endpoint || !model) {
  console.warn('[suggestions] SUGGESTIONS_LLM_ENDPOINT or SUGGESTIONS_LLM_MODEL not set; suggestions disabled');
  return NextResponse.json({ suggestions: [] });
}
```

The warn-on-missing log surfaces the misconfiguration during dev. If you'd rather it be silent in production, gate behind `process.env.NODE_ENV !== 'production'`. For single-user dev/prod parity here, either is fine.

### Part 3 — Read timeout and sampling from env

Find the timeout:

```ts
const timeoutId = setTimeout(() => abort.abort(), 120000);  // current value, was 10000 originally
```

Replace with:

```ts
const timeoutMs = parseInt(process.env.SUGGESTIONS_TIMEOUT_MS ?? '30000', 10);
const timeoutId = setTimeout(() => abort.abort(), timeoutMs);
```

Find the LLM call body:

```ts
body: JSON.stringify({
  model,
  messages: history,
  stream: false,
  temperature: 0.9,
  max_tokens: 500,
}),
```

Replace with:

```ts
body: JSON.stringify({
  model,
  messages: history,
  stream: false,
  temperature: parseFloat(process.env.SUGGESTIONS_TEMPERATURE ?? '0.7'),
  max_tokens: parseInt(process.env.SUGGESTIONS_MAX_TOKENS ?? '500', 10),
}),
```

Defaults match what's recommended in `.env.example` so users who don't override get sensible behavior automatically.

### Part 4 — Documentation

In CLAUDE.md, find the existing "Suggested next prompts" section and update the endpoint reference:

> **Suggester model.** Suggestions use `SUGGESTIONS_LLM_ENDPOINT` / `SUGGESTIONS_LLM_MODEL` — independent from polish, storyboard, and writer endpoints. Best fit is a small instruction-tuned model (Qwen Coder, Llama Instruct, etc.) for 5-10s response times; creative-writing models work but are slow. Sampling defaults (`SUGGESTIONS_TEMPERATURE=0.7`, `SUGGESTIONS_MAX_TOKENS=500`) tuned for structured output. Timeout default 30s via `SUGGESTIONS_TIMEOUT_MS`.

Update the existing "LLM endpoints" table or list (if there is one) to include the new four vars.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `.env.example` has `SUGGESTIONS_LLM_ENDPOINT`, `SUGGESTIONS_LLM_MODEL`, `SUGGESTIONS_TIMEOUT_MS`, `SUGGESTIONS_TEMPERATURE`, `SUGGESTIONS_MAX_TOKENS` documented.
- The suggestions route reads from the new env vars, not from `WRITER_LLM_*`.
- `grep -n "WRITER_LLM" src/app/api/chats/[id]/messages/[msgId]/suggestions/route.ts` returns nothing.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test:

1. **Set the new env vars.** Copy the new section from `.env.example` into `.env`. Point `SUGGESTIONS_LLM_ENDPOINT` and `SUGGESTIONS_LLM_MODEL` at the polisher's running endpoint (or whatever small instruction model is preferred). Restart `npm run dev`.

2. **Verify config picked up.** Send a chat directive. Watch the dev terminal for `[suggestions]` logs. Confirm the request goes to the configured endpoint (verify by checking which model server's logs show the incoming request).

3. **Verify speed.** Suggestions should now appear within 5-10 seconds of the main response completing, vs the previous 30-60 seconds with the writer model.

4. **Verify pills render.** Pills appear above composer with three distinct labels. Tap one — composer fills with the prompt body.

5. **Missing config regression.** Comment out `SUGGESTIONS_LLM_ENDPOINT` in `.env`, restart, send a chat. Confirm no pills appear (suggestions endpoint returns empty), and the dev terminal shows the warn line about missing endpoint.

6. **Disk-avoidance regression.** Generate an image and a video. Confirm `ssh <gpu-vm> ls /models/ComfyUI/output/*.png 2>&1` returns "no such file."

---

## Out of scope

- Auto-detecting whether to use the writer or polisher endpoint based on response time. User configures explicitly.
- A UI surface for changing the suggestions endpoint without restarting. `.env` + restart is the operator path.
- Per-chat suggestions endpoint override. One endpoint per app instance.
- Streaming the suggestions response progressively. Different feature; revisit if speed still feels off after the model switch.
- Adding fallback chains (try suggestions endpoint, fall back to writer if unreachable). Single endpoint per feature; if it's down, no suggestions.

---

## Documentation

CLAUDE.md updates per Part 4.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
