# Batch — Remix sets batch size to 4

When the user clicks Remix on a clip in the gallery (or anywhere remix is exposed), the form populates with the clip's parameters and the user has to manually adjust batch size if they want alternates. With video-mode batch support shipped, remix becomes the natural "generate alternates" path — but only if the default batch size is set thoughtfully.

This batch changes remix to set `batchSize: 4` when populating the form, regardless of the original clip's batch size. User can adjust down to 1 if they want a single regeneration; default is 4 because the common remix intent is "give me alternates."

Re-read CLAUDE.md before starting. The video batch support batch (`video-batch-support`) must be merged before this batch runs.

---

## What to build

### 1. Locate the remix handler

`project_knowledge_search` for "remix" in the components and route directories. The handler likely lives in:

- The gallery modal sidebar (where the Remix button is)
- A handler in `Gallery.tsx` or `ImageModal.tsx` that populates Studio's form state

The remix button:
1. Reads the clicked generation's params (prompt, model, dimensions, seed, etc.).
2. Navigates to Studio (or sets active tab to Studio).
3. Pre-fills the form fields with those params.

### 2. Override `batchSize` to 4 on the populated form

Wherever the remix handler currently sets `batchSize` (probably copying from the source clip's value), change to set it explicitly to **4**.

If the handler populates a form-state object literal:

```ts
// Before:
setForm({ ...form, ...sourceParams });

// After:
setForm({ ...form, ...sourceParams, batchSize: 4 });
```

If the handler dispatches updates per-field, ensure `batchSize` is set last and overrides whatever `sourceParams` had:

```ts
// Whatever order the agent finds:
setBatchSize(4);  // explicit override after sourceParams pour-in
```

### 3. Apply to both image and video modes

Remix on an image clip → image-mode form, batchSize 4.
Remix on a video clip → video-mode form, batchSize 4.

If the existing remix handler branches by media type, both branches need the override. If it's a single handler that delegates to mode-specific populators, the override goes in both populators.

The cap is already 4 for both modes (per the video batch support batch), so setting batchSize=4 doesn't exceed any limit.

### 4. Edge cases

**Source clip's seed.** When the user remixes, the seed-handling depends on how remix currently behaves. Two patterns:

- **(a) Remix copies the seed verbatim.** With batchSize 4, this means take 1 reproduces the original clip exactly, takes 2-4 use seed+1, +2, +3 (or random per take if seed handling is different). Reproducible.
- **(b) Remix sets seed to -1 (random).** With batchSize 4, all 4 takes get random seeds. Genuinely different from the original.

The current behavior is whatever the existing remix does — don't change it. The user adjusts manually if they want different seed behavior. **Don't add seed-randomization logic as part of this batch.**

If the user wants reproducibility (take 1 == original clip), they leave the seed alone before clicking Generate. If they want all-fresh seeds, they tap the dice icon to randomize. Either workflow is preserved.

**Source clip with batchSize already > 1.** Remix on a clip from a previous batch ignores the source's `batchSize` value and always sets 4. This is consistent with the new "remix means alternates" semantics.

**Stitched outputs.** Remix on a stitched output is already an edge case (the stitch is a project artifact, not a primary generation). If remix on a stitched output is currently disabled, leave it disabled. If it's enabled and pre-fills with the stitch's metadata, set batchSize to 4 same as everywhere else.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- After remix on an image clip, the Studio image form's batchSize is 4 (regardless of the source clip's original batch size).
- After remix on a video clip, the Studio video form's batchSize is 4.
- The remix handler doesn't change seed behavior.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. Open the gallery. Click on an image generated with batchSize=1. Click Remix. In Studio, confirm the batch slider shows 4.
2. Click Generate. Confirm 4 jobs appear in the queue tray, all with the same prompt and matching params.
3. Same flow on a video clip. Confirm 4 jobs queue.
4. Adjust batch slider down to 1 in Studio after remix. Click Generate. Confirm exactly one job — the override doesn't lock the user in.
5. Confirm seed handling is unchanged: if remix preserved the source seed, take 1 should reproduce the original (modulo non-determinism in some sampler/scheduler combos).

---

## Out of scope

- Changing remix's seed-handling behavior.
- Adding a "remix once" button alongside "remix" for users who don't want batches. The slider override handles this — adjust to 1 before generating.
- Showing the source clip's batch size anywhere as context.
- Auto-grouping the 4 alternates from a remix into a "this was a remix of clip X" relationship in the schema. Each is an independent Generation row.
- Adding a different default batch for stitched-output remix (e.g. 1 for stitches since they're more curated). 4 across the board for symmetry.
- Schema changes. The override is purely UI-state.

---

## Documentation

In CLAUDE.md, find the section describing remix behavior. Add a sentence:

> Remix sets batch size to 4 by default, treating the action as "generate alternates of this clip." The user can adjust down before clicking Generate. This default applies to both image-mode and video-mode remix.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
