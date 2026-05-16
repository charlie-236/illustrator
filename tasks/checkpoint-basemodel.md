# Batch — CheckpointConfig.baseModel UI + auto-populate at ingest

Two related changes that close an existing asymmetry. LoraConfig stores `baseModel` (used by ModelSelect to prioritize matching LoRAs) and is populated automatically at ingest. CheckpointConfig has a `baseModel` field in the schema but no UI to edit it and no auto-populate logic.

This blocks two things that already exist as features:
1. The "stylized checkpoint" warning in ReferencePanel (which checks `baseModel` for "Pony" / "Illustrious" / "Animagine") only fires when the field is populated. Currently the user has to manually populate it via direct DB edit.
2. The same baseModel-matching that prioritizes LoRAs in ModelSelect could prioritize-or-flag checkpoint+LoRA mismatches if checkpoint baseModel were known.

Re-read CLAUDE.md before starting, particularly the Disk-Avoidance Constraint (unaffected) and the existing LoRA detail UI in ModelConfig.tsx (the pattern to mirror).

---

## Task 1 — Auto-populate baseModel at checkpoint ingestion

`registerModel.ts` already extracts `civitaiMetadata.baseModel` for both checkpoint and lora paths, but only writes it to LoraConfig. The CheckpointConfig branch ignores it.

Look in `src/lib/registerModel.ts` for the `if (type === 'checkpoint')` block. Add `baseModel` to both the `create` and `update` payloads, mirroring the lora branch:

```ts
const record = await prisma.checkpointConfig.upsert({
  where: { checkpointName: filename },
  create: {
    checkpointName: filename,
    friendlyName,
    baseModel,
    // ...existing fields...
  },
  update: {
    friendlyName,
    baseModel,
    description,
    url,
  },
});
```

The update path explicitly does not overwrite an existing `baseModel` with empty string — if civitaiMetadata.baseModel is empty, leave the existing value alone. Use a conditional spread:

```ts
update: {
  friendlyName,
  ...(baseModel ? { baseModel } : {}),
  description,
  url,
},
```

This matches the LoraConfig pattern and is the right defensive default — re-ingesting a model with empty CivitAI baseModel shouldn't blow away a manually-corrected value.

For new checkpoints, the create path always sets baseModel (defaulting to empty string if civitaiMetadata is missing — same as lora).

## Task 2 — Editable baseModel field in the Checkpoints sub-tab

In `src/components/ModelConfig.tsx`, find the Checkpoints sub-tab's row detail/edit view. Currently it has fields for friendlyName, defaultPositivePrompt, defaultNegativePrompt, defaultWidth, defaultHeight, description.

Add a `baseModel` field below `friendlyName`:

```tsx
<div>
  <label className="label">Base Model</label>
  <input
    type="text"
    value={editing.baseModel ?? ''}
    onChange={(e) => setEditing({ ...editing, baseModel: e.target.value })}
    placeholder="Pony, SDXL 1.0, Illustrious, etc."
    className="input-base min-h-12"
  />
  <p className="text-xs text-zinc-500 mt-1">
    Used to match compatible LoRAs and to flag stylized checkpoints in the Reference panel.
  </p>
</div>
```

The save handler should already be persisting all editable fields via PUT to `/api/checkpoint-config`. Verify that route accepts `baseModel` in its update payload — if not, add it. Check `src/app/api/checkpoint-config/route.ts` for the PUT handler's body schema.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `registerModel.ts` writes `baseModel` to CheckpointConfig on create.
- `registerModel.ts` only updates `baseModel` on existing rows when CivitAI provides a non-empty value.
- The Checkpoints sub-tab in ModelConfig has a labeled "Base Model" text field below "Friendly Name."
- Editing the field and saving the row persists to the DB via the existing PUT endpoint.
- After save, the value persists across page reloads (verify the PUT handler accepts and stores baseModel).
- The "stylized checkpoint" warning in ReferencePanel still fires correctly (no regression — this UI change just adds a way to populate the value, doesn't change its semantics).

Manual smoke test:
1. Open Models tab → Checkpoints. Pick a checkpoint with empty baseModel.
2. Edit, set "Pony" (or whatever applies), save.
3. Reload the app. Reopen the same checkpoint. Value persists.
4. In Studio, select that checkpoint, add a face reference. Amber "stylized checkpoint" warning should appear.
5. Ingest a new test checkpoint via the Add Models tab. After ingestion completes, check the DB — `baseModel` should be populated from CivitAI's metadata.

---

## Out of scope

- Don't add automatic cross-checkpoint-LoRA validation (e.g., "this LoRA is for Pony but you're using base SDXL"). That's a future feature.
- Don't backfill existing rows by re-fetching from CivitAI. The user has already manually populated their three current rows.
- Don't change the LoraConfig side — it's already correct.
- Don't add a baseModel dropdown of preset values. Free text is fine; CivitAI has too many variants to enumerate.

---

## Documentation

In CLAUDE.md, the Source Layout entry for `registerModel.ts` mentions DB upsert logic — no change needed; it's already accurate. The Source Layout entry for `ModelConfig.tsx` mentions Checkpoints / LoRAs / Add Models sub-tabs — also still accurate.

The schema documentation (if there's one in CLAUDE.md, or in prisma/schema.prisma comments) should mention that `CheckpointConfig.baseModel` is now actively populated and used. If no such doc exists, skip this.

When done, push the branch and create the PR via `gh pr create` per AGENTS.md.
