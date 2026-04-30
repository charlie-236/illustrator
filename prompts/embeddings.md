# Batch — Textual Inversion (embedding) ingestion + Models tab support

Adds full support for textual inversions / embeddings as a third model type alongside checkpoints and LoRAs. User experience: ingest from CivitAI via the same Add Models tab (Air format works the same way), browse them in a new Embeddings sub-tab, manually type `embedding:name` in the prompt to use them.

No automatic prompt insertion, no Studio-side picker. Embeddings live in the Models tab as a reference list. The user types `embedding:filename` (without extension) in the prompt; ComfyUI parses it and applies the embedding at generation time.

This means the workflow builder is unchanged — embeddings work entirely through prompt text.

Re-read CLAUDE.md before starting. WS hijack and disk-avoidance constraints unaffected.

---

## Schema migration

### `prisma/schema.prisma`

Add a new model:

```prisma
model EmbeddingConfig {
  id              String   @id @default(cuid())
  embeddingName   String   @unique  // filename including extension, e.g. "FastNegativeV2.pt"
  friendlyName    String
  triggerWords    String   @default("")
  baseModel       String   @default("")
  category        String?  // optional tag like "negative", "style", "character" — populated from CivitAI tags at ingest
  description     String?
  url             String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

Run `npx prisma migrate dev --name add-embedding-config` to generate the migration.

The `category` field is nullable because not every CivitAI embedding has a clear category, and we want users to leave it empty rather than guess. It's stored for filtering future-features may add; not exposed in UI for filtering yet, only as a free-text editable field.

---

## Backend changes

### `src/lib/civitaiIngest.ts`

Extend `IngestRequest['type']` to `'checkpoint' | 'lora' | 'embedding'`.

Where the remote path is computed:

```ts
const remotePath =
  req.type === 'lora' ? `/models/ComfyUI/models/loras/${filename}`
  : req.type === 'checkpoint' ? `/models/ComfyUI/models/checkpoints/${filename}`
  : `/models/ComfyUI/models/embeddings/${filename}`;
```

Note: embeddings on CivitAI ship in a few formats. Most are `.pt` or `.safetensors`. Use the original CivitAI extension. Look at how the current code derives the filename — it uses a random hex stem with `.safetensors` suffix. For embeddings, that may need to inspect the CivitAI metadata's `files[].name` and preserve the actual extension. If the file isn't `.safetensors`, the random-stem-with-safetensors-suffix logic produces a broken file. Inspect first; adapt if needed.

If unsure: default to `.safetensors` for now (most modern embeddings ship that way) and surface in the PR description that we should validate against a real `.pt` embedding.

Before download: ensure the directory exists. Use the SSH session to run:
```bash
mkdir -p /models/ComfyUI/models/embeddings
```

This is idempotent and safe to run on every embedding ingest.

### `src/lib/registerModel.ts`

Extend the type union: `type: 'checkpoint' | 'lora' | 'embedding'`.

Add a third branch in the upsert switch — same pattern as the existing two but writing to `prisma.embeddingConfig`:

```ts
} else if (type === 'embedding') {
  const category = extractCategoryFromTags(civitaiMetadata);
  const record = await prisma.embeddingConfig.upsert({
    where: { embeddingName: filename },
    create: {
      embeddingName: filename,
      friendlyName,
      triggerWords,
      baseModel,
      category,
      description,
      url,
    },
    update: {
      friendlyName,
      triggerWords,
      ...(baseModel ? { baseModel } : {}),
      ...(category ? { category } : {}),
      description,
      url,
    },
  });
  return { ok: true, record: { id: record.id, friendlyName, baseModel, triggerWords } };
}
```

Add the `extractCategoryFromTags` helper:

```ts
function extractCategoryFromTags(meta: CivitAIMetadata): string | null {
  // CivitAI's tags may be on meta.tags or meta.model.tags depending on response shape.
  // Look for canonical category indicators.
  const tags: string[] = (meta as any).tags ?? (meta as any).model?.tags ?? [];
  if (!Array.isArray(tags) || tags.length === 0) return null;
  
  const lower = tags.map((t) => String(t).toLowerCase());
  
  if (lower.some((t) => t.includes('negative') || t.includes('quality'))) return 'negative';
  if (lower.some((t) => t === 'style' || t.includes('style'))) return 'style';
  if (lower.some((t) => t === 'character' || t.includes('character'))) return 'character';
  if (lower.some((t) => t === 'concept' || t.includes('concept'))) return 'concept';
  
  return null;
}
```

Heuristic-based, deliberately. Better to leave null than guess wrong — user can edit later.

### New API route: `src/app/api/embedding-config/route.ts`

Mirror `lora-config/route.ts` exactly, swapping `loraConfig` for `embeddingConfig` and the unique field `loraName` for `embeddingName`. GET (with optional `?id=`) and PUT.

Apply `filterSystemLoras`-equivalent filtering if any future system embeddings need hiding — for now there are none. Skip the filter.

### `src/app/api/models/route.ts`

The current response is `{ checkpoints, loras }`. Add an embeddings list. Source: query `EmbeddingConfig` for all rows, return their `embeddingName` as the list, sorted alphabetically.

We're NOT sourcing embeddings from ComfyUI's `/object_info` because embeddings aren't surfaced through node inputs — they're filesystem-discovered by ComfyUI at parse time. Sourcing from our DB is fine and consistent with the "ingestion is the source of truth" pattern.

```ts
const embeddings = await prisma.embeddingConfig.findMany({
  select: { embeddingName: true },
  orderBy: { embeddingName: 'asc' },
});

return Response.json({
  checkpoints,
  loras: filterSystemLoras(loras),
  embeddings: embeddings.map((e) => e.embeddingName),
});
```

### `src/app/api/models/ingest/route.ts` and `ingest-batch/route.ts`

Both routes accept `type: 'checkpoint' | 'lora'` in the body. Extend to allow `'embedding'`. The validation should be the same shape as the existing types. The downstream `ingestModel()` call already uses the type to route the path — that's covered above.

### `src/lib/civitaiUrl.ts`

The `parseAirString` already returns `type` as nullable string. The current narrowing is to `'checkpoint' | 'lora' | null`. Extend to `'checkpoint' | 'lora' | 'embedding' | null`:

```ts
const normalizedType =
  type === 'checkpoint' || type === 'lora' || type === 'embedding'
    ? type
    : null;
```

The TypeScript return type for `ParsedCivitaiInput.type` updates to match.

---

## Frontend changes

### `src/types/index.ts`

Add `embeddings: string[]` to the `ModelInfo` type returned from `/api/models`.

Add `EmbeddingConfig` type matching the Prisma model — same shape as the LoraConfig type but with the embedding-specific fields.

### `src/components/IngestPanel.tsx`

The TypeRadio currently has two buttons: Checkpoint, LoRA. Add a third: Embedding.

```tsx
{(['checkpoint', 'lora', 'embedding'] as const).map((t) => (
  // ...existing button rendering with the new option
))}
```

Display label: "Embedding". Layout: tablet-friendly, `min-h-12`.

When Air parsing returns `type === 'embedding'`, the auto-pre-fill logic should select the Embedding radio. The existing auto-prefill code path handles this if the type union is correctly extended.

### `src/components/ModelConfig.tsx`

Currently has sub-tabs: `'checkpoints' | 'loras' | 'add'`. Extend to `'checkpoints' | 'loras' | 'embeddings' | 'add'`.

Add the Embeddings sub-tab between LoRAs and Add Models. Mirror the LoRAs sub-tab structure: list of rows, tap to expand into edit form, save persists via PUT to `/api/embedding-config`.

The Embeddings row display in the list should show:
- Friendly name (or filename if friendly is empty)
- A copy-to-clipboard button next to the usage syntax `embedding:<filename-without-extension>`
- Category badge if present (small pill: "negative" / "style" / "character" / "concept")
- Trigger words (small grey text below)

The expanded edit form has:
- Friendly Name (text input)
- Category (text input — free text, not a dropdown, since the category space is open-ended)
- Base Model (text input)
- Trigger Words (text input)
- Description (textarea, larger)
- URL (read-only display, link to CivitAI if present)

Save persists via PUT to `/api/embedding-config`, same pattern as LoraConfig editing. The `onSaved` callback (triggers `modelConfigVersion` increment) should fire so the picker would refresh — even though we have no picker, this preserves consistency.

The copy-to-clipboard helper (use `navigator.clipboard.writeText`) should give visual feedback (icon flashes green or button text temporarily says "Copied!"). Tablet-friendly with `min-h-12 min-w-12`.

Filename-without-extension extraction:
```tsx
function stripExtension(name: string): string {
  return name.replace(/\.(safetensors|pt|bin|ckpt)$/i, '');
}
```

So `embedding:FastNegativeV2` for a file named `FastNegativeV2.safetensors`. ComfyUI parses prompts looking for embedding names without extensions (some setups also accept extensions, but bare-name is the universal form).

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- Prisma migration is created and `npx prisma migrate dev` runs cleanly.
- `IngestPanel.tsx` shows three type buttons: Checkpoint / LoRA / Embedding.
- An Air string with type `embedding` auto-selects the Embedding radio.
- Ingesting an embedding via the Add Models tab:
  - Downloads the file to `/models/ComfyUI/models/embeddings/` on the VM
  - Creates a row in `EmbeddingConfig`
  - Populates `category` from CivitAI tags when applicable, leaves null otherwise
- Models tab → Embeddings sub-tab lists ingested embeddings with their usage syntax (`embedding:<name>`).
- Tap-to-copy button next to the usage syntax copies the text to clipboard with visual feedback.
- The expanded row shows editable fields including Category as free text.
- Save persists via PUT to `/api/embedding-config`.
- `/api/models` includes `embeddings: string[]` in the response.
- The category badge renders when present.
- ComfyUI restart not required after ingestion (the file just being on disk is enough — embeddings are looked up at prompt-parse time).

Manual smoke test:
1. Ingest a real CivitAI embedding via Add Models. Use a known one like FastNegativeV2 (https://civitai.com/models/71961 or similar — pick whatever's still up).
2. After ingest completes, switch to the Embeddings sub-tab. The row appears.
3. Verify the file landed at `/models/ComfyUI/models/embeddings/<filename>` on the VM (SSH to confirm).
4. Tap the copy button. Confirm clipboard contains `embedding:<name>`.
5. Paste that text into Studio's negative prompt. Generate an image. The embedding takes effect (verify via comparing two generations, one with and one without).
6. Edit the row's category, save, reload — value persists.

---

## Out of scope

- No Studio-side picker. The user types `embedding:name` manually.
- No automatic prompt insertion or modification.
- No filtering UI in the Embeddings sub-tab. The category field is stored but not used for filtering yet.
- No support for the alternate `<embedding:name>` syntax some setups use — `embedding:name` is the canonical form ComfyUI accepts.
- No backfill of existing models. There are no existing embeddings in the system.
- Don't modify systemLoraFilter to also filter embeddings. No system embeddings exist yet; this is YAGNI until they do.
- Don't modify the workflow builder. Embeddings work via prompt text alone.

---

## Documentation

In CLAUDE.md:
- Update the Source Layout for `civitaiIngest.ts` to mention embeddings as a third type
- Update the Source Layout for `registerModel.ts` similarly
- Add a row to the source layout for the new `EmbeddingConfig.tsx` component (if you split it out from ModelConfig.tsx; if you inline it in the Embeddings sub-tab, just note that in ModelConfig.tsx's description)
- Add a brief paragraph in the Model Ingestion Workflow section noting that embeddings are supported as a third type, with the manual `embedding:name` syntax in prompts

When done, push and create the PR via `gh pr create`.
