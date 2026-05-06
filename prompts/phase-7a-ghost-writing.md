# Batch — Phase 7a: Ghost writing chat (foundation)

Phase 7 introduces a new primary surface: chat. The user directs a story by sending short instructions; the LLM expands each into prose. The user is **not writing**; they are **directing**. The LLM's responses are the actual story text; the user's messages are scaffolding.

This is **7a** — the foundation. It establishes:
- The chat data model (Chat, Message, plus branching-shape fields used by 7b)
- The director-mode system prompt
- Streaming responses with a stop button (Aphrodite Engine, OpenAI-compatible streaming)
- Per-chat sampling parameters with three seeded presets
- Server-side token counting via Aphrodite's tokenize endpoint
- Markdown rendering with a dialogue-coloring heuristic
- `<think>` tag handling (collapsed peek)
- A new top-level "Chats" tab parallel to Studio / Projects / Gallery / Models / Admin

Out of scope for 7a (deferred to 7b/c/d):
- **Editing messages, regeneration, branching UI** — schema includes the fields, but UI ships in 7b
- **Characters as first-class entities with associated images** — 7c
- **Manual context summarization with trimming** — 7c
- **Project association** — chats are standalone in 7a; loose coupling to projects in 7d
- **Search across chats** — 7d
- **Export to .md** — punted indefinitely per user

Re-read CLAUDE.md before starting, particularly the storyboard generate route (`src/app/api/storyboard/generate/route.ts`) — its fetch + AbortController + graceful-degradation pattern is what this batch's chat-completion calls mirror, but extended for streaming.

---

## Critical: disk-avoidance and tablet UX

This batch doesn't touch the workflow build path, the WS finalize path, or any image/video generation logic. The forbidden-class-type guards are unaffected. Verify post-implementation with the standard greps.

The Chats tab is a primary tablet surface. Tablet-first design rules apply throughout:
- Tap targets ≥44–48px on every button, message action, preset chip, parameter slider
- Generous spacing in the message list — long-form prose needs breathing room
- Modal dialogs use the bottom-sheet pattern (mirror existing `StitchModal`)
- Streaming display: tokens render as they arrive, no flicker, smooth scroll-to-bottom
- Stop button must be reachable at all times during streaming

---

## Required changes

### Part 1 — Schema

`prisma/schema.prisma`:

```prisma
model Chat {
  id                String         @id @default(cuid())
  name              String         @default("Untitled chat")
  systemPromptOverride String?     // null = use the canonical director-mode prompt
  samplingPresetId  String?
  samplingPreset    SamplingPreset? @relation(fields: [samplingPresetId], references: [id], onDelete: SetNull)
  // Per-chat sampling overrides; when null, fall back to preset; when preset null too, fall back to env defaults.
  samplingOverridesJson Json?      // Partial<SamplingParams>
  contextLimit      Int            @default(64000)
  createdAt         DateTime       @default(now())
  updatedAt         DateTime       @updatedAt
  messages          Message[]

  @@index([updatedAt])
}

model Message {
  id              String   @id @default(cuid())
  chatId          String
  chat            Chat     @relation(fields: [chatId], references: [id], onDelete: Cascade)
  role            String   // 'user' | 'assistant' | 'system'
  content         String   @db.Text  // raw including <think> tags
  parentMessageId String?  // null for first message; otherwise the message this one replies to / branches from
  branchIndex     Int      @default(0)  // 0 = primary; 1+ = alternate branches at this parent (used in 7b)
  createdAt       DateTime @default(now())

  parent          Message? @relation("MessageBranches", fields: [parentMessageId], references: [id], onDelete: SetNull)
  branches        Message[] @relation("MessageBranches")

  @@index([chatId, createdAt])
  @@index([parentMessageId, branchIndex])
}

model SamplingPreset {
  id          String   @id @default(cuid())
  name        String   @unique
  paramsJson  Json     // SamplingParams shape
  isBuiltIn   Boolean  @default(false)  // seeded presets cannot be deleted
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  chats       Chat[]
}
```

Apply via `npx prisma db push`. Three rows seed automatically on first request to `/api/sampling-presets` (see Part 4):

- **"Balanced"** (isBuiltIn: true): `{ temperature: 1.1, min_p: 0.05, dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2, max_tokens: 1500 }`
- **"Wild"** (isBuiltIn: true): `{ temperature: 1.3, min_p: 0.03, dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2, xtc_threshold: 0.1, xtc_probability: 0.5, max_tokens: 1500 }`
- **"Coherent"** (isBuiltIn: true): `{ temperature: 0.9, min_p: 0.08, dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2, max_tokens: 1500 }`

Built-in presets are user-editable but not deletable. The seeding logic checks for existence by `name` and inserts only the missing ones — idempotent on re-run.

The `parentMessageId` + `branchIndex` shape is **branching-ready** but not branching-active in 7a. Every message in 7a has exactly one branch (`branchIndex: 0`); 7b activates the multi-branch UI. Storing the shape now means 7b doesn't require a migration.

### Part 2 — Types

`src/types/index.ts`:

```ts
export interface SamplingParams {
  // Common creative-writing parameters surfaced in primary UI:
  temperature?: number;        // 0.0–2.0
  min_p?: number;              // 0.0–1.0; 0.05–0.1 typical
  max_tokens?: number;         // generation length cap
  // DRY anti-repetition (the three sub-params travel together):
  dry_multiplier?: number;     // 0 disables DRY; 0.8 typical
  dry_base?: number;           // 1.5–2.0 typical
  dry_allowed_length?: number; // 2 typical
  dry_sequence_breakers?: string[]; // default ["\n", ":", "\"", "*"]
  // Advanced (behind a disclosure):
  top_p?: number;              // 1.0 disables nucleus sampling (use min_p instead)
  top_k?: number;              // 0 disables
  repetition_penalty?: number; // 1.0 disables; conflicts with DRY — UI warns if both > 1
  frequency_penalty?: number;  // 0 disables
  presence_penalty?: number;   // 0 disables
  xtc_threshold?: number;      // XTC: 0.1 typical
  xtc_probability?: number;    // 0 disables; 0.5 typical
  typical_p?: number;          // 1.0 disables
  mirostat_mode?: number;      // 0 disables; 2 = Mirostat 2.0
  mirostat_tau?: number;       // 5.0 typical
  mirostat_eta?: number;       // 0.1 typical
}

export interface ChatSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatRecord {
  id: string;
  name: string;
  systemPromptOverride: string | null;
  samplingPresetId: string | null;
  samplingPreset: SamplingPresetRecord | null;
  samplingOverridesJson: Partial<SamplingParams> | null;
  contextLimit: number;
  createdAt: string;
  updatedAt: string;
  messages: MessageRecord[];
}

export interface MessageRecord {
  id: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  parentMessageId: string | null;
  branchIndex: number;
  createdAt: string;
}

export interface SamplingPresetRecord {
  id: string;
  name: string;
  paramsJson: SamplingParams;
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### Part 3 — Env vars

`.env.example` — new section after the storyboard LLM section:

```
# ── LLM / Writer (Ghost Writing chat) ─────────────────────────────────────────
# Aphrodite Engine endpoint for long-form creative writing chat. Independent
# from polish and storyboard endpoints — typically a different port hosting a
# larger / more capable model (e.g., Midnight Miqu 70B).
# Required when chat is used; chat send returns 502 if unset or unreachable.
WRITER_LLM_ENDPOINT=http://127.0.0.1:2242/v1/chat/completions

# Aphrodite tokenize endpoint — same host/port as WRITER_LLM_ENDPOINT, /v1/tokenize path.
# Used for server-side token counting on the chat composer.
WRITER_LLM_TOKENIZE_ENDPOINT=http://127.0.0.1:2242/v1/tokenize

# Model identifier passed to Aphrodite as the `model` field.
# For Aphrodite-served HF models this is the HuggingFace repo id; for local
# safetensors directories or GGUFs, the path Aphrodite was launched with.
WRITER_LLM_MODEL=path/or/repo-id

# Default context limit used as Chat.contextLimit's default for new chats.
WRITER_DEFAULT_CONTEXT_LIMIT=64000

# Default sampling params used when a new chat has no preset and no overrides.
# These match the "Balanced" preset.
WRITER_DEFAULT_TEMPERATURE=1.1
WRITER_DEFAULT_MIN_P=0.05
WRITER_DEFAULT_DRY_MULTIPLIER=0.8
WRITER_DEFAULT_DRY_BASE=1.75
WRITER_DEFAULT_DRY_ALLOWED_LENGTH=2
WRITER_DEFAULT_MAX_TOKENS=1500

# Writer call timeout in milliseconds. Long-form output can run 60-90s.
# Default 300000 (5 minutes); set higher if your model is slow on long context.
WRITER_TIMEOUT_MS=300000
```

Three layers of resolution at request time:
1. Env defaults (the `WRITER_DEFAULT_*` vars)
2. Chat's `samplingPresetId` (overrides env)
3. Chat's `samplingOverridesJson` (overrides preset)

The merge is shallow per-key: a chat with preset "Wild" plus an override `{ temperature: 1.0 }` uses Wild's full param set with temperature replaced. Implement this in `src/lib/writerSampling.ts` (new helper file).

### Part 4 — Sampling presets API

`src/app/api/sampling-presets/route.ts`:

- **GET** — returns `{ presets: SamplingPresetRecord[] }`. On first call, seeds the three built-in presets if absent (idempotent).
- **POST** — creates a user preset. Body: `{ name: string, paramsJson: SamplingParams }`. `name` must be unique (1–60 chars after trim); `isBuiltIn: false`.

`src/app/api/sampling-presets/[id]/route.ts`:

- **PATCH** — updates a preset. Body accepts `{ name?, paramsJson? }`. Both built-in and user presets are editable; built-ins keep `isBuiltIn: true`.
- **DELETE** — deletes a user preset. Built-in presets reject with 400 ("Built-in presets cannot be deleted"). Cascade: chats referencing the deleted preset have `samplingPresetId` set to null (handled by `onDelete: SetNull` in the schema).

### Part 5 — Chat CRUD API

`src/app/api/chats/route.ts`:

- **GET** — returns `{ chats: ChatSummary[] }` ordered by `updatedAt` desc. Each summary includes `messageCount` via a `_count` Prisma include.
- **POST** — creates a new chat. Body: `{ name?: string, samplingPresetId?: string | null }`. `name` defaults to "Untitled chat"; user can rename via PATCH. `contextLimit` defaults to `process.env.WRITER_DEFAULT_CONTEXT_LIMIT ?? 64000`.

`src/app/api/chats/[id]/route.ts`:

- **GET** — returns `{ chat: ChatRecord }` including all messages ordered by `createdAt` asc, branchIndex asc.
- **PATCH** — updates chat metadata. Body accepts `{ name?, systemPromptOverride?, samplingPresetId?, samplingOverridesJson?, contextLimit? }`. Validate: `name` 1–100 chars after trim; `contextLimit` integer 1024–262144; sampling overrides validated against `SamplingParams` shape.
- **DELETE** — deletes the chat (cascades to messages).

### Part 6 — Chat send (the streaming endpoint)

`src/app/api/chats/[id]/send/route.ts` — the heart of 7a.

Request body:

```ts
interface ChatSendRequest {
  userMessage: string;          // 1-50000 chars after trim
  parentMessageId: string | null; // for 7a always the latest assistant message id (or null if this is the first turn)
}
```

Response: streaming SSE. Events:

- `event: user_message_saved\ndata: {"id":"<cuid>"}` — fired immediately after the user message is persisted to DB (before the LLM call).
- `event: assistant_message_started\ndata: {"id":"<cuid>"}` — fired when the assistant message row is created (empty content) and streaming begins. Client uses this id to render an empty assistant bubble that fills in.
- `event: token\ndata: {"text":"..."}` — repeated, one per Aphrodite delta chunk's `choices[0].delta.content`.
- `event: done\ndata: {"id":"<cuid>","content":"<full text>","tokenCount":<n>}` — terminal success; full content for the assistant message.
- `event: error\ndata: {"message":"<human-readable>","reason":"timeout"|"llm_error"|"aborted"|"context_overflow"}` — terminal failure.

Server flow:

1. Validate input. Reject empty `userMessage` with 400.
2. Fetch the chat including all existing messages. If chat doesn't exist → 404.
3. Resolve sampling params via the three-layer merge (Part 3).
4. Construct the message list to send:
   - System message: `chat.systemPromptOverride ?? DIRECTOR_MODE_SYSTEM_PROMPT` (Part 8)
   - All existing messages in chat (role, content) in order
   - Append the new user message
5. Persist the new user message row immediately. Emit `user_message_saved`.
6. Create an empty assistant message row (so it has an id). Emit `assistant_message_started`.
7. POST to Aphrodite's `WRITER_LLM_ENDPOINT` with `stream: true`, the merged sampling params, and the message list. Use the existing AbortController + timeout pattern from the storyboard route, scaled to `WRITER_TIMEOUT_MS`.
8. Read the streaming response. Aphrodite emits SSE chunks of the form `data: {"choices":[{"delta":{"content":"..."}}]}\n\n` ending with `data: [DONE]\n\n`. For each non-`[DONE]` chunk:
   - Parse JSON, extract `choices[0].delta.content`.
   - Append to an in-memory accumulator string.
   - Emit `token` with the new content piece.
9. When Aphrodite's stream ends:
   - Update the assistant message row's `content` with the accumulated full text.
   - Compute the final token count by calling `WRITER_LLM_TOKENIZE_ENDPOINT` with the full message list.
   - Update the chat's `updatedAt` (Prisma does this automatically on update).
   - Emit `done` with the assistant message id, full content, and token count.
   - Close the SSE stream.
10. On error mid-stream: emit `error` with the appropriate reason; persist whatever partial content was accumulated to the assistant message row (so the user can edit/retry in 7b without losing partial output); close the stream. The assistant message row stays in the DB; partial content is acceptable.

**Stop button (client abort) flow:** The client's `fetch` uses an `AbortController`. When the user taps Stop, the client calls `controller.abort()`. The server detects the abort via the request's signal handler, propagates it to the Aphrodite fetch (also via AbortController), and emits `event: error\ndata: {"reason":"aborted"}` before closing. Persist accumulated partial content to the assistant message row before responding.

The assistant message row is never deleted on abort or error — partial content is the raw material for 7b's edit/regenerate.

### Part 7 — Tokenize endpoint

`src/app/api/chats/[id]/tokenize/route.ts`:

- **POST** — body: `{ pendingUserMessage?: string }`. Returns `{ tokenCount: number, contextLimit: number }`.

Implementation:

1. Fetch chat with messages.
2. Build the message list as Part 6 step 4 would (system + existing messages + optional pending user message).
3. POST to `WRITER_LLM_TOKENIZE_ENDPOINT` with `{ model: WRITER_LLM_MODEL, messages: [...] }` (Aphrodite supports the OpenAI tokenize-with-messages shape).
4. Return the token count and the chat's `contextLimit` for the client to display as `12,400 / 64,000`.

The client debounces calls to this endpoint at 500ms after the user stops typing in the composer.

### Part 8 — Director-mode system prompt

`src/lib/writerSystemPrompt.ts`:

```ts
export const DIRECTOR_MODE_SYSTEM_PROMPT = `You are a collaborative fiction writer working with a director.

The director will give you brief instructions about what should happen — character actions, plot beats, scene transitions, dialogue intent. Your role is to expand each instruction into vivid, well-crafted prose.

Follow these rules without exception:

1. Write the actual story text. Do not respond conversationally. Do not say "Sure, here's what happens next" or similar — your response IS what happens next, written as prose.

2. Maintain narrative continuity across turns. Treat each new directive as a continuation of the existing story, not a fresh start.

3. Write in third-person past tense unless the established narrative voice differs. Match the tone, register, and pacing of any prose already in the conversation.

4. Render dialogue inside double quotation marks. The user's UI applies dialogue coloring based on quote detection — keep dialogue cleanly quoted.

5. Expand directives with sensory detail, internal experience, and physical specificity. A directive like "She enters the room" should produce a paragraph of prose, not a single sentence.

6. Length: 300–1000 words per turn typically. Longer for major scene transitions or significant moments. Shorter when the directive is a small beat.

7. Do not summarize what the director said. Do not break the fourth wall. Do not address the director.

8. If you have a thinking process, you may use <think>...</think> tags before your prose. The user's UI displays thinking collapsed by default.`;
```

This prompt is the canonical default. Users override per-chat via `chat.systemPromptOverride`. The override completely replaces this prompt — no merge, no append.

### Part 9 — Sampling param resolution helper

`src/lib/writerSampling.ts`:

```ts
import type { SamplingParams } from '@/types';

export function envDefaultSamplingParams(): SamplingParams {
  return {
    temperature: parseFloat(process.env.WRITER_DEFAULT_TEMPERATURE ?? '1.1'),
    min_p: parseFloat(process.env.WRITER_DEFAULT_MIN_P ?? '0.05'),
    dry_multiplier: parseFloat(process.env.WRITER_DEFAULT_DRY_MULTIPLIER ?? '0.8'),
    dry_base: parseFloat(process.env.WRITER_DEFAULT_DRY_BASE ?? '1.75'),
    dry_allowed_length: parseInt(process.env.WRITER_DEFAULT_DRY_ALLOWED_LENGTH ?? '2', 10),
    max_tokens: parseInt(process.env.WRITER_DEFAULT_MAX_TOKENS ?? '1500', 10),
  };
}

export function resolveSamplingParams(
  presetParams: SamplingParams | null,
  overrides: Partial<SamplingParams> | null,
): SamplingParams {
  return {
    ...envDefaultSamplingParams(),
    ...(presetParams ?? {}),
    ...(overrides ?? {}),
  };
}

/** Strip undefined values; Aphrodite ignores unknown keys but cleaner to omit them */
export function samplingParamsForAphrodite(p: SamplingParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}
```

The merge is shallow per-key. If preset has DRY enabled (`dry_multiplier: 0.8`) and override sets `dry_multiplier: 0`, the override wins (DRY disabled for this chat).

### Part 10 — UI: Chats top-level tab

Add a new top-level tab "Chats" between "Gallery" and "Models" (or wherever feels natural in your tab order — verify with the existing nav).

`src/components/ChatsTab.tsx` — the top-level chats view. Two layouts:

**Empty state (no chats yet):**

```
┌────────────────────────────────────────────────────┐
│  ✍️ Chats                                           │
│                                                     │
│  Direct an LLM to write stories scene by scene.     │
│  Tell it what happens; it expands into prose.       │
│                                                     │
│         [ + New chat ]                              │
└────────────────────────────────────────────────────┘
```

**Populated state:**

```
┌────────────────────────────────────────────────────┐
│  ✍️ Chats                          [ + New chat ]   │
├────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────┐  │
│  │ The Lighthouse Keeper                          │
│  │ 14 messages · last active 2h ago               │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │ Untitled chat                                  │
│  │ 0 messages · created 5m ago                    │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

Tap a chat row → opens `ChatView` for that chat. Tap "New chat" → POST `/api/chats` with default name → opens the new ChatView.

### Part 11 — UI: ChatView

`src/components/ChatView.tsx` — the single-chat page. Layout:

```
┌─────────────────────────────────────────────────────────────┐
│  ← Chats │ The Lighthouse Keeper [✏️]    12,400 / 64,000 ⚙️  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  [user message bubble — small, dim, right-aligned]           │
│  > She walks to the lighthouse and looks out at the storm.   │
│                                                              │
│  [assistant message bubble — full width, prose-styled]       │
│  Hannah pushed open the heavy oak door. Wind tore at her     │
│  coat. Through the salt spray she could see the lighthouse,  │
│  its lantern flickering against the storm. "Not today,"      │
│  she muttered, gripping the railing. The waves crashed       │
│  below, hungry and dark.                                      │
│                                                              │
│  [💭 Thinking... (collapsed)]                                 │
│                                                              │
│  [user message bubble]                                        │
│  > She climbs the stairs.                                     │
│                                                              │
│  [assistant message bubble — currently streaming]             │
│  The spiral staircase wound upward into shadow▊               │
│  [Stop ◼]                                                     │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────┐    │
│  │ What happens next?                                    │    │
│  └──────────────────────────────────────────────────────┘    │
│                                       [Send]                  │
└─────────────────────────────────────────────────────────────┘
```

#### Header

- Back arrow (← Chats) — returns to chat list, preserves any in-flight stream (it continues running on the server; if you return to this chat, polling/refetch picks it up).
- Chat name with inline edit (mirror project rename pattern). Tap pencil icon → editable input → Enter saves → PATCH `/api/chats/[id]`.
- Token counter (right side): `12,400 / 64,000`. Color shifts amber > 80%, red > 95%. Tap → opens settings sheet (Part 13).
- Settings gear icon ⚙️ → opens settings sheet.

#### Message list

User messages render small, dim, italic, right-aligned in a narrower bubble — they're scaffolding, not prose.

Assistant messages render full-width with prose-friendly typography (large enough to read comfortably on tablet, generous line-height). Markdown rendered (Part 14). Dialogue heuristic colors (Part 14).

`<think>` blocks render as a collapsed disclosure above the prose: `[💭 Thinking... (tap to expand)]`. Expanding shows the reasoning in dim monospace, distinct from the prose. (Part 14.)

When an assistant message is currently streaming, render its bubble with a blinking cursor `▊` at the end, and show a `[Stop ◼]` button at the bottom of the bubble (or fixed at the bottom of the viewport — designer's call, but ensure it's reachable).

Auto-scroll to bottom while streaming. If the user scrolls up during streaming, freeze auto-scroll until they scroll back to bottom (mirror most chat UIs).

#### Composer

Multi-line textarea, expands as user types up to a max height. Send button to the right. Send is disabled when:
- Textarea is empty after trim
- A response is currently streaming (the Stop button takes over conceptually — user must wait for the current stream to finish or stop it before sending another)

Token counter updates with debounced server calls (Part 7) as the user types.

Tap Send:
1. Disable composer, show spinner on Send button.
2. POST to `/api/chats/[id]/send` via `fetch` with the body and an AbortController.
3. Read SSE response stream incrementally:
   - On `user_message_saved`: clear the composer, add the user message bubble to the list with the returned id.
   - On `assistant_message_started`: add an empty assistant bubble with the returned id; set it as the "currently streaming" message; reveal Stop button.
   - On `token`: append `text` to the streaming message's content. Re-render Markdown. Auto-scroll if user is at bottom.
   - On `done`: replace streaming content with full final content; remove "currently streaming" state; update token counter from response.
   - On `error`: show error toast; finalize the assistant bubble with whatever partial content exists; remove streaming state.
4. Re-enable composer after `done` or `error`.

Stop button: calls `controller.abort()`. Backend handles propagation to Aphrodite. Partial content stays in the message bubble.

#### Settings sheet

Bottom-sheet modal opened via gear icon or token counter tap.

Sections:

**Sampling preset**

```
Active preset: [ Balanced ▼ ]
              Temp 1.1 · min_p 0.05 · DRY on · max 1500
```

Dropdown lists all presets (built-in + user). Selecting one PATCHes the chat's `samplingPresetId`. Beneath the dropdown, current preset's params summary in dim text.

```
[ Save current as preset... ]   [ Manage presets ]
```

"Save current as preset" → modal asking for a name → POSTs `/api/sampling-presets` with the chat's currently-resolved params (preset + overrides merged).

"Manage presets" → opens the preset manager (Part 12).

**Per-chat overrides** (advanced disclosure, collapsed by default)

When expanded, shows the full SamplingParams form split into two tiers:

**Primary** (always visible inside the disclosure):
- Temperature (slider, 0–2, step 0.05)
- min_p (slider, 0–1, step 0.01)
- DRY on/off toggle. When on: dry_multiplier (slider 0–2 step 0.1), dry_base (slider 1–3 step 0.05), dry_allowed_length (number input 1–10).
- max_tokens (number input 100–8000)

**Advanced** (nested disclosure):
- top_p, top_k, repetition_penalty, frequency_penalty, presence_penalty
- XTC: xtc_threshold, xtc_probability
- typical_p
- mirostat: mirostat_mode (0 / 1 / 2), mirostat_tau, mirostat_eta

Each control writes to `chat.samplingOverridesJson` via debounced PATCH (500ms).

Validation warnings inline:
- DRY > 0 AND repetition_penalty > 1 → amber "DRY and repetition_penalty conflict — pick one."
- min_p > 0 AND top_p < 1 → amber "min_p and top_p both active — typically you want one or the other."

**System prompt override** (advanced disclosure, collapsed)

Large textarea pre-filled with the canonical director-mode prompt for reference. User edits to override. Empty value = use canonical default. PATCH on blur or explicit Save button.

**Context limit**

Number input, default 64000. Range 1024–262144. PATCH on blur. Affects the token counter's denominator.

**Delete chat**

Red destructive button at the bottom of the sheet. Confirm dialog before DELETE.

### Part 12 — Preset manager

`src/components/SamplingPresetsManager.tsx` — bottom-sheet modal listing all presets with edit / delete affordances.

Each row:
- Preset name
- Brief params summary (temp, min_p, DRY status, max_tokens)
- "Edit" button → opens the full SamplingParams editor
- "Delete" button (only on user presets, hidden on built-ins)

Built-in presets show a "built-in" badge and cannot be deleted. They CAN be edited — useful when a user wants to tune "Balanced" to their taste.

Top of sheet: "+ New preset" → editor with empty params (defaulting to env defaults).

### Part 13 — Markdown rendering with dialogue heuristic

`src/components/ChatMessage.tsx` — renders one assistant message.

For Markdown rendering: search the existing repo for a Markdown library before adding a new one. Likely candidates: `react-markdown`, `marked`, `markdown-it`. If one already exists in the codebase (used elsewhere), reuse it. If not, add `react-markdown` (well-maintained, React-native, supports plugins for the dialogue pass).

Pipeline:

1. Strip and extract `<think>...</think>` blocks from the content. Render them as a separate collapsed disclosure above the prose.
2. Render the remaining content as Markdown.
3. After Markdown renders, walk the DOM (or use a Markdown plugin / rehype plugin if using react-markdown) to find quoted strings: `"..."` (curly or straight quotes) and wrap each match in `<span class="dialogue">...</span>`.
4. CSS: `.dialogue { color: var(--violet-300); }` — soft violet, distinct from prose body color but matches the app's accent palette.

Dialogue heuristic edge cases (acceptable to break):
- Quoted titles: "The Great Gatsby" gets colored. Acceptable.
- Sarcasm marks: "smart" gets colored. Acceptable.
- Apostrophes treated as quote chars: don't (`'` should not trigger). Use `"` (straight double) and `\u201C` `\u201D` (smart double). Don't match single quotes.
- Multi-paragraph dialogue without re-quoting: only the first paragraph gets the open quote. The pattern `"word..."` matches per-paragraph; if dialogue spans paragraphs without closing quotes, only the first matched span colors. Acceptable; the LLM is instructed to keep dialogue cleanly quoted (system prompt rule 4).

`<think>` block extraction: regex `/<think>([\s\S]*?)<\/think>/g`. Capture the content; remove the tags from the message; render the captured content collapsed.

If a `<think>` block exists without a closing tag (model output truncated): treat everything from `<think>` to end-of-content as the thinking block; render an empty prose section with a note. Edge case; acceptable.

### Part 14 — Streaming markdown re-render

While a message is streaming, content arrives token-by-token. Naive approach: re-run the full Markdown + dialogue pipeline on every token.

This is fine for short messages but expensive for long-form (1500+ token) outputs. Optimization: only re-parse Markdown every N tokens (50 is a reasonable threshold) or every 250ms (debounced), whichever fires first. Between full re-parses, append raw text to the rendered output (no formatting until next re-parse).

When the stream completes (`done` event), do one final full re-render with all accumulated content.

If implementation complexity isn't worth it for first cut: re-parse on every token. Tablet hardware should handle it for typical message lengths. Optimize if perf actually feels bad.

### Part 15 — Aphrodite stream parsing helper

`src/lib/aphroditeStream.ts`:

```ts
/**
 * Parses Aphrodite/OpenAI-compatible streaming SSE chunks.
 * Yields content deltas as they arrive.
 */
export async function* parseAphroditeStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE chunks are separated by \n\n
      const messages = buffer.split('\n\n');
      buffer = messages.pop() ?? '';

      for (const message of messages) {
        const dataLine = message.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        const data = dataLine.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            yield delta;
          }
        } catch {
          // Malformed chunk; skip.
        }
      }
    }
  } finally {
    reader.cancel().catch(() => { /* ignore */ });
  }
}
```

Used by the `/api/chats/[id]/send` route to consume Aphrodite's stream.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `npx prisma db push` applies cleanly. New tables: `Chat`, `Message`, `SamplingPreset`.
- New env vars present in `.env.example`: `WRITER_LLM_ENDPOINT`, `WRITER_LLM_TOKENIZE_ENDPOINT`, `WRITER_LLM_MODEL`, `WRITER_DEFAULT_CONTEXT_LIMIT`, `WRITER_DEFAULT_TEMPERATURE`, `WRITER_DEFAULT_MIN_P`, `WRITER_DEFAULT_DRY_MULTIPLIER`, `WRITER_DEFAULT_DRY_BASE`, `WRITER_DEFAULT_DRY_ALLOWED_LENGTH`, `WRITER_DEFAULT_MAX_TOKENS`, `WRITER_TIMEOUT_MS`.
- Routes exist and respond correctly:
  - `GET/POST /api/chats`
  - `GET/PATCH/DELETE /api/chats/[id]`
  - `POST /api/chats/[id]/send` (streaming SSE)
  - `POST /api/chats/[id]/tokenize`
  - `GET/POST /api/sampling-presets`
  - `PATCH/DELETE /api/sampling-presets/[id]`
- New top-level tab "Chats" in the app navigation.
- New components exist: `ChatsTab.tsx`, `ChatView.tsx`, `ChatMessage.tsx`, `SamplingPresetsManager.tsx`.
- New helpers exist: `src/lib/writerSampling.ts`, `src/lib/writerSystemPrompt.ts`, `src/lib/aphroditeStream.ts`.
- The director-mode system prompt is present and used as default.
- Sampling preset seeding fires on first request to `/api/sampling-presets`; three presets ("Balanced", "Wild", "Coherent") are inserted with `isBuiltIn: true`.
- Built-in presets reject DELETE with 400.
- Sending a message:
  - Persists user message immediately.
  - Streams tokens to the client as they arrive from Aphrodite.
  - Renders Markdown progressively with dialogue coloring.
  - Persists final assistant message content on completion.
- Stop button (during streaming) calls AbortController; partial assistant content persists; client receives `error` with `reason: "aborted"`.
- Token counter updates as user types in composer (debounced 500ms via `/api/chats/[id]/tokenize`).
- `<think>` tags render as collapsed disclosure above prose.
- Dialogue (text in `"..."` or `\u201C...\u201D`) renders in violet-300 distinct from prose body color.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet, full sequence):

1. **Schema migration applied.** `npx prisma db push`. Confirm `Chat`, `Message`, `SamplingPreset` tables in DB.
2. **Preset seeding.** First load of `/api/sampling-presets` returns the three built-ins. Re-running doesn't duplicate.
3. **Empty Chats tab.** Navigate to Chats. Confirm empty state with "+ New chat" CTA.
4. **Create new chat.** Tap CTA. Confirm new chat opens. Title defaults to "Untitled chat". Settings sheet shows "Balanced" preset selected by default (because env defaults match Balanced; the preset isn't auto-assigned, but the resolved params match).
5. **Director-mode end-to-end.** In a fresh chat, type "She walks into a moonlit garden." Tap Send. Confirm:
   - User message bubble appears immediately.
   - Streaming assistant bubble appears, tokens arrive, prose builds in real-time.
   - The response is prose, not "Sure, here's what happens next" — the system prompt is doing its job.
   - Final response is Markdown-rendered with dialogue (if any) in violet.
6. **Stop mid-stream.** Send another directive. While the response is streaming, tap Stop. Confirm:
   - Stream halts.
   - Partial content remains in the assistant bubble.
   - Composer re-enables.
   - Refreshing the page shows the partial assistant message persisted.
7. **Continued conversation.** After 2-3 successful sends, scroll up. Confirm full conversation history. Token counter shows accurate cumulative count.
8. **Token counter live update.** Start typing a long directive. Confirm token counter updates as you type (with ~500ms lag).
9. **Switch sampling preset.** Open settings sheet, switch to "Wild". Send another directive. Output should feel meaningfully different (more varied / less predictable). No code regression — just confirm the preset's params reach Aphrodite.
10. **Custom params.** Open advanced overrides. Set temperature to 0.3. Send a directive. Output should feel tighter/more deterministic. PATCH writes the override; refreshing the page shows the override persisted in the chat's settings.
11. **Save preset.** Open settings sheet → "Save current as preset" → name it "My style". Confirm the preset shows in the dropdown and in the manager.
12. **Edit built-in preset.** Open preset manager → tap Edit on "Balanced" → bump temperature to 1.2 → save. Confirm change persists. Reload — still 1.2.
13. **Delete user preset.** In manager, delete "My style". Confirm gone. Try to delete "Balanced" — confirm rejected with error.
14. **System prompt override.** In a chat, edit the system prompt to something distinct (e.g., "You are a haiku poet. Respond only with haikus."). Send a directive. Confirm the LLM follows the new system prompt instead of director mode.
15. **`<think>` rendering.** If you have access to a thinking-capable model, swap `WRITER_LLM_MODEL` to it temporarily. Send a directive. Confirm `<think>` block renders collapsed; tap to expand reveals reasoning. (If no thinking model available, manually construct a test response with `<think>` tags via direct DB insert and reload — confirm rendering.)
16. **Markdown rendering.** Send a directive that elicits formatted output ("Use italics for her thoughts." or similar). Confirm asterisks render as italic, headings render as headings, etc.
17. **Dialogue coloring.** Send a directive that produces dialogue ("She greets him."). Confirm the spoken portion in `"..."` renders in violet, distinct from prose.
18. **Token overflow.** Manually fill a chat to >64000 tokens (or set contextLimit very low for testing). Confirm token counter goes red. Sending succeeds or fails based on Aphrodite's behavior — don't add client-side blocking; let the LLM/server respond.
19. **Long-form streaming perf.** Send a directive that triggers a long response (1000+ tokens). Confirm streaming feels smooth, no stuck UI, scroll behavior is correct.
20. **Chat list ordering.** Create three chats, send messages in different orders. Confirm Chats tab list is ordered by `updatedAt` desc.
21. **Chat rename.** Tap pencil on chat name in ChatView header. Confirm inline edit, Enter saves, name reflects in Chats tab list.
22. **Delete chat.** Open settings sheet, tap Delete, confirm. Chat disappears from list. Messages cascade-deleted from DB.
23. **Disk-avoidance regression.** Generate an image and a video in Studio. Confirm `ssh <gpu-vm> ls /models/ComfyUI/output/*.png 2>&1` returns "no such file." Chat work is independent of the disk-avoidance contract but verifying nothing regressed.
24. **Page reload mid-stream.** Send a long directive. While streaming, hard-reload the page. The stream is lost from the client, but: returning to the chat in the tab should show the partial assistant message that was persisted. (The server stream itself terminates when the client disconnects; this is acceptable for 7a. Reattach-on-reload is a 7d polish.)

---

## Out of scope

- **Editing user or assistant messages.** Schema supports it via the `parentMessageId` shape, but the UI for edit-and-regenerate is 7b.
- **Regenerating a response.** 7b. Each regeneration creates a new branch (`branchIndex` increments).
- **Branch navigation UI.** 7b. The "swipes" UX between alternate responses.
- **Continue-from-cursor (assistant prefill).** 7b. The `"The woman walked..." → edit to "The woman ran" → continue` pattern.
- **Truncate chat at message N.** 7b.
- **Characters as first-class entities with images/videos.** 7c.
- **Per-chat character selection / context injection.** 7c.
- **Manual context summarization.** 7c.
- **Project association.** 7d. Chats are standalone in 7a; the chat list is global, not per-project.
- **Search across chats.** 7d.
- **Export to .md.** Punted indefinitely per user.
- **Reattach to in-flight stream after page reload.** 7d polish; 7a leaves partial content in the assistant message row and accepts that the live stream is lost on reload.
- **Lorebook / triggered insertion.** 7c or later, possibly never (user said structured-per-entity is fine).
- **Image generation from chat content.** Future phase; not in 7.
- **Automatic context summarization.** Manual only per user; never automatic.
- **Multi-model A/B comparison.** Out of scope.
- **Chat templates / starter prompts.** Out of scope; user opens with whatever directive they choose.
- **Fork a chat.** Out of scope; if you want to branch a story, create a new chat.
- **Multiple system prompts per chat.** One system prompt per chat (override or default); no multi-prompt scaffolding.
- **Streaming token-rate display ("12 tok/s").** Nice-to-have; 7a leaves it off.
- **Mid-stream pause (not stop).** Aphrodite doesn't support pause; only abort. Out of scope.

---

## Documentation

In CLAUDE.md, add a Phase 7a section after the existing Phase 5/6 sections:

> ## Phase 7a — Ghost writing chat (foundation)
>
> A new top-level "Chats" tab. Each chat is a multi-turn conversation where the user **directs** and the LLM **expands directives into prose**. The user's messages are scaffolding; the assistant's messages are the actual story text.
>
> **Schema:** `Chat`, `Message` (with `parentMessageId` + `branchIndex` for 7b's branching), `SamplingPreset` (with three seeded built-ins: Balanced, Wild, Coherent).
>
> **LLM integration:** Aphrodite Engine via OpenAI-compatible streaming chat completions at `WRITER_LLM_ENDPOINT`. Token counting via `WRITER_LLM_TOKENIZE_ENDPOINT`. Independent from polish (`POLISH_LLM_ENDPOINT`) and storyboard (`STORYBOARD_LLM_ENDPOINT`) endpoints — typically a different port hosting a larger creative-writing model.
>
> **Streaming:** `/api/chats/[id]/send` returns SSE with events `user_message_saved`, `assistant_message_started`, `token` (repeated), `done`, `error`. Stop button uses AbortController; partial content persists.
>
> **Sampling resolution:** three layers — env defaults → chat preset → chat overrides. Merge is shallow per-key. Helper at `src/lib/writerSampling.ts`.
>
> **Director mode system prompt:** `src/lib/writerSystemPrompt.ts`. Instructs the LLM to expand directives into prose, never respond conversationally. User can override per-chat.
>
> **Markdown + dialogue heuristic:** assistant messages render as Markdown; quoted strings (`"..."` or `\u201C...\u201D`) get a `.dialogue` class for violet coloring. `<think>...</think>` blocks render as a collapsed disclosure above the prose.
>
> **Out of scope (7b/c/d):** message editing, regeneration, branching UI, characters with images, context summarization, project association.

In the schema doc block, add the three new models with field comments.

In the source layout, add:
- `src/components/ChatsTab.tsx` — top-level chats list / empty state
- `src/components/ChatView.tsx` — single-chat page with composer, streaming message list, settings sheet
- `src/components/ChatMessage.tsx` — single message renderer with Markdown + dialogue heuristic + `<think>` collapse
- `src/components/SamplingPresetsManager.tsx` — preset CRUD modal
- `src/lib/writerSampling.ts` — three-layer sampling param resolver
- `src/lib/writerSystemPrompt.ts` — director-mode canonical system prompt
- `src/lib/aphroditeStream.ts` — Aphrodite/OpenAI SSE delta parser

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
