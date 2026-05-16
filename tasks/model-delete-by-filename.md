# Batch — Delete-by-filename for checkpoints and LoRAs (replaces `/api/models/[id]`)

When the VM has a checkpoint or LoRA file with no matching DB row (a partial ingest, a manually-copied file, etc.), the file appears in the picker but the delete button is hidden. Two reasons: `DeleteRow` gates on a non-null `configId`, and `DELETE /api/models/[id]` is keyed on the Prisma cuid that doesn't exist for orphans. The user has to SSH in and `rm` the file manually.

Fix: retire the id-keyed route and replace it with one keyed on `type` + `filename`. The frontend always knows the filename (it's what's in the picker), so making filename the source of truth removes the orphan blind spot and gives us a single delete path.

Re-read CLAUDE.md before starting — disk-avoidance is unaffected; this only touches mint-pc-side delete logic plus an SSH `rm -f` on the VM (existing pattern from the route being retired).

---

## Required changes

### NEW: `src/app/api/models/[type]/[filename]/route.ts`

DELETE handler. Replaces `/api/models/[id]/route.ts`.

Validation:
- `type` must be one of `'checkpoint'`, `'lora'`, `'embedding'`. Anything else → 400 with a clear error. (Embedding is included now even though no UI consumer exists yet — the follow-up batch will use it.)
- `filename` must not contain `..` or `/`. Anything else → 400. Same check pattern as `src/app/api/generation/[id]/route.ts`.
- Read `A100_VM_USER`, `A100_VM_IP`, `A100_SSH_KEY_PATH` from env with `?? ''` fallback. If any is empty, return 500 with the specific missing-var message — match the existing `/api/models/[id]/route.ts` hardening exactly.

Path resolution:

```ts
const remotePath =
  type === 'checkpoint' ? `/models/ComfyUI/models/checkpoints/${filename}` :
  type === 'lora'       ? `/models/ComfyUI/models/loras/${filename}` :
                          `/models/ComfyUI/models/embeddings/${filename}`;
```

Delete sequence:

1. SSH and `rm -f "${remotePath}"`. `rm -f` returns 0 even if the file is already gone — idempotent both ways (orphan-file case AND orphan-row case where the file was already nuked manually).
2. After SSH success, delete the matching DB row if any. Use `deleteMany` (idempotent — returns `{ count: 0 }` when nothing matches, no exception):

   ```ts
   if (type === 'checkpoint') {
     await prisma.checkpointConfig.deleteMany({ where: { checkpointName: filename } });
   } else if (type === 'lora') {
     await prisma.loraConfig.deleteMany({ where: { loraName: filename } });
   } else {
     await prisma.embeddingConfig.deleteMany({ where: { embeddingName: filename } });
   }
   ```

3. Return `{ ok: true }`.

If SSH fails: return 500 with the SSH error string. Do NOT proceed to the DB delete — leaving a row pointing at a still-extant VM file is recoverable; the alternative (file present, no metadata) is what we're trying to fix in the first place.

If `deleteMany` throws (it shouldn't, but defensively): log via `console.error` and return 500. The file is already gone from the VM at this point, so any retry will be a no-op SSH + a successful deleteMany.

Next.js 14 route signature (params is a Promise — match the pattern in `src/app/api/generation/[id]/route.ts` and the route being retired):

```ts
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ type: string; filename: string }> },
) {
  const { type, filename } = await params;
  // ...
}
```

### DELETE: `src/app/api/models/[id]/`

Remove the entire directory:

```bash
git rm -r 'src/app/api/models/[id]'
```

Before doing this, `grep -rn "/api/models/" src/` and confirm the only remaining call sites point to the new shape (`/api/models/${type}/${...}`) or to the existing sibling routes (`register`, `ingest`, `ingest-batch`). If any code still references `/api/models/${configId}`, fix it before deleting the directory.

### `src/components/ModelConfig.tsx`

Three changes:

**(a) `deleteCurrentModel(type)` — switch from id-based to filename-based.**

Current shape:
```ts
const configId = type === 'checkpoint' ? ckptConfigId : loraConfigId;
if (!configId) return;
// ...
const res = await fetch(`/api/models/${configId}`, { method: 'DELETE' });
```

Replace with:
```ts
const filename = type === 'checkpoint' ? selectedCheckpoint : selectedLora;
if (!filename) return;
// ...friendlyName resolution (ckptNames[filename] || filename) is unchanged...
const res = await fetch(
  `/api/models/${type}/${encodeURIComponent(filename)}`,
  { method: 'DELETE' },
);
```

`encodeURIComponent` is required because filenames can contain characters that need URL escaping. Next.js auto-decodes the path param server-side.

After successful delete, the existing reset logic (clearing `selectedCheckpoint` / `selectedLora`, `ckptConfigId` / `loraConfigId`, the form blanks, calling `refreshLists()` and `onSaved?.()`) is unchanged. The reset of `ckptConfigId` / `loraConfigId` to null can stay even though the field is no longer load-bearing for delete — the form-load effect still uses it.

**(b) `DeleteRow` — drop the `configId` prop and stop gating on it.**

Find the `DeleteRow` component definition. Its `configId` prop is currently used to (i) show/hide the row and (ii) feed the click handler. Drop it. The component's `onDelete` prop still drives the click. The visibility gate becomes "is a model selected" — handled by the parent (the row should only render when `selectedCheckpoint` / `selectedLora` is non-empty). If `DeleteRow` was rendering itself null when `configId` was null, that branch goes away.

The `disabled` state during deletion (`deletingModel`) and the error display (`deleteError`) are unchanged.

**(c) Both DeleteRow call sites (Checkpoints sub-tab + LoRAs sub-tab) — update props.**

Remove the `configId={ckptConfigId}` / `configId={loraConfigId}` prop. Wrap the `DeleteRow` in `selectedCheckpoint && (...)` / `selectedLora && (...)` if it isn't already gated by an outer conditional that does the same — most likely it's already inside a `{selectedCheckpoint && <>...</>}` block. Verify and adapt.

**This batch does NOT add `DeleteRow` to the Embeddings sub-tab.** That's the follow-up batch.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `find 'src/app/api/models/[id]'` returns nothing — the directory is gone.
- `src/app/api/models/[type]/[filename]/route.ts` exists and exports a DELETE handler.
- The new route validates `type` against `['checkpoint', 'lora', 'embedding']` (returns 400 otherwise) and rejects filenames containing `..` or `/` (returns 400).
- The new route uses `?? ''` env fallbacks plus runtime checks for all three SSH env vars — same shape as the route being replaced.
- `grep -rn '/api/models/\${configId}' src/` returns nothing.
- `grep -n '/api/models/\${type}/' src/components/ModelConfig.tsx` returns the new fetch URL.
- `DeleteRow`'s prop signature no longer includes `configId`.
- The delete button is rendered in the Checkpoints and LoRAs sub-tabs whenever a model is selected, regardless of whether a DB config row exists.

Manual smoke test (deferred to user):
1. Pick a LoRA that has a DB config row. Delete it. File is gone from VM (`ssh a100-core ls /models/ComfyUI/models/loras/<filename>` → no such file), DB row is gone, picker no longer lists it after the auto-refresh.
2. Pick a LoRA that has no DB config row (an orphan). The delete button is now visible (it wasn't before this batch). Tap it; confirm. File is gone from VM, picker no longer lists it.
3. Pick a checkpoint, manually `rm` its file on the VM via SSH first, then tap delete in the UI. SSH `rm -f` returns 0, the DB row is removed, no error surfaces.
4. The Embeddings sub-tab is unchanged — no delete button. Friendly name still loads from the EmbeddingConfig table. (The orphan-visibility fix lands in the next batch.)

---

## Out of scope

- Don't add a delete button to the Embeddings sub-tab. That's the follow-up batch.
- Don't change `/api/models`'s embedding source. Still DB-sourced this batch.
- Don't change SSH connection logic, env handling, or path resolution outside the new route file.
- Don't add a "force delete even if SSH fails" override — SSH failure is a real error and should bubble up.
- Don't touch `/api/generation/[id]` — different concern, already correct.
- Don't extend `DeleteRow` with new variants (e.g. "compact" / "with extra confirm"). Same component, same look.
- Don't backfill any data.

---

## Documentation

In CLAUDE.md, under the API routes section, find the entry for `/api/models/[id]` (if one exists — search for `models/[id]` and for "DELETE" near the models block). Replace it with:

```
### `DELETE /api/models/[type]/[filename]`
Removes a checkpoint, LoRA, or embedding by filename. `type` is `'checkpoint' | 'lora' | 'embedding'`; filename is the on-disk filename including extension. SSH-deletes the file from the A100 VM via `rm -f` (idempotent) and removes any matching DB row via Prisma `deleteMany` (also idempotent). Used by ModelConfig's delete buttons. Works whether or not a DB row exists for the filename, so orphan files are deletable from the UI.
```

If no `/api/models/[id]` entry exists in CLAUDE.md today, just insert the new entry next to the other `/api/models/*` entries (alphabetical by path, or grouped with the related routes — match local convention).

When done, push and create the PR via `gh pr create` per AGENTS.md.
