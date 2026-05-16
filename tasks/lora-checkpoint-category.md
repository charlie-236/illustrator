# Batch — Category field on LoRAs and Checkpoints (parity with Embeddings)

Embeddings have a `category` column on `EmbeddingConfig` populated by an `extractCategoryFromTags` heuristic at ingest time, surfaced as a free-text editable field in the Models tab. LoRAs and Checkpoints don't. The same heuristic would be useful for filtering and organizing LoRAs (and to a lesser extent Checkpoints); the helper is already generic in `registerModel.ts`.

Add `category` to both `LoraConfig` and `CheckpointConfig`, populate at ingest, surface as a free-text editable field in the Models tab editor. Mirror the embedding pattern exactly.

Re-read CLAUDE.md before starting.

---

## Required changes

### Schema — `prisma/schema.prisma`

```prisma
model LoraConfig {
  // ... existing fields ...
  category String?
}

model CheckpointConfig {
  // ... existing fields ...
  category String?
}
```

Both nullable (the heuristic returns null when nothing matches). Apply via `npx prisma db push`. Existing rows backfill with null.

### `src/lib/registerModel.ts` — call `extractCategoryFromTags` from lora and checkpoint branches

The helper already exists and is used by the embedding branch. Wire it into the lora and checkpoint upserts:

```ts
// LoRA branch
const category = extractCategoryFromTags(civitaiMetadata);
const record = await prisma.loraConfig.upsert({
  where: { loraName: filename },
  create: {
    loraName: filename,
    friendlyName,
    triggerWords,
    baseModel,
    category,                           // NEW
    description,
    url,
    appliesToHigh: true,
    appliesToLow: true,
  },
  update: {
    friendlyName,
    triggerWords,
    ...(baseModel ? { baseModel } : {}),
    ...(category ? { category } : {}),  // NEW — only update if non-null, protects user edits
    description,
    url,
  },
});

// Checkpoint branch — same pattern
const category = extractCategoryFromTags(civitaiMetadata);
const record = await prisma.checkpointConfig.upsert({
  where: { checkpointName: filename },
  create: {
    // ... existing checkpoint fields ...
    category,                           // NEW
  },
  update: {
    // ... existing checkpoint fields ...
    ...(category ? { category } : {}),  // NEW — same guard
  },
});
```

The `...(category ? { category } : {})` upsert guard mirrors the existing embedding branch pattern: re-ingesting a model whose CivitAI tags now produce a different (or null) category won't clobber a user-edited value. Match the existing precedent exactly.

### `src/app/api/lora-config/route.ts` and `src/app/api/checkpoint-config/route.ts` — accept `category` in PUT

The PUT handlers update `friendlyName`, `triggerWords`, `baseModel`, etc. Add `category` to the field list. Match the embedding-config route's PUT exactly (string field, optional, no special validation beyond "is a string").

### `src/components/ModelConfig.tsx` — add `category` to LoRA and Checkpoint editors

The Embeddings sub-tab already has a category field in its form (`embeddingForm.category`). Add the same field to:

- `loraForm` state — add `category: string`
- `LORA_BLANK` initial — `category: ''`
- `ckptForm` state — add `category: string`
- `CKPT_BLANK` initial — `category: ''`

Form input UI mirrors the Embeddings sub-tab's category input exactly — same label ("Category"), same placeholder, same `input-base` styling. `input-base` already provides tablet-friendly height (44px+); no extra styling needed.

The PUT body construction in `saveLora` / `saveCheckpoint` includes `category` (same destructuring pattern as the existing fields: `{ url: _ckptUrl, ...ckptSaveFields }`).

The form-load effect (which fires on `selectedLora` / `selectedCheckpoint` change) populates `category` from the fetched config (or `''` if null) — match the embedding `setEmbeddingForm` shape.

### `src/lib/useModelLists.ts` — surface category maps

The hook currently exposes `loraNames`, `loraTriggerWords`, `loraBaseModels`. Add:

```ts
loraCategories: Record<string, string>;        // filename → category (empty string if null)
checkpointCategories: Record<string, string>;  // filename → category (empty string if null)
```

Build the maps in the same `useMemo` (or wherever the existing maps are derived) from the `/api/lora-config` and `/api/checkpoint-config` responses. Mirror the existing `embeddingCategories` map pattern.

These aren't consumed in this batch, but exposing them now means future filtering work (LoRA picker by category, etc.) doesn't need a separate hook update.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "category" prisma/schema.prisma` shows the field on `LoraConfig` and `CheckpointConfig` (and the existing one on `EmbeddingConfig`).
- `npx prisma db push` applies cleanly. Existing rows backfill with null.
- `grep -n "extractCategoryFromTags" src/lib/registerModel.ts` shows the helper called in all three branches (lora, checkpoint, embedding).
- LoRA and Checkpoint editors in the Models tab show a category input field, identical in look and behavior to the Embeddings tab's.
- `useModelLists` exposes `loraCategories` and `checkpointCategories` maps alongside the existing `embeddingCategories`.
- Ingesting a fresh CivitAI LoRA with style/character/concept tags writes the heuristic-derived category to the row.
- Editing a category in the UI saves and persists; re-ingesting that same model from CivitAI doesn't overwrite the user-edited value.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. Apply schema change. Confirm `npx prisma studio` (or `psql`) shows `category` columns on `LoraConfig` and `CheckpointConfig`, with null for existing rows.
2. Ingest a CivitAI LoRA known to have a "style" tag. Confirm the row's category is `"style"` post-ingest.
3. Open the LoRA in the Models tab. Confirm the category field is visible and shows the auto-derived value.
4. Edit the category to a custom value (e.g. "experimental"). Save. Reload the page. Confirm persistence.
5. Same flow for a Checkpoint.
6. Re-ingest the same LoRA from CivitAI (via Add Models). Confirm the user-edited "experimental" survives — the `...(category ? { category } : {})` upsert guard protects it.
7. An existing pre-batch LoRA / Checkpoint loads with empty category. Editor shows the empty input. User can fill and save.

---

## Out of scope

- Filtering the LoRA picker by category. Future feature; this batch just stores the data.
- A category dropdown / chip selector. Free-text input only, matching embeddings.
- Backfilling category for legacy rows by re-running the heuristic. We don't store full CivitAI metadata long-term; running the heuristic again would require re-fetching from CivitAI. Out of scope; legacy rows have null until re-ingested.
- Category-based grouping in the Models tab. Sorting and grouping stay alphabetical.
- Validation of category values (allowed strings). Free text — user can type anything.
- A "suggested categories" autocomplete. YAGNI.
- Surfacing category in any non-Models-tab UI (Studio LoRA picker, gallery, etc.). Just the Models tab editor for now.
- Adding a category field to embeddings — already there.

---

## Documentation

In CLAUDE.md, find the schema documentation for `LoraConfig` and `CheckpointConfig`. Add the `category` field to both, mirroring the existing `EmbeddingConfig` documentation (heuristic-populated at ingest, free-text editable, used for filtering future-features may add).

Find the Models tab section. Update the description of LoRA and Checkpoint editors to mention the category field as a free-text editable input populated heuristically at ingest.

In the source layout entry for `registerModel.ts`, update to note `extractCategoryFromTags` is now called from all three branches.

Find the source layout entry for `useModelLists.ts`. Update to note it now exposes `loraCategories` and `checkpointCategories` alongside the existing maps.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
