# Batch — Source embeddings list from the VM (orphan visibility + delete)

`/api/models` returns the embeddings list from the `EmbeddingConfig` DB table. Any embedding file on the VM at `/models/ComfyUI/models/embeddings/` without a DB row is invisible to the UI — can't be seen, can't be deleted, can't be given metadata. The user has to SSH in to clean it up.

This is the embeddings-side counterpart to the orphan-file fix in `model-delete-by-filename.md`. Where checkpoints and LoRAs were *visible-but-undeletable*, embeddings are *invisible*, because the source-of-truth picked for embeddings was the DB while checkpoints/LoRAs are sourced from ComfyUI.

Fix: switch embeddings to be VM-sourced like the other two model types, then add a delete button to the Embeddings sub-tab using the unified delete endpoint shipped in `model-delete-by-filename`.

**Sequencing: this batch must merge after `model-delete-by-filename`** — it depends on `DELETE /api/models/[type]/[filename]` accepting `type === 'embedding'`, which the prior batch ships.

Re-read CLAUDE.md before starting — disk-avoidance is unaffected.

---

## Required changes

### `src/app/api/models/route.ts` — replace embeddings source

Currently the embeddings list comes from Prisma:

```ts
const embeddings = await prisma.embeddingConfig.findMany({
  select: { embeddingName: true },
  orderBy: { embeddingName: 'asc' },
});
return Response.json({ /* ... */, embeddings: embeddings.map((e) => e.embeddingName) });
```

Replace with a VM-sourced list. Two implementation options — investigate (a) first, fall back to (b):

**Option (a) — preferred: ComfyUI's `/embeddings` HTTP endpoint.**

ComfyUI exposes `GET http://127.0.0.1:8188/embeddings` returning a JSON array of embedding names. Verify against the live VM by `curl http://127.0.0.1:8188/embeddings` from `mint-pc`. Note in the PR description:
- whether the response is a JSON array of strings
- whether names include the file extension or not

If names are extension-less, append the on-disk extension. The cheapest way: combine `/embeddings` (names) with a single SSH `ls /models/ComfyUI/models/embeddings/` (filenames) and join. If `/embeddings` returns extensions already, no SSH needed.

Apply a 5-second timeout via `AbortSignal.timeout(5000)` to match the existing checkpoint/lora fetches in this route.

**Option (b) — fallback: SSH `ls`.**

If `/embeddings` is missing, returns an unexpected shape, or its extension behavior can't be determined cleanly:

```ts
const ssh = new NodeSSH();
await ssh.connect({ host: VM_IP, username: VM_USER, privateKeyPath: SSH_KEY_PATH });
const result = await ssh.execCommand('ls -1 /models/ComfyUI/models/embeddings/ 2>/dev/null');
ssh.dispose();
const embeddings = result.stdout
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => /\.(safetensors|pt|bin|ckpt)$/i.test(s));
```

Apply the same env-fail-closed pattern (`?? ''` plus empty-check returning 500) used by `model-delete-by-filename`'s new route. Hoist the SSH env var reads to the top of the file alongside the existing imports — the route can keep relying on them as missing-env-fail-closed.

Either way:
- The response shape stays `{ checkpoints, loras, embeddings }`.
- Sort embeddings alphabetically.
- If the VM source fails (network, SSH, ComfyUI down): return 500 — don't return an empty array (matches the lesson learned in CLAUDE.md / past prompts about "empty arrays on API failure look successful but show empty UI").

In the PR description, state plainly which option (a or b) was used and why, and any latency observation.

### `src/lib/useModelLists.ts` — surface VM-sourced embeddings + their metadata maps

The hook currently fetches `/api/models`, `/api/checkpoint-config`, and `/api/lora-config`. Add a fetch of `/api/embedding-config` and surface the parallel maps:

```ts
embeddings: string[];                         // filenames from VM (via /api/models)
embeddingNames: Record<string, string>;       // filename → friendlyName
embeddingTriggerWords: Record<string, string>; // filename → triggerWords
embeddingBaseModels: Record<string, string>;  // filename → baseModel
embeddingCategories: Record<string, string>;  // filename → category (empty string if null)
```

This mirrors the existing `loraNames`, `loraTriggerWords`, `loraBaseModels` shape. Build the maps in the same `useMemo` (or wherever the existing maps are derived).

Filenames present in `/api/models.embeddings` but not in any `EmbeddingConfig` row are orphans — they appear in the picker with empty friendly name (UI falls back to raw filename, matching the existing checkpoint / LoRA pattern).

DB rows pointing to filenames not in `/api/models.embeddings` (the "dead metadata" case) are silently dropped from the maps. They're not surfaced anywhere — the user can't reach them through the UI. Don't auto-delete them; that's a write side effect on a read endpoint and the rows aren't hurting anything.

### `src/components/ModelConfig.tsx` — Embeddings sub-tab

Two changes:

**(a) Drop the local `refreshEmbeddings` callback and consume from `useModelLists`.**

The embeddings list, names map, etc., now come from the hook. The local `refreshEmbeddings` Promise.all goes away. `refreshLists()` covers the refresh path. Anywhere that called `refreshEmbeddings()` becomes `refreshLists()`.

The `embeddings` and `embeddingNames` local state goes away; read them from the hook's `lists` instead.

**(b) Add a `DeleteRow` to the Embeddings sub-tab.**

Mirror the LoRA / checkpoint pattern. The handler is `deleteCurrentModel('embedding')`. Extend the function's type union and add the third branch:

```ts
async function deleteCurrentModel(type: 'checkpoint' | 'lora' | 'embedding') {
  const filename =
    type === 'checkpoint' ? selectedCheckpoint :
    type === 'lora' ? selectedLora :
    selectedEmbedding;
  if (!filename) return;

  const friendlyName =
    type === 'checkpoint' ? (ckptNames[filename] || filename) :
    type === 'lora' ? (loraNames[filename] || filename) :
    (embeddingNames[filename] || filename);

  // ... existing confirm dialog, fetch call (already filename-based after prior batch) ...

  // After successful delete, reset the appropriate-side state
  if (type === 'checkpoint') { /* existing reset */ }
  else if (type === 'lora') { /* existing reset */ }
  else {
    setSelectedEmbedding('');
    setEmbeddingConfigId(null);
    setEmbeddingForm({ ...EMBEDDING_BLANK });
  }
  refreshLists();
  onSaved?.();
}
```

The fetch call from the prior batch already builds `/api/models/${type}/${encodeURIComponent(filename)}`, so passing `'embedding'` as type works without any backend change — the prior batch's route already accepts `'embedding'`.

The `DeleteRow` in the Embeddings sub-tab renders whenever `selectedEmbedding` is non-empty, regardless of whether `embeddingConfigId` exists (so orphan files are deletable). Same gating logic as the checkpoint and LoRA sub-tabs after the prior batch.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `src/app/api/models/route.ts` no longer reads embeddings from `prisma.embeddingConfig` for the listing call. (`grep -n 'embeddingConfig.findMany' src/app/api/models/route.ts` returns nothing.)
- The PR description states which option (a or b) was used for the VM source and notes any latency observation.
- `useModelLists` exposes `embeddings`, `embeddingNames`, and the other parallel maps listed above.
- `ModelConfig.tsx`'s `refreshEmbeddings` callback is gone — `grep -n refreshEmbeddings src/components/ModelConfig.tsx` returns nothing.
- A `DeleteRow` is rendered in the Embeddings sub-tab and is visible whenever an embedding is selected, including when no `EmbeddingConfig` row exists.
- `deleteCurrentModel`'s type union is `'checkpoint' | 'lora' | 'embedding'`.

Manual smoke test (deferred to user):
1. Place an embedding file on the VM with no `EmbeddingConfig` row (e.g. `scp` a file directly into `/models/ComfyUI/models/embeddings/`). Reload the Models tab. The embedding now appears in the Embeddings sub-tab list with the raw filename.
2. Tap the orphan. The friendly-name field is blank. The delete button is visible. Tap delete; confirm. File is gone from the VM (`ssh a100-core ls /models/ComfyUI/models/embeddings/<filename>` → no such file).
3. Re-ingest a regular embedding via Add Models. It appears in the list with its CivitAI-derived friendlyName. Edit metadata, save, reload — value persists.
4. Existing embedding ingestion path still works end-to-end. The `embedding:<name>` syntax still resolves at generation time.
5. Delete a regular (non-orphan) embedding through the new delete button. File is gone, DB row is gone, picker no longer lists it.

---

## Out of scope

- Don't auto-clean `EmbeddingConfig` rows whose underlying file is gone. They're invisible and harmless. A one-shot SQL delete by the user is fine if it ever matters; not part of this batch.
- Don't extend the VM-source pattern to checkpoints / LoRAs — they're already VM-sourced via ComfyUI's `/object_info`.
- Don't add a Studio-side embeddings picker. The `embedding:<name>` manual-typing pattern is unchanged.
- Don't modify `/api/models/[type]/[filename]` — the prior batch shipped that route and it already accepts `'embedding'`.
- Don't change the embedding ingest path or how `EmbeddingConfig` rows are created at ingest time.
- Don't add a "stale metadata" warning or admin tool. YAGNI.

---

## Documentation

In CLAUDE.md:

- Find the "Embeddings (textual inversions)" paragraph in the Model Ingestion Workflow section. Update the line that implies `EmbeddingConfig` is the source of truth — it isn't anymore. Replace with: "the embeddings list is sourced from the VM (via ComfyUI's `/embeddings` endpoint or SSH ls — see `/api/models` route notes); `EmbeddingConfig` rows are metadata that join in by filename. Files on the VM without metadata still appear in the Embeddings sub-tab with the raw filename and can be deleted from the UI."
- Find the API entry for `GET /api/models`. Update the embeddings half of the response description to note the VM source.
- Source layout entry for `useModelLists.ts` already says "shared fetcher for /api/models + /api/checkpoint-config + /api/lora-config" — extend the list to include `/api/embedding-config`.

When done, push and create the PR via `gh pr create` per AGENTS.md.
