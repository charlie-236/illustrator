# Batch — Video remix carries Lightning state and LoRA stack

Image remix copies the full source clip's parameters (model, LoRAs from `lorasJson`, prompts, dimensions, sampler, scheduler, etc.) — remix on an image faithfully reproduces the source. Video remix copies six fields only (positivePrompt, width, height, frames, steps, cfg). It silently drops Lightning state and the video LoRA stack — remix on a Lightning + LoRA video produces a non-Lightning, no-LoRA generation.

Two root causes:

1. The `Generation` schema has no fields for video LoRAs or Lightning. The data isn't even persisted, so remix can't reconstruct it.
2. `VideoRemixData` is too narrow even given what IS in the DB.

Fix both. Schema migration + finalize update + remix path widening.

Re-read CLAUDE.md before starting.

---

## Required changes

### Schema — `prisma/schema.prisma`

Add two fields to `Generation`:

```prisma
model Generation {
  // ... existing fields ...
  videoLorasJson Json?    // WanLoraSpec[] for video; null for image and legacy video rows
  lightning      Boolean? // true for Wan 2.2 Lightning; null for image and legacy
}
```

Both nullable. Apply via `npx prisma db push` per the existing pattern (CLAUDE.md: "Single model. `npx prisma db push` to apply schema changes — no migration files"). Existing rows backfill with null.

Image rows always have both as null. New video rows post-batch populate both. Legacy video rows have null and degrade gracefully on remix (Lightning OFF, empty stack — same as today's behavior).

### `src/lib/comfyws.ts` — `finalizeVideoJob` writes both fields

Find the `prisma.generation.create({ ... })` call in `finalizeVideoJob`. Add the new fields to the `data` object:

```ts
const created = await prisma.generation.create({
  data: {
    // ... existing fields ...
    videoLorasJson: videoParams.loras && videoParams.loras.length > 0
      ? videoParams.loras  // WanLoraSpec[] — Prisma serializes JSON automatically
      : null,
    lightning: videoParams.lightning ?? false,
  },
});
```

Store the full `WanLoraSpec` (including `loraName`, `friendlyName`, `weight`, `appliesToHigh`, `appliesToLow`) so remix can reconstruct picker state without re-reading `LoraConfig`.

### `src/app/api/generate-video/route.ts` — verify pass-through

Verify the route already passes `loras` and `lightning` from the request body into `videoParams` for `registerVideoJob`. If it does (likely — it's the existing happy path for both fields), no changes here. If anything is being dropped at the route boundary, fix.

### `src/types/index.ts` — extend `GenerationRecord` and widen `VideoRemixData`

`GenerationRecord` (returned by `/api/gallery`, used by Studio remix) gains the two new fields. Mirror the existing `lorasJson: LoraEntry[] | null` pattern:

```ts
export interface GenerationRecord {
  // ... existing fields ...
  videoLorasJson: WanLoraSpec[] | null;
  lightning: boolean | null;
}
```

The `WanLoraSpec` type is already imported from somewhere (used by `VideoLoraStack` and project defaults) — reuse it.

`VideoRemixData` widens to include the missing fields:

```ts
export interface VideoRemixData {
  positivePrompt: string;
  width: number;
  height: number;
  frames: number;
  steps: number;
  cfg: number;
  seed: number;                          // NEW — -1 for random, matching image-mode remix
  videoLoras: WanLoraSpec[] | null;      // NEW
  lightning: boolean | null;             // NEW
}
```

### `src/app/page.tsx` — `handleRemix` populates new fields

In the video branch of `handleRemix`:

```ts
if (record.mediaType === 'video') {
  setVideoRemixParams({
    positivePrompt: record.promptPos,
    width: record.width,
    height: record.height,
    frames: record.frames ?? 57,
    steps: record.steps,
    cfg: record.cfg,
    seed: -1,                                       // match image-mode remix's seed: -1
    videoLoras: record.videoLorasJson ?? null,
    lightning: record.lightning ?? false,
  });
  setRemixParams(null);
}
```

Image branch stays unchanged.

### `src/components/Studio.tsx` — apply video remix populates Lightning + LoRA stack

In the `useEffect` that consumes `videoRemixParams`, after the existing form prefills, add the Lightning and LoRA application:

```ts
// Existing prefills (videoP, batchSize, prompt, starting frame reset, projectContext clear)

// NEW: Lightning state
setLightningAndPersist(videoRemixParams.lightning ?? false);

// NEW: LoRA stack
const loraEntries = videoRemixParams.videoLoras
  ? videoRemixParams.videoLoras.map((s) => ({ loraName: s.loraName, weight: s.weight }))
  : [];
setVideoLorasAndPersist(loraEntries);
```

Verify the entry shape matches what `setVideoLorasAndPersist` expects. Looking at the form persistence pattern, the local form state likely tracks `{ loraName, weight }` per row, with `appliesToHigh`/`appliesToLow` being derived per-LoRA at submit time from the `LoraConfig` table. If the form state shape differs, adapt the mapping accordingly.

If a `WanLoraSpec` references a `loraName` that no longer exists in `LoraConfig` (the user deleted that LoRA after generating the source clip), the picker silently drops the row at apply time. Acceptable. If quick to surface a small "1 LoRA from the source clip is no longer available" hint, do it; otherwise document as a known minor edge case in the PR description.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "videoLorasJson\|lightning " prisma/schema.prisma` shows both fields on the `Generation` model.
- `npx prisma db push` applies the new fields cleanly. Existing rows have null for both.
- `grep -n "videoLorasJson" src/lib/comfyws.ts` shows `finalizeVideoJob` writing the field.
- `grep -n "lightning:" src/lib/comfyws.ts` shows `finalizeVideoJob` writing the field.
- `VideoRemixData` includes `seed`, `videoLoras`, and `lightning`.
- `handleRemix` in `src/app/page.tsx` populates all three on video remix.
- Studio's apply-video-remix effect calls `setLightningAndPersist` and `setVideoLorasAndPersist`.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. Generate a video with Lightning ON and a LoRA stack of 2 LoRAs at non-default weights (e.g. 0.7, 1.2).
2. Wait for completion. Open the gallery, find the new clip.
3. Open the modal, tap Remix. Confirm Studio opens in video mode with: same prompt, same dimensions, Lightning ON, the same 2 LoRAs at the same weights.
4. Tap Generate. Confirm the new generation succeeds and produces a similar-looking output.
5. Generate a non-Lightning, no-LoRA video. Remix it. Confirm Lightning is OFF and the LoRA stack is empty.
6. Open a legacy video clip (one generated before this batch — has null for both new fields). Remix. Confirm Lightning is OFF, LoRA stack empty (graceful degradation).
7. Inspect the DB (`psql` or Prisma Studio): confirm `videoLorasJson` and `lightning` are populated for fresh video rows; null for image rows; null for legacy video rows.
8. Generate a new image clip (regression check). Confirm `videoLorasJson` and `lightning` are null on the row.

---

## Out of scope

- Backfilling `lightning` for legacy video rows from the `model` string suffix (`-lightning`). Possible future SQL one-shot; not part of this batch.
- Reconstructing the starting frame for i2v remix. The user re-picks; same as today.
- Per-LoRA `appliesToHigh`/`appliesToLow` editing in the remix-populated stack. Values come from `LoraConfig` at submit time.
- Image remix changes. Image-mode remix is unchanged.
- Storing or surfacing `negativePrompt` for video remix. Negative prompt is hidden in the video UI (Phase 1.2a decision); the row stores it but remix doesn't surface it.
- A "remix this with the same starting frame" affordance.
- Schema-level validation that `videoLorasJson` is a valid `WanLoraSpec[]`. Prisma's `Json` is type-permissive; we trust the writer (`finalizeVideoJob`).
- Showing a stale-LoRA warning in the gallery for clips whose referenced LoRAs were deleted. Out of scope.

---

## Documentation

In CLAUDE.md, find the `Generation` schema documentation. Add the two new fields:

```prisma
videoLorasJson Json?    // WanLoraSpec[] for video; null for image and legacy
lightning      Boolean? // true for Wan 2.2 Lightning; null for image and legacy
```

Find the "Wan LoRA support" subsection. Add a paragraph:

> Video clips persist their LoRA stack and Lightning state on the `Generation` row (`videoLorasJson` and `lightning` columns). Remix-from-gallery reconstructs both into Studio's video form, matching image-mode's full-parameter remix. Legacy rows (pre-batch) have null for both and degrade gracefully on remix — Lightning OFF, empty LoRA stack — preserving today's behavior.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
