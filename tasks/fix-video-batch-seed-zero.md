# Batch — Fix seed-zero bug in video batch generation

When generating multiple videos from the same starting image (i2v with batchSize > 1), all takes come back identical and report `seed: 0` in their gallery metadata. The video-side seed contract drifted from the image side during the `video-batch-support` batch, and the i2v workflow only writes the seed to one of the two `KSamplerAdvanced` nodes — leaving a literal `0` in the template default of the other. This batch realigns the contract and removes the literal-zero from the workflow JSON entirely.

Re-read CLAUDE.md before starting. Use `project_knowledge_search` to confirm current behavior before editing — image-side seed handling in `src/lib/workflow.ts` is the canonical reference.

---

## Root cause analysis (read before editing)

There are three places where the resolved seed could fail to randomize, and we don't yet know which is firing. The fix addresses all three defensively. After the fix lands, the smoke test will confirm seeds are non-zero and distinct per take.

**Drift 1 — route's seed-resolution contract.** `src/app/api/generate-video/route.ts` currently does:

```ts
const seed = typeof body.seed === 'number' && Number.isInteger(body.seed)
  ? body.seed
  : Math.floor(Math.random() * 2 ** 32);
```

The image route uses the canonical `-1` sentinel:

```ts
const seed = params.seed === -1
  ? Math.floor(Math.random() * 2 ** 32)
  : params.seed;
```

The video route's contract treats `-1` as a literal seed, not a randomization sentinel. Today Studio routes around this by sending `seed: undefined` (which JSON-omits the field), but that's a brittle handshake — anything else in the codebase that sends `seed: -1` to this route will get a literal `-1` persisted.

**Drift 2 — Studio's video batch loop sends `undefined` instead of `-1`.** `src/components/Studio.tsx`'s `handleGenerateVideo` does:

```ts
const takeSeed = baseSeed === -1 ? undefined : baseSeed + i;
```

The image batch loop uses `-1`:

```ts
const takeSeed = baseSeed === -1 ? -1 : baseSeed + i;
```

After Drift 1 is fixed, the video loop should match.

**Drift 3 — i2v builder writes seed only to node 57.** `src/lib/wan22-workflow.ts` does `wf['57'].inputs.noise_seed = params.seed` and never touches node 58's `noise_seed`. The template's node 58 has `noise_seed: 0` baked in. Node 58 has `add_noise: "disable"` so the value *should* be unused, but with the LCM sampler under Lightning that assumption is not airtight, and `0` literally appearing in the workflow JSON is the most suspicious thing in the chain. Write the seed to both nodes; cost is one line, eliminates the literal zero entirely.

---

## Required changes

### 1. `src/app/api/generate-video/route.ts` — canonical seed contract

Replace the seed-resolution block:

```ts
// BEFORE
const seed = typeof body.seed === 'number' && Number.isInteger(body.seed)
  ? body.seed
  : Math.floor(Math.random() * 2 ** 32);

// AFTER
// Match the image-side contract: seed === -1 means random, anything else is literal.
// Treat missing/non-integer body.seed the same as -1 for backward compatibility with
// callers that omit the field. Fall back to random in any case where the value
// can't be used as a literal seed.
const explicitSeed =
  typeof body.seed === 'number' && Number.isInteger(body.seed) && body.seed !== -1
    ? body.seed
    : null;
const seed = explicitSeed ?? Math.floor(Math.random() * 2 ** 32);

console.debug('[generate-video] resolved seed', { received: body.seed, resolved: seed });
```

The debug log lands once per request and surfaces the resolved value if the bug recurs. Don't gate it behind a flag — keep it on for now; it can be removed in a later cleanup batch once we trust the path.

The validation block above this point doesn't currently call out seed validation. Don't add strict seed validation — the resolution above already handles every case safely (0 → literal, -1 → random, undefined → random, NaN → random, missing → random).

### 2. `src/components/Studio.tsx` — video batch loop sends `-1` not `undefined`

In `handleGenerateVideo`, the per-take seed line:

```ts
// BEFORE
const takeSeed = baseSeed === -1 ? undefined : baseSeed + i;

// AFTER
// Match the image batch loop's idiom — route handles -1 → random per take.
const takeSeed = baseSeed === -1 ? -1 : baseSeed + i;
```

The body literal further down the loop currently has `seed: takeSeed`. With `takeSeed` now always a number, this works without any other change. JSON-stringifying `-1` sends the literal -1 to the route, which after change 1 resolves it to a fresh random per request.

Update the loop comment above the line accordingly:

```ts
// seed === -1: route randomizes independently per take; explicit: sequential seed+i
```

stays correct as-is — keep it.

### 3. `src/lib/wan22-workflow.ts` — write seed to both KSamplerAdvanced nodes

In `buildI2VWorkflow`, find:

```ts
// Seed
wf['57'].inputs.noise_seed = params.seed;
```

Replace with:

```ts
// Seed — write to both MoE samplers. Node 58 has add_noise: "disable" and the
// template default is 0; writing the resolved seed here removes the literal-zero
// from the workflow JSON entirely. Defense-in-depth against ComfyUI sampler
// behavior we can't fully verify (LCM under Lightning).
wf['57'].inputs.noise_seed = params.seed;
wf['58'].inputs.noise_seed = params.seed;
```

Apply the same change in `buildT2VWorkflow`. The t2v template also has node 58 with `noise_seed: 0` baked in — same pattern, same fix.

Don't change anything else in the builders. The applySteps/applyCfg/applyLightning helpers are correct as-is.

### 4. `/api/generate-video` route — emit resolved seed in the init SSE event

Currently:

```ts
controller.enqueue(
  sseEncoder.encode(`event: init\ndata: ${JSON.stringify({ promptId, generationId })}\n\n`),
);
```

Extend to include the resolved seed:

```ts
controller.enqueue(
  sseEncoder.encode(`event: init\ndata: ${JSON.stringify({ promptId, generationId, resolvedSeed: seed })}\n\n`),
);
```

This is parity with the image route's `/api/generate` response, which already returns `resolvedSeed`. Studio's existing init handler can ignore this new field for now (no client-side change required); a future batch can wire it into the inline result card if useful.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "params.seed === -1" src/app/api/generate-video/route.ts` shows the new contract OR equivalent (note: the prompt's pattern uses `body.seed !== -1`; either expression of the canonical sentinel is acceptable as long as -1 → random).
- `grep -n "noise_seed = params.seed" src/lib/wan22-workflow.ts` returns **two matches in each builder** — one for node 57, one for node 58. Total: 4 matches across the file.
- `grep -n "takeSeed = baseSeed === -1 ? undefined" src/components/Studio.tsx` returns **no matches**.
- `grep -n "takeSeed = baseSeed === -1 ? -1" src/components/Studio.tsx` returns one match (the video batch loop now matches the image batch loop's idiom).
- `grep -n "resolvedSeed: seed" src/app/api/generate-video/route.ts` returns one match (the init event payload).
- `grep -n "console.debug.*generate-video.*resolved seed" src/app/api/generate-video/route.ts` returns one match.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — Charlie):

1. **i2v batch reproduction.** Open a project with a starting frame. Set batch=4. Generate. After all 4 complete, open each in the gallery modal and confirm: (a) all 4 seeds are non-zero, (b) all 4 seeds are distinct, (c) the videos are visibly different (not just slightly varied).
2. **t2v batch.** Switch to t2v mode. Set batch=4 with the same prompt. Generate. Same expectations: non-zero, distinct, visibly different.
3. **Lightning + i2v batch.** Toggle Lightning on. Set batch=4. Generate. Same expectations.
4. **Explicit seed reproducibility.** Set seed=12345, batch=4. Generate. Confirm seeds in the gallery are 12345, 12346, 12347, 12348 — sequential, deterministic.
5. **Single take regression.** Set batch=1. Generate. Confirm one job, non-zero seed, video produced normally.
6. **Server-side log inspection.** Tail PM2 logs while running smoke test 1. Confirm 4 lines of `[generate-video] resolved seed { received: undefined, resolved: <large-non-zero> }` — one per take, all different.
7. **No regression on image side.** Generate a batch=4 image. Confirm seeds remain different per take and image generation works normally (this fix doesn't touch image-side code, but verify the build didn't break anything).

If smoke test 1 still shows seed: 0 across all takes after this fix lands, the bug is somewhere I haven't found and the next debug step is to inspect Studio's form-state seed value at submit time (likely needs a `console.debug` on `baseSeed` and `takeSeed` per iteration). File a follow-up batch with that diagnostic if needed.

---

## Out of scope

- Don't change the image route or `src/lib/workflow.ts`. The image side is correct.
- Don't change `comfyws.ts`. The seed flows through `videoParams` unchanged on this batch.
- Don't change the Wan 2.2 templates (`src/lib/wan22-templates/wan22-t2v.json`, `wan22-i2v.json`). Templates are runtime data; the builder mutating them per-request is correct.
- Don't refactor `applySteps`/`applyCfg`/`applyLightning`. They're correct.
- Don't add seed validation to the route's request validation block. The resolution logic above handles every case.
- Don't wire the new `resolvedSeed` field on the init SSE event into Studio's UI. That's a follow-up; this batch only emits it.

---

## Documentation

In CLAUDE.md, find the **Seed resolution** section under image generation. Add a parallel paragraph below it for video:

> **Video seed resolution** mirrors the image-side contract: `params.seed === -1` means random, resolved inside `/api/generate-video` via `Math.floor(Math.random() * 2**32)` and embedded in both `KSamplerAdvanced` nodes (57 and 58) of the Wan 2.2 workflow. Writing to both samplers is defensive — node 58 has `add_noise: "disable"` so the seed is conceptually unused, but the template's literal `0` stays out of the workflow JSON entirely as a result. The resolved seed is emitted in the SSE `init` event as `resolvedSeed` (parity with `/api/generate`'s response field) and persisted to the DB row's `seed` column at finalize time.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
