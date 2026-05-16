# Batch — Per-checkpoint defaults

Every checkpoint has its own optimal generation parameters — SDXL Lightning wants 4-8 steps and CFG 1, IL/NoobAI checkpoints want 28-30 steps and CFG 4-7, Pony wants its own range. Today the user has to remember and re-enter these every time they switch checkpoints; the form values just persist across selections, leading to bad outputs whenever the user forgets to adjust.

Fix: store recommended defaults on the `CheckpointConfig` row, and have the Studio image form auto-populate from them when a checkpoint is selected. User can override per-generation; defaults aren't constraints.

Re-read CLAUDE.md before starting.

---

## What to build

### 1. Schema additions to `CheckpointConfig`

```prisma
model CheckpointConfig {
  // ... existing fields ...
  defaultSteps         Int?
  defaultCfg           Float?
  defaultSampler       String?     // "euler", "dpmpp_2m_sde_gpu", etc.
  defaultScheduler     String?     // "normal", "karras", etc.
  defaultWidth         Int?        // multiple of 64, 512–2048
  defaultHeight        Int?
  defaultHrf           Boolean?    // hi-res fix on/off
  defaultNegativePrompt String?    // a negative prompt fragment associated with the checkpoint
}
```

All nullable. A checkpoint with no defaults set leaves the form alone on selection. Don't pre-fill nulls.

`defaultSampler` and `defaultScheduler` are free-form strings matching whatever values the existing sampler/scheduler dropdowns use — the agent should read those dropdowns' source data and validate at write-time that the saved value is one the UI knows how to render.

Generate a migration named `add_checkpoint_defaults`. Existing `CheckpointConfig` rows get nulls for all new fields. Test that `npx prisma migrate dev` runs cleanly.

### 2. ModelConfig editor — checkpoints sub-tab

The existing checkpoint editor in `ModelConfig.tsx` shows friendly name, trigger words, base model, category. Add a new collapsible section "Default settings" with these fields:

| Field | Widget | Default | Bounds |
|---|---|---|---|
| Default steps | number | empty | 1–80 (matches Studio's existing range) |
| Default CFG | number | empty | 1.0–20.0, step 0.1 |
| Default sampler | dropdown | empty | populated from existing sampler list |
| Default scheduler | dropdown | empty | populated from existing scheduler list |
| Default width | number | empty | multiple of 64, 512–2048 |
| Default height | number | empty | multiple of 64, 512–2048 |
| Default hi-res fix | tri-state (on/off/unset) | unset | — |
| Default negative prompt | textarea | empty | — |

"Empty" / "unset" for each field means the corresponding DB column is null and the form-population logic doesn't touch that field on selection.

Tri-state for hi-res fix: a regular checkbox is binary, but we want to distinguish "this checkpoint defaults to HRF off" from "this checkpoint has no opinion." Render as a small three-button group (Off / On / No default) or a select with three options.

The collapsible section is collapsed by default (matches the project Settings modal pattern from Phase 2.1). Expanded state persists per-session if it's easy; not load-bearing.

Save via the existing PATCH-checkpoint-config flow. The agent should confirm the existing route (`/api/checkpoint-config`) accepts these new fields and validates them appropriately (multiples of 64 for dimensions, range for cfg, etc.). If the route does shallow merging on PATCH, no changes needed; if it's a full replace, ensure null handling is correct (a user clearing a default should set the column to null, not omit it).

### 3. Studio image form — apply defaults on checkpoint selection

When the user selects a checkpoint in Studio's checkpoint picker:

1. The existing flow loads `CheckpointConfig` for that checkpoint (already happens — this is where ckptConfigId comes from).
2. **New:** for each non-null `default*` field in the loaded config, write that value into the Studio form's corresponding state. For null fields, **leave the form's current value alone.**
3. The user can then override any of the populated defaults before generating.

This is "soft fill" semantics: defaults populate, user can override, and switching back to a non-default checkpoint doesn't re-clear the form (the user's current values stay).

Important nuance: this should fire on **explicit user selection**, not on the initial form-load when Studio mounts. If Studio remembers the last-used checkpoint via session/localStorage and re-loads it on mount, defaults should NOT auto-apply — the user already had values they were working with. Detect "user clicked the checkpoint picker" vs "form remembered a previous selection." If the existing form-load logic doesn't distinguish, add a flag.

### 4. Negative prompt handling

Default negative prompt is the trickiest field because user behavior here is variable:

- Some users have a stable global negative prompt they always use ("(worst quality:1.4), bad hands, …") and don't want it overwritten by checkpoint switching.
- Others want the checkpoint's negative as the source of truth.

Apply the same soft-fill rule but with a small UX wrinkle: when the checkpoint has a `defaultNegativePrompt`, the Studio form's negative-prompt textarea should populate with it AND show a small affordance "+ append your own" — clicking the affordance keeps the checkpoint's default and adds a newline + cursor below for the user to add their own.

If the agent finds this UX too fussy to fit cleanly: just do straight soft-fill (overwrite the negative prompt textarea). Match the simpler pattern. The user can rebuild their personal negative as needed.

### 5. Don't apply defaults to the video form

This batch is image-only. The video form (Phase 1.2a) already gets defaults from the project context (Phase 2.2). Adding a third source of defaults (Wan 2.2 baseline → project default → checkpoint default) when there's only one checkpoint for video would be noise. Wan 2.2's defaults are good as-is.

If a future model adds video checkpoints with varying optimal params, revisit.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- Migration `add_checkpoint_defaults` applies cleanly. Existing rows have nulls for all new fields.
- The ModelConfig checkpoint editor exposes the new defaults section and persists them.
- Selecting a checkpoint in Studio (explicit click) populates the form fields that have defaults set on that checkpoint. Fields without defaults are unchanged.
- Loading Studio on mount with a remembered checkpoint does NOT re-apply defaults (form respects user's last-session values).
- Defaults can be cleared (set to null) via the editor — saving with empty fields persists null, not zero.
- The video form is unaffected.

Manual smoke test (deferred to user):

1. Open ModelConfig → Checkpoints. Pick a checkpoint. Set defaults: steps=28, cfg=5, sampler=euler, scheduler=normal, width=832, height=1216, HRF=on. Save.
2. Open Studio (image mode). Select a different checkpoint first to clear state. Then select the one you just configured. Confirm steps=28, cfg=5, sampler=euler, scheduler=normal, width=832, height=1216, HRF on.
3. Override steps to 35 in Studio. Switch to a different checkpoint with no defaults set. Confirm steps stays at 35 (no auto-reset).
4. Switch back to the original checkpoint. Confirm defaults re-apply (steps goes back to 28).
5. Set a default negative prompt on a checkpoint. Select it in Studio. Confirm the textarea populates. Decide based on the implementation: does the affordance work, or does it overwrite the textarea cleanly?
6. Refresh the page. Confirm Studio remembers your last-used checkpoint AND last-used form values (i.e., the override of steps to 35) — defaults should NOT re-fire on mount.
7. Generate an image with checkpoint defaults — confirm the generation actually uses the values shown in the form (not silently re-substituting at submit time).
8. Clear all defaults on a checkpoint by emptying the fields and saving. Confirm DB has nulls. Re-select that checkpoint in Studio — confirm form is untouched.

---

## Out of scope

- Bulk-set defaults across multiple checkpoints. One at a time.
- Inferring defaults from CivitAI metadata at ingest. Out of scope; the user knows their preferences better.
- LoRA defaults. LoRAs are stackable and their interaction with checkpoint defaults gets complicated. If the user wants per-LoRA suggested weight or recommended-checkpoint pairings, that's a separate batch.
- Per-checkpoint prompt template (e.g. always wrap in "score_9, score_8_up, …"). Out of scope; users can save these in their own snippets.
- A "reset form to defaults" button in Studio. The selection event already does this.
- Checkpoint-level resolution constraints (e.g. SDXL refuses anything below 768). Out of scope; existing validation is on the form, not per-checkpoint.
- Export / import checkpoint defaults as a JSON config. Out of scope.

---

## Documentation

In CLAUDE.md, find the section on the Models tab. Add a paragraph:

> Each checkpoint config can store recommended defaults: steps, CFG, sampler, scheduler, width, height, hi-res fix on/off, and a default negative prompt fragment. When the user selects a checkpoint in Studio, any non-null defaults populate the corresponding form fields. Selection is soft-fill — user overrides aren't reset by selecting another checkpoint, only by selecting one that has its own defaults to apply.

If there's documentation of the Studio image form's state-load behavior, note that the soft-fill happens on explicit picker click, not on mount-time restoration of remembered checkpoint.

When done, push and create the PR via `gh pr create` per AGENTS.md.
