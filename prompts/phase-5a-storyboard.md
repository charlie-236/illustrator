# Batch — Phase 5a: Storyboard data model + LLM generation

Phase 5 introduces storyboards: AI-generated scene-by-scene plans that live on a project. The user describes a story idea in natural language; the local LLM produces N scenes, each with a description, a Wan-friendly prompt, and a suggested duration. The storyboard renders read-only in Project Detail.

This batch is **5a — the foundation**. It establishes the schema, the LLM integration pattern, and the read-only display. **5b** (next batch, separate) adds per-scene generation buttons, scene-to-clip linkage, edit affordances, and last-frame chaining.

Storyboards live as a `Json?` column on `Project`. They're not standalone objects — they belong to a project the way clips do. The Project Detail view gets a new collapsible section above the existing "Generate" buttons.

The LLM call mirrors the existing polisher's integration shape exactly: same `LLM_ENDPOINT` (one local LLM tunnel, OpenAI-compatible chat completions), but a separate `STORYBOARD_LLM_MODEL` env var so the model identifier can be swapped independently of polish. Same fetch + AbortController + graceful-degradation pattern. Different sampling params (creative output wants higher temperature than polish's 0.15).

Re-read CLAUDE.md before starting, particularly the polisher route (`src/app/api/generate/polish/route.ts`) and its prompt module — the shape, error handling, and env var pattern there is what this batch replicates.

---

## Critical: disk-avoidance and tablet UX

This batch doesn't touch the workflow build path, the WS finalize path, or any image/video generation logic. The forbidden-class-type guards are unaffected. Verify post-implementation with the standard greps.

The Project Detail storyboard section is a primary UI surface. Tablet-first design rules apply throughout:
- Tap targets ≥44–48px (use `min-h-12` or equivalent on all buttons / interactive rows)
- Generous spacing between scenes; scenes shouldn't feel cramped
- Modal dialogs use bottom-sheet pattern on narrow viewports (mirror existing `StitchModal` / `DeleteConfirmDialog` patterns)
- Loading states are explicit; LLM calls take 30–90 seconds and the user must see what's happening

---

## Required changes

### Part 1 — Schema

`prisma/schema.prisma`:

```prisma
model Project {
  // ... existing fields ...
  storyboardJson Json?    // null = no storyboard. Object: { scenes: StoryboardScene[], generatedAt: string, storyIdea: string }
}
```

Apply via `npx prisma db push`. Existing rows backfill with null.

### Part 2 — Types

`src/types/index.ts`:

```ts
/** A single scene within a storyboard. LLM-generated; user-editable in Phase 5b. */
export interface StoryboardScene {
  id: string;                 // cuid; generated server-side
  position: number;           // 0-indexed
  description: string;        // LLM-generated; human-readable narrative summary
  positivePrompt: string;     // LLM-generated; Wan 2.2-friendly prose for video generation
  durationSeconds: number;    // LLM-suggested; integer 2-7 typically
}

/** A storyboard belongs to a project. Stored as Project.storyboardJson. */
export interface Storyboard {
  scenes: StoryboardScene[];
  generatedAt: string;        // ISO timestamp
  storyIdea: string;          // user's original input — preserved for display and regeneration prefill
}
```

Update `ProjectDetail` (the API response shape, not the React component) to include a hydrated `storyboard: Storyboard | null` field. The route at `src/app/api/projects/[id]/route.ts` already returns the project — extend its select/include to surface `storyboardJson`, and shape the response so the field is named `storyboard` (not `storyboardJson`) on the client side.

### Part 3 — Env vars

`.env.example` — add a new "Storyboard" section after the existing "LLM / Prompt Polish" section:

```
# ── LLM / Storyboard Generation ───────────────────────────────────────────────
# Storyboards reuse LLM_ENDPOINT above (same OpenAI-compatible tunnel).
# Model and sampling are separate from polish so they can be tuned independently.

# Model identifier passed to the LLM as the `model` field for storyboard requests.
# Can match POLISH_LLM_MODEL or differ (different .gguf for creative writing vs prompt expansion).
# Missing means storyboard requests fail with reason: llm_error (graceful degradation).
STORYBOARD_LLM_MODEL=/path/to/your/model.gguf

# Storyboard call timeout in milliseconds. Default 60000 (60 seconds).
# Storyboards are 5+ scenes of structured creative output — longer than polish.
STORYBOARD_TIMEOUT_MS=60000

# Sampling params for storyboard generation. Higher temperature than polish for
# creative output, but capped to keep the structured format stable.
STORYBOARD_TEMPERATURE=0.7
STORYBOARD_TOP_P=0.9
STORYBOARD_MAX_TOKENS=3000
```

`LLM_ENDPOINT` is shared with the polisher — already documented; no change.

### Part 4 — LLM route

`src/app/api/storyboard/generate/route.ts` — mirror `src/app/api/generate/polish/route.ts`'s structure exactly. Same imports pattern, same `runtime = 'nodejs'`, same `dynamic = 'force-dynamic'`.

Request body:

```ts
interface StoryboardGenerateRequest {
  projectId: string;
  storyIdea: string;          // 1-4000 chars, the user's natural-language input
  sceneCount?: number;        // optional hint, default 5; clamped 3-10
}
```

Response:

```ts
interface StoryboardGenerateResponse {
  storyboard: Storyboard;     // when ok
  ok: true;
}
// OR
interface StoryboardGenerateError {
  ok: false;
  reason: 'timeout' | 'llm_error' | 'parse_error' | 'no_scenes' | 'project_not_found' | 'invalid_input';
  rawOutput?: string;         // when reason === 'parse_error', surface to UI for user inspection
  message?: string;           // human-readable for invalid_input
}
```

Validation:
- `storyIdea` required, 1-4000 chars after trim. Reject with `400 invalid_input` if missing/empty/too-long.
- `sceneCount` optional; if present, must be int 3-10 (clamp silently if outside range).
- `projectId` must reference an existing project (return `400 project_not_found` if not).

Flow:
1. Validate input.
2. Fetch project for `styleNote` to include in LLM context.
3. Build user message with story idea + styleNote + scene count hint.
4. Call LLM via `callLLM(userMessage)` (a function that mirrors the polisher's `callLLM` — same fetch shape, env-driven sampling, AbortController timeout).
5. Parse the structured output via `parseStoryboard(raw)` (see Part 5).
6. If parse fails: return `{ ok: false, reason: 'parse_error', rawOutput: raw }` with HTTP 200. The route always returns 200 — failure modes are in the body, mirroring polish's graceful-degradation pattern.
7. If parse succeeds: build the `Storyboard` object with cuid'd scene ids, position values 0..N-1, ISO timestamp, original storyIdea. **Don't persist here** — return the storyboard for the client to confirm.
8. Persistence happens in a separate route (Part 6) so the user has a chance to confirm before overwriting an existing storyboard.

The route is **stateless** — it generates and returns; doesn't mutate the DB. A separate PUT route saves.

The fetch / env / timeout / abort pattern is byte-for-byte the polisher's:

```ts
async function callLLM(userPrompt: string): Promise<string> {
  const endpoint = process.env.LLM_ENDPOINT;
  const model = process.env.STORYBOARD_LLM_MODEL;
  if (!endpoint || !model) {
    throw new Error("LLM_ENDPOINT or STORYBOARD_LLM_MODEL not set");
  }

  const timeoutMs = parseInt(process.env.STORYBOARD_TIMEOUT_MS ?? "60000", 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: STORYBOARD_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: parseFloat(process.env.STORYBOARD_TEMPERATURE ?? "0.7"),
        top_p: parseFloat(process.env.STORYBOARD_TOP_P ?? "0.9"),
        max_tokens: parseInt(process.env.STORYBOARD_MAX_TOKENS ?? "3000", 10),
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("LLM returned empty content");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}
```

No retry on storyboard generation. Polish retries because weight-token preservation is binary (right or wrong) and a second roll often passes. Storyboards are creative output where the first valid result is the right one to surface. If the user wants different scenes, they regenerate.

### Part 5 — System prompt + parser

`src/app/api/storyboard/generate/prompt.ts` — exports `STORYBOARD_SYSTEM_PROMPT` and a `buildUserMessage(storyIdea, styleNote, sceneCount)` helper.

Use a structured non-JSON format. Local LLMs are bad at strict JSON; they're better at `[BLOCK]` headers + `KEY: value` lines (this is exactly what the polisher uses, for the same reason).

The system prompt instructs the model to:

1. Output exactly the structured block format below — no preamble, no commentary, no markdown code fences, no JSON.
2. Produce 3-7 scenes (use the user's hint if provided, else 5).
3. Each scene's `DESCRIPTION` is one to two sentences of human-readable narrative — what happens in the scene from the viewer's perspective.
4. Each scene's `PROMPT` is a Wan 2.2-friendly prose video prompt: descriptive, includes subject + action + setting + lighting + camera language. Avoid SD-style comma-separated tags. Do not include negative prompt content.
5. Each scene's `DURATION` is an integer between 2 and 7 (seconds). Most scenes are 3-4 seconds; only use 5+ for slower establishing shots or complex action.
6. Apply the project's style note to every PROMPT if provided, blending it naturally into each prompt rather than appending verbatim.
7. The narrative should flow scene-to-scene; later scenes should feel like continuations of earlier ones (visual continuity, character continuity).

Output format (strict):

```
[SCENE 1]
DESCRIPTION: <one or two sentences>
PROMPT: <Wan-friendly prose prompt>
DURATION: <integer 2-7>

[SCENE 2]
DESCRIPTION: ...
PROMPT: ...
DURATION: ...

(continue for all scenes; no closing block, no commentary after the last scene)
```

`buildUserMessage` constructs:

```
Story idea: <user's storyIdea>

Number of scenes: <sceneCount>

Project style note: <styleNote, or "(none)">

Generate the storyboard now using the format from your instructions.
```

`src/app/api/storyboard/generate/parse.ts` — exports `parseStoryboard(raw: string): StoryboardScene[] | null`.

Parser strategy (defensive, in order):
1. Strip leading/trailing whitespace.
2. Strip any markdown code fences (```...```) the model might wrap output in (a common local-LLM tic). The strip should be tolerant — match either ``` or ```text on the opening.
3. Split on `/\[SCENE \d+\]/` — produces N+1 chunks where chunk 0 is preamble (often empty) and chunks 1..N are scene bodies.
4. For each scene chunk, extract `DESCRIPTION:`, `PROMPT:`, `DURATION:` via per-key regex. Be tolerant of:
   - Variable whitespace after the colon
   - Multi-line values (DESCRIPTION and PROMPT may span lines until the next KEY: marker)
   - Different case in keys (DESCRIPTION / Description / description) — match case-insensitively
   - Missing trailing newline before the next [SCENE N]
5. DURATION: parse as int; clamp to 2-7 if outside range. If unparseable, default to 4.
6. If any scene is missing both DESCRIPTION and PROMPT, return null (parse failure).
7. If 0 scenes parsed, return null.
8. Return an array of partial scenes (no `id`, no `position` — those are filled in by the route).

Add unit-test-style verification in the PR description: paste 3-4 example LLM outputs (well-formed, fenced, with extra preamble, with malformed durations) and confirm the parser handles each correctly. Don't add an actual Jest test file unless the codebase already has them; the manual smoke test is the validation.

### Part 6 — Persistence route

`src/app/api/projects/[id]/storyboard/route.ts` — PUT and DELETE.

**`PUT`** — saves a storyboard atomically. Body: `{ storyboard: Storyboard }`. Replaces any existing storyboard. Returns `{ project: ProjectDetail }` with the updated project hydrated.

Validation:
- Storyboard scenes array length 1-20 (defensive cap).
- Each scene has non-empty `description`, `positivePrompt`, integer `durationSeconds` 1-10.
- Reject malformed with 400.

**`DELETE`** — clears the storyboard. Sets `storyboardJson` to `null`. Returns `{ project: ProjectDetail }`.

No partial updates. The whole storyboard is the unit of persistence in 5a.

### Part 7 — Project Detail UI

`src/components/ProjectDetail.tsx` gets a new section. Position: directly below the project header, above the "Generate image / Generate clip" buttons (post-H5).

#### Empty state (no storyboard)

```
┌────────────────────────────────────────────┐
│  📓 Storyboard                              │
│                                              │
│  Plan your project with AI. Describe a       │
│  story idea and generate a scene-by-scene    │
│  outline you can use to guide your clips.    │
│                                              │
│  [ + Plan with AI ]                          │
└────────────────────────────────────────────┘
```

The "Plan with AI" button opens the `StoryboardGenerationModal` (Part 8).

#### Populated state

```
┌────────────────────────────────────────────┐
│  📓 Storyboard ▼ (collapse toggle)          │
│  Generated <relative time> · <N> scenes     │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │ Scene 1 · 4s                         │   │
│  │ A young girl climbs creaky stairs    │   │
│  │ into a dusty attic.                  │   │
│  │                                       │   │
│  │ <prompt in smaller monospace text>    │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │ Scene 2 · 3s                         │   │
│  │ ...                                   │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  [ Regenerate ]   [ Delete storyboard ]     │
└────────────────────────────────────────────┘
```

Section is collapsible (click header to toggle). Default expanded if storyboard exists, collapsed if not. State is local — doesn't persist across page reloads (sessionStorage is fine if trivial; otherwise just default-on-mount).

Each scene row: scene number + duration badge in the header line, description prominent, prompt below in smaller `font-mono text-xs text-zinc-500` for reference. No edit affordance in 5a — purely read-only.

Scene cards use existing card styling (`bg-zinc-800/60 rounded-lg p-3`-ish, mirror what `VideoLoraStack` rows look like).

#### Regenerate flow

Tap "Regenerate" → `DeleteConfirmDialog`-style confirm:

> This will replace your existing storyboard with a new one.
>
> The current storyboard's scenes will be lost. Any clips already generated from those scenes (Phase 5b) will remain in your project.
>
> [ Cancel ]   [ Regenerate ]

(In 5a, "clips already generated from those scenes" doesn't apply because 5b hasn't shipped — but the language anticipates it. Adjust if it reads weird in 5a-only context.)

If confirmed, opens the `StoryboardGenerationModal` pre-filled with the existing storyboard's `storyIdea` (so the user can tweak, not retype).

#### Delete flow

Tap "Delete storyboard" → `DeleteConfirmDialog`:

> Delete this project's storyboard?
>
> This removes the scene plan only. Project clips are not affected.
>
> [ Cancel ]   [ Delete ]

Calls `DELETE /api/projects/[id]/storyboard`. On success, section transitions to empty state.

### Part 8 — Storyboard generation modal

New component, `src/components/StoryboardGenerationModal.tsx`. Bottom-sheet pattern on narrow viewports (mirror `StitchModal`'s structure).

#### Idle state

```
┌────────────────────────────────────────────┐
│  Plan with AI                          [×]  │
├────────────────────────────────────────────┤
│  Describe your project's story idea. The    │
│  LLM will break it into scenes you can      │
│  use to guide clip generation.              │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │                                       │   │
│  │  <large textarea, 6-8 rows>           │   │
│  │                                       │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  Number of scenes: [ — ] 5 [ + ]             │
│                                              │
│  [ Cancel ]            [ Generate ]         │
└────────────────────────────────────────────┘
```

Textarea: at least 6 visible rows. Placeholder: "A young girl finds a magical book in her grandmother's attic. She opens it and gets transported to a fantasy world..."

Scene count: number stepper (− / + buttons + display). Range 3-10. Default 5. Tablet-friendly: stepper buttons ≥44px each.

Generate button: disabled while textarea is empty; min length client-side check 10 chars before enabling.

#### Loading state

Replace the form with an in-modal loading view:

```
┌────────────────────────────────────────────┐
│  Plan with AI                          [×]  │  ← X disabled during loading
├────────────────────────────────────────────┤
│                                              │
│      Generating storyboard...                │
│      <spinner>                               │
│                                              │
│      This usually takes 30-60 seconds.       │
│                                              │
│      [ Abort ]                               │
└────────────────────────────────────────────┘
```

Abort button uses an AbortController on the fetch — same pattern as Studio's video submit.

#### Success state

LLM returned valid storyboard. Auto-PUT to `/api/projects/[id]/storyboard`. On PUT success: close modal; ProjectDetail re-fetches the project (or receives the response inline) and renders the new storyboard.

#### Failure states

- `reason: 'timeout'` — show: "The LLM took too long to respond. Try again or check that the LLM service is running." with [ Retry ] [ Close ] buttons.
- `reason: 'llm_error'` — same UI; message: "Couldn't reach the LLM service. Check that it's running and try again."
- `reason: 'parse_error'` — show: "The LLM returned output we couldn't parse." Below: a collapsed "Show raw output" disclosure that expands to a `<pre>` block with `rawOutput`. Buttons: [ Retry ] [ Close ]. The raw output disclosure is essential for local-LLM debugging — when format issues happen, the user needs to see what came back.
- `reason: 'no_scenes'` — message: "The LLM didn't produce any scenes. Try rephrasing your story idea."

All failure states keep the user's storyIdea visible for retry.

### Part 9 — Project Detail data flow

The project fetch already returns `ProjectDetail`. Extend the response shape to include `storyboard: Storyboard | null` (parsed from `storyboardJson`).

The `ProjectDetail` component holds storyboard state alongside its existing project state. After successful generate / delete, refresh the project (re-fetch from `GET /api/projects/[id]` is fine — the cost is negligible and it keeps state in sync without manual splicing).

### Part 10 — No Studio changes

5a is read-only. The "Generate this scene" buttons, scene-to-clip linkage, and last-frame chaining are all 5b. Studio doesn't know about scenes yet.

Don't touch:
- `src/components/Studio.tsx`
- `src/lib/wan22-workflow.ts`
- `src/lib/comfyws.ts`
- The `Generation` schema
- Any video / image / stitch route

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "storyboardJson" prisma/schema.prisma` shows the field on `Project`.
- `npx prisma db push` applies cleanly. Existing rows have null storyboardJson.
- `grep -rn "STORYBOARD_LLM_MODEL\|STORYBOARD_TIMEOUT_MS\|STORYBOARD_TEMPERATURE\|STORYBOARD_TOP_P\|STORYBOARD_MAX_TOKENS" .env.example` returns matches for all five.
- The new files exist:
  - `src/app/api/storyboard/generate/route.ts`
  - `src/app/api/storyboard/generate/prompt.ts`
  - `src/app/api/storyboard/generate/parse.ts`
  - `src/app/api/projects/[id]/storyboard/route.ts`
  - `src/components/StoryboardGenerationModal.tsx`
- The storyboard route uses `process.env.LLM_ENDPOINT` (shared with polisher) and `process.env.STORYBOARD_LLM_MODEL` (separate).
- The storyboard route always returns HTTP 200 (failures in body, mirroring polisher's pattern). Never throws to client.
- `grep -n "storyboard" src/components/ProjectDetail.tsx` shows the new UI section integration.
- `grep -n "<Studio" src/` is unchanged from pre-batch — no Studio modifications.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. **Schema migration.** Apply `npx prisma db push`. Confirm `storyboardJson` column on `Project` table (Prisma Studio or `psql`). Existing projects have null.
2. **Empty state.** Open a project. Confirm the new Storyboard section is visible above the Generate buttons. CTA button "Plan with AI" present.
3. **Generation happy path.** Click Plan with AI. Modal opens. Type a story idea ("A detective enters an abandoned warehouse looking for clues. She finds a hidden room. She discovers what she was looking for."). Default 5 scenes. Click Generate.
4. Confirm loading state appears within 1 second. Wait for LLM (30-90s typical). Confirm the storyboard appears in the project section, modal closed, scenes render.
5. **Scene rendering.** Confirm each scene shows: scene number, duration badge, description, prompt (in smaller monospace text). Tap-targets are tablet-friendly.
6. **Collapse / expand.** Tap section header. Confirm it collapses. Tap again — expands. State doesn't need to persist across reload.
7. **Regenerate flow.** Tap Regenerate. Confirm dialog appears with replace warning. Cancel — dialog closes, no change. Tap Regenerate again, confirm — modal opens pre-filled with previous storyIdea. Tweak and regenerate. Confirm new scenes replace old.
8. **Delete flow.** Tap Delete storyboard. Confirm dialog. Cancel + verify nothing changes. Tap Delete + confirm — section transitions to empty state.
9. **Style note integration.** Set the project's styleNote to something distinctive (e.g. "noir black-and-white film grain, 1940s aesthetic"). Generate a storyboard. Confirm the LLM-generated PROMPTs reflect the style note in some scenes.
10. **LLM unreachable.** Stop the LLM service (or set `STORYBOARD_LLM_MODEL` to an invalid path). Try to generate. Confirm a friendly error appears in the modal (not a crash). Storyboard isn't persisted.
11. **Parse error surfacing.** This one's hard to trigger reliably without modifying the LLM's behavior. To force-test: temporarily edit the parser's regex to never match, regenerate, confirm the "Show raw output" disclosure surfaces the LLM's actual response. Revert the parser change.
12. **Timeout.** Set `STORYBOARD_TIMEOUT_MS=5000` (5 seconds). Generate. Confirm timeout error appears in the modal, no partial data persisted. Reset env var.
13. **Abort during loading.** Start a generation. Tap Abort during the loading state. Confirm the modal returns to idle state with the user's input preserved. No data persisted.
14. **Project reload regression check.** Generate a storyboard. Hard-reload the page. Confirm the storyboard re-renders correctly from DB.
15. **No Studio regressions.** Generate a clip, generate an image, run a stitch — all should work as before. Storyboards are passive in 5a; Studio doesn't yet know about them.
16. **Concurrent project load.** Open a project with no storyboard, switch to another project that has one, switch back. Confirm UI state matches each project's actual data (no cross-contamination).

---

## Out of scope

- **All of 5b.** No per-scene Generate buttons, no `Generation.sceneId` schema field, no last-frame chaining, no edit affordance for scenes, no canonical-clip picker, no clip-back-to-scene badges. 5b is its own batch.
- **Iterative LLM editing** ("rewrite scene 3", "add a scene"). Phase 5c or later.
- **Storyboard versioning** (history, undo, branching). Single live storyboard per project; replace-on-regenerate is the model.
- **Storyboard export** (download as JSON / markdown). Out of scope.
- **Storyboard sharing or templates**. Out of scope.
- **Scene reordering via drag.** 5b or later.
- **Notes field on scenes.** 5b adds it.
- **Storyboard-from-existing-clips** (reverse direction: generate a storyboard from clips you already have). Out of scope.
- **Multi-project storyboards** (one storyboard spanning multiple projects). Storyboards belong to one project.
- **JSON output format from the LLM.** Use the structured block format described in Part 5. Local LLMs are unreliable with strict JSON; the block format is what works.
- **Streaming the LLM output.** One-shot response. Streaming would require a different endpoint shape and complicates the parser; not worth the engineering for 30-90s generations where the user is fine waiting.
- **Authentication / authorization checks.** Single-user app; not relevant.
- **Rate limiting on the storyboard endpoint.** Single-user app; trust the user.
- **Analytics / usage tracking on storyboard generations.** Out of scope.
- **A reusable storyboard component for use elsewhere.** ProjectDetail is the only consumer.

---

## Documentation

In CLAUDE.md, add a new top-level section after the existing "Phase 4" section (or wherever phases are documented):

> ## Phase 5a — Storyboard data model + LLM generation
>
> Storyboards live as `Project.storyboardJson` (Json column). They're scene-by-scene plans for a project, generated by the local LLM from a user-provided story idea.
>
> **API:**
> - `POST /api/storyboard/generate` — generates a storyboard (stateless; doesn't persist). Returns `{ ok: true, storyboard }` or `{ ok: false, reason }` with rawOutput for parse_error. Always HTTP 200.
> - `PUT /api/projects/[id]/storyboard` — atomically saves a storyboard to a project, replacing any existing.
> - `DELETE /api/projects/[id]/storyboard` — clears the storyboard.
>
> **LLM integration:** mirrors the polisher's pattern. Uses shared `LLM_ENDPOINT` (one local LLM tunnel) with separate `STORYBOARD_LLM_MODEL` and sampling env vars (`STORYBOARD_TIMEOUT_MS`, `STORYBOARD_TEMPERATURE`, `STORYBOARD_TOP_P`, `STORYBOARD_MAX_TOKENS`). Output uses a structured `[SCENE N]` block format rather than JSON — local LLMs are more reliable with key:value blocks.
>
> **UI:** Project Detail has a new collapsible Storyboard section above the Generate buttons. Empty state offers "Plan with AI"; populated state shows scene cards (read-only in 5a, editable in 5b).
>
> **Phase 5b** adds per-scene Generate buttons, `Generation.sceneId` linkage, last-frame chaining between scenes, scene editing, and the canonical-clip picker.

In the source layout entries, add:
- `src/app/api/storyboard/generate/route.ts` — LLM call for storyboard generation; mirrors polisher pattern.
- `src/app/api/storyboard/generate/prompt.ts` — system prompt and user-message builder.
- `src/app/api/storyboard/generate/parse.ts` — defensive `[SCENE N]` block parser.
- `src/app/api/projects/[id]/storyboard/route.ts` — PUT (save) and DELETE (clear) for project storyboards.
- `src/components/StoryboardGenerationModal.tsx` — modal for generating a new storyboard (idle / loading / success / failure states).

In the env vars section, document the new STORYBOARD_* variables alongside the POLISH_* ones.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
