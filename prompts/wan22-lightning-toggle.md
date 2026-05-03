# Batch — Wan 2.2 Lightning toggle (Phase 1.4a)

Wan 2.2 generation today takes ~14 minutes per clip at 12 steps. Lightx2v's Lightning distilled LoRAs cut this to ~3 minutes by enforcing 4 steps total (2 per UNet expert) at CFG=1. This batch adds a Lightning toggle to the video form.

**Not** general LoRA support — Lightning is structurally a fixed-pair LoRA mode with locked step/CFG values, not a stackable SD-style LoRA. General Wan LoRA support lands in a separate batch (Phase 1.4b).

Re-read CLAUDE.md before starting.

---

## Prep work — already done

The four Lightning LoRA files are already on the VM. **Do not re-download or move them.** Verify they exist:

```bash
ssh a100-core ls -lh /models/ComfyUI/models/loras/wan22-lightning-t2v/ \
                     /models/ComfyUI/models/loras/wan22-lightning-i2v/
```

Expected layout:

```
/models/ComfyUI/models/loras/wan22-lightning-t2v/high_noise_model.safetensors  (1.23G)
/models/ComfyUI/models/loras/wan22-lightning-t2v/low_noise_model.safetensors   (1.23G)
/models/ComfyUI/models/loras/wan22-lightning-i2v/high_noise_model.safetensors  (1.23G)
/models/ComfyUI/models/loras/wan22-lightning-i2v/low_noise_model.safetensors   (1.23G)
```

The upstream lightx2v repo names both files generically (`high_noise_model.safetensors`, `low_noise_model.safetensors`) and ships them in per-variant subfolders. We preserved the upstream filenames and used directory naming to disambiguate t2v vs i2v. This means a future v1.2 release means swapping directory contents without touching code.

There's also a `/models/ComfyUI/models/loras/_reference/` directory with the canonical lightx2v ComfyUI workflow JSONs (`wan22-lightning-t2v-workflow.json`, `wan22-lightning-i2v-workflow.json`). Use those as the source of truth for the LoRA wiring pattern — node IDs, link structure, sampler config — when implementing the workflow builder changes below. ComfyUI will scan that directory at startup but won't try to use the JSONs as LoRAs (it expects safetensors), so they're harmless to leave there.

In a `LoraLoaderModelOnly` ComfyUI node, the `lora_name` field is relative to `loras/` and uses forward slashes regardless of OS. The four canonical strings are:

- `wan22-lightning-t2v/high_noise_model.safetensors`
- `wan22-lightning-t2v/low_noise_model.safetensors`
- `wan22-lightning-i2v/high_noise_model.safetensors`
- `wan22-lightning-i2v/low_noise_model.safetensors`

These are the strings to hardcode in the workflow builder.

---

## Required changes

### `src/lib/wan22-workflow.ts` — extend builder for Lightning mode

The existing `VideoParams` type adds:

```ts
type VideoParams = {
  // ... existing fields ...
  lightning?: boolean;  // default false
};
```

When `lightning` is true:

1. **Inject two `LoraLoaderModelOnly` nodes** into the workflow graph, one per UNet half:

   ```ts
   // For t2v:
   wf['100'] = {
     inputs: {
       lora_name: 'wan22-lightning-t2v/high_noise_model.safetensors',
       strength_model: 1.0,
       model: ['37', 0],  // existing high-noise UNETLoader
     },
     class_type: 'LoraLoaderModelOnly',
     _meta: { title: 'Lightning LoRA (high noise)' },
   };

   wf['101'] = {
     inputs: {
       lora_name: 'wan22-lightning-t2v/low_noise_model.safetensors',
       strength_model: 1.0,
       model: ['56', 0],  // existing low-noise UNETLoader
     },
     class_type: 'LoraLoaderModelOnly',
     _meta: { title: 'Lightning LoRA (low noise)' },
   };
   ```

   For i2v: identical shape, swap `wan22-lightning-t2v/` → `wan22-lightning-i2v/` in the `lora_name` strings.

2. **Rewire the ModelSamplingSD3 nodes** to consume from the LoRA loaders instead of from the UNETLoaders directly:

   ```ts
   wf['54'].inputs.model = ['100', 0];  // was ['37', 0]
   wf['55'].inputs.model = ['101', 0];  // was ['56', 0]
   ```

3. **Force step count to 4 and CFG to 1**, ignoring whatever the caller passed for `steps` and `cfg`. Use the existing MoE step-coupling helper:

   ```ts
   if (params.lightning) {
     applySteps(wf, 4);  // 4 total, 2/2 split
     wf['57'].inputs.cfg = 1;
     wf['58'].inputs.cfg = 1;
   } else {
     applySteps(wf, params.steps);
     wf['57'].inputs.cfg = params.cfg;
     wf['58'].inputs.cfg = params.cfg;
   }
   ```

4. **Sampler choice.** The lightx2v reference workflow uses LCM sampler at low CFG. Cross-check `_reference/wan22-lightning-t2v-workflow.json` to confirm exact sampler/scheduler values for the two `KSamplerAdvanced` nodes (57, 58) when Lightning is active. Apply those values when `params.lightning === true`; preserve existing sampler choices when off.

5. **Keep the negative prompt node intact.** Per architecture decision: at CFG=1 the negative is computationally ignored, but the graph topology stays stable across modes. Cleaner builder, no functional difference.

### `src/app/api/generate-video/route.ts` — accept lightning flag

Request body extends:

```ts
{
  // ... existing fields ...
  lightning?: boolean;
}
```

**Validation when `lightning === true`:**

- If the caller passes `steps`, ignore it (override to 4 server-side, log a debug-level warning if it wasn't already 4).
- If the caller passes `cfg`, ignore it (override to 1).
- All other validation rules unchanged.

The route doesn't reject mismatched values — it silently overrides. The Studio UI already locks the affected fields (see below), so a mismatched value would only come from a non-UI caller (curl, future API consumer) and they'd want the override behavior anyway.

**Watchdog timeout:** keep at 15 minutes for now. Lightning generations finish in ~3 min so the timeout is over-provisioned, but tightening it provides no benefit and risks false-fail if the VM is under load.

### `src/components/Studio/VideoForm.tsx` (or whatever the video form is named) — Lightning toggle

In the video settings popout (or wherever the popout lands per the consistency batch), add at the **top** of the popout:

```
[ ] Lightning (4 steps, ~3 min)
    Faster generation. Steps and CFG are locked.
```

When the toggle is on:

- Steps slider visually disabled, displays "4 (locked)" with a small hint icon explaining why.
- CFG slider visually disabled, displays "1 (locked)".
- Submit sends `lightning: true` in the body.
- Form's local state for steps and cfg is unchanged — toggling Lightning off restores whatever the user had.

When the toggle is off:

- Steps and CFG sliders are enabled with their current values.
- Submit sends `lightning: false` (or omits the field).

The toggle's default state: **off**. The user opts in per generation.

If the user has the toggle on when they switch from video → image mode and back, the toggle state persists (sessionStorage or whatever the existing video-form persistence pattern uses).

### Project default for Lightning

In Phase 2.1's `Project.default*` fields, add `defaultLightning Boolean?`. When the user generates a clip in a project context, the Lightning toggle pre-fills from the project's default. This way a project can be set to "always Lightning" or "always full-quality" without re-toggling per clip.

If Phase 2.1's PR is already merged, this is a quick schema addition (one field, one migration). If 2.1 is still in flight, fold this into 2.1's PR before it lands. The agent should check git log to see which case applies.

The project Settings modal gets a corresponding tri-state control (On / Off / No default) for Lightning, alongside the existing default fields.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- The four Lightning LoRA files are present at the canonical paths on the VM (verifiable via `ssh a100-core ls /models/ComfyUI/models/loras/wan22-lightning-t2v/ /models/ComfyUI/models/loras/wan22-lightning-i2v/`).
- The video form popout has a Lightning toggle at the top.
- Toggling Lightning on disables and visually locks the steps and CFG sliders with explanatory hints.
- Toggling Lightning off restores the steps and CFG sliders to their previous values.
- Submitting with Lightning on sends `lightning: true` in the request body and produces a video with 4-step generation.
- Submitting with Lightning off uses the existing 12-step (or whatever's set) flow.
- The route silently overrides `steps` and `cfg` when `lightning: true`.
- Project Settings modal has a Lightning default tri-state control.
- New clips generated within a project pre-fill the Lightning toggle from the project's default.

Manual smoke test (deferred to user):

1. Open Studio, video mode. Confirm Lightning toggle is visible in the settings popout, default off.
2. Generate a clip with Lightning off — confirm the existing 12-step flow runs (~14 min), output looks normal.
3. Generate a clip with Lightning on, same prompt and seed — confirm wall-clock is ~3 minutes (3-5x faster), output is recognizably the same scene with Lightning's quality characteristics.
4. With Lightning on, confirm the steps and CFG sliders are visually disabled and show "4 (locked)" / "1 (locked)".
5. Toggle Lightning off mid-form — confirm steps and CFG sliders restore to whatever you had before.
6. Open a project, set Lightning default = On. Click "Generate new clip in this project." Confirm Studio opens with the toggle pre-filled to On.
7. Change project default to Off. Confirm new clips pre-fill Off.
8. Verify in the queue tray that Lightning jobs and non-Lightning jobs are visually indistinguishable (same row format) — Lightning is a generation mode, not a media-type variant.

---

## Out of scope

- General Wan LoRA support. Phase 1.4b.
- Lightning as default. The toggle defaults off; flip the default in a follow-up doc-only batch after the user has compared output for a couple weeks.
- A "Lightning v1.2" config UI. When Lightning ships an update, swap the filenames in the workflow builder; that's the entire change.
- Lightning for image generation. SD has its own distillation ecosystem (LCM, Lightning for SDXL, Hyper) — separate concern.
- Removing the negative prompt node when Lightning is on. Keep graph topology stable.
- A "preview Lightning quality" comparison UI. The user generates one of each and eyeballs.
- Auto-detection of "this image looks like Lightning quality might be acceptable" heuristics. Out of scope.
- Showing wall-clock estimate based on Lightning toggle state. The 3min vs 14min difference is large enough that the user knows; no UI estimator needed.

---

## Documentation

In CLAUDE.md, find the "Video generation (Phase 1)" section. Add a subsection "Lightning mode":

> Wan 2.2 Lightning is a 4-step distilled mode using lightx2v's Seko LoRAs. When the Lightning toggle is on, the workflow builder injects two `LoraLoaderModelOnly` nodes (one per UNet expert), forces steps=4 and CFG=1, and otherwise produces the same output structure. Generation time drops from ~14 min to ~3 min at the cost of some quality loss. The toggle lives at the top of the video settings popout, defaults off, and is overridable per project via the project's `defaultLightning` field.
>
> LoRA layout on the VM (preserves upstream filenames; subdirectory naming disambiguates variants):
>
> - `loras/wan22-lightning-t2v/high_noise_model.safetensors`
> - `loras/wan22-lightning-t2v/low_noise_model.safetensors`
> - `loras/wan22-lightning-i2v/high_noise_model.safetensors`
> - `loras/wan22-lightning-i2v/low_noise_model.safetensors`
>
> Reference workflows from lightx2v are stashed in `loras/_reference/`. If lightx2v ships v1.2+, the upgrade is to drop the new safetensors into the same subdirectories — no code changes needed.

In CLAUDE.md's video parameter section, note that `lightning: true` overrides the caller-provided `steps` and `cfg`.

When done, push and create the PR via `gh pr create` per AGENTS.md. Include in the PR description: head-to-head comparison videos (or links) of the same prompt+seed with Lightning on vs off, wall-clock times for both, and confirmation that the four LoRA files are on the VM at the expected paths.
