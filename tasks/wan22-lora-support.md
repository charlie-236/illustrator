# Batch — Wan 2.2 LoRA support (Phase 1.4b)

Stackable, weighted Wan 2.2 LoRAs from CivitAI. Phase 1.4a's Lightning is a fixed-pair distillation mode; this batch is general-purpose LoRA support that follows the existing image-side pattern: ingest pipeline obfuscates the on-disk filename to a 6-byte hex stem; `LoraConfig.loraName` stores that obfuscated name (it's `@unique` on the schema); `friendlyName` is the human-readable label shown in UI everywhere; the obfuscated `loraName` is referenced only inside `LoraLoader` workflow nodes (where ComfyUI needs it to resolve the on-disk file).

CivitAI hosts a growing library of Wan 2.2 LoRAs — character LoRAs, style LoRAs, motion LoRAs. They stack with weight controls. The structural difference from SD LoRAs: each Wan LoRA injection produces *two* nodes in the workflow (one per UNet expert), not one.

Re-read CLAUDE.md and Phase 1.4a's PR before starting.

---

## Critical: do NOT leak the obfuscated filename

The image-side pattern (verified) uses `LoraConfig.loraName` as the obfuscated 6-byte hex stem (e.g. `0ceb16b3cecb.safetensors`). The user-visible identifier everywhere is `LoraConfig.friendlyName`. The architectural rule:

- **The only place `loraName` (the obfuscated value) appears in transmitted/stored output is the `lora_name` field of `LoraLoader` / `LoraLoaderModelOnly` nodes in workflow JSON sent to ComfyUI.** ComfyUI requires it to resolve the on-disk file.
- **Everywhere else** — `_meta.title` in workflow JSON, console logs, console errors, API responses, debug strings, error messages, anywhere observable — uses `friendlyName`.

If you find any code path in this batch (or in pre-existing image-side code you read while implementing) that leaks the obfuscated `loraName` outside the `lora_name` field, that's a defect. Surface it in the PR description; fix in this PR if scope permits, otherwise file as a follow-up.

The existing Wan video filename obfuscation work (output filenames) used a similar pattern; this batch extends the principle to model filenames in workflow injection.

---

## What to build

### 1. Schema additions to `LoraConfig`

Add Wan-specific fields to `prisma/schema.prisma`:

```prisma
model LoraConfig {
  // ... existing fields (id, loraName, friendlyName, triggerWords, baseModel, description, url, updatedAt) ...
  appliesToHigh    Boolean  @default(true)
  appliesToLow     Boolean  @default(true)
}
```

Why both default to `true`: most Wan LoRAs train against both experts. Single-expert LoRAs (a minority case — some character LoRAs trained only on the low-noise expert for fine detail) get the flags adjusted post-ingest by the user. Defaulting both to `true` means existing rows (image-side LoRAs) continue working with the existing image-side builder unchanged.

Migration: `add_wan_lora_fields`. Test that `npx prisma migrate dev` applies cleanly. Existing rows backfill with both flags `true`.

### 2. Base-model normalization for Wan LoRAs

The image-side `registerModel.ts` already extracts `baseModel` from CivitAI metadata for the LoRA branch and writes it into `LoraConfig.baseModel`. For Wan LoRAs from CivitAI, the `baseModel` string returned by the API needs verification — find a known Wan LoRA on CivitAI, fetch its model-version metadata, and observe the exact `baseModel` value returned. Normalize to a single canonical string used internally — e.g., `'Wan 2.2'` or `'wan22'` (match the casing convention in the existing schema's seed data or other rows).

Look at `src/lib/registerModel.ts` to see how `baseModel` is currently passed through. The normalization happens before the upsert. Decide: normalize at the metadata-extraction point (in `registerModel.ts`) or at the ingest entry point (in `civitaiIngest.ts`)? The cleanest answer is wherever the existing canonical-string comparisons happen for SD models. Read first; pick the lower-disruption point.

If CivitAI's API doesn't expose Wan-specific tags reliably, fall back heuristics:
- File size: Wan rank-64 LoRAs are typically 600MB+; SDXL LoRAs are 100-300MB.
- Filename pattern from the upstream model name (before obfuscation).

But this is a heuristic only. The API metadata is the source of truth. Document in the PR description what was observed.

### 3. Expert detection at ingest

CivitAI doesn't have a structured "applies to high/low" field. Two paths:

- **(a)** Default both flags to `true` at ingest. The user manually edits in the LoRA editor (Models tab) when they know a particular LoRA is single-expert.
- **(b)** Parse the LoRA's training metadata at ingest. Wan-trained LoRAs may have a `training_target` or similar key in their internal `.safetensors` metadata.

(b) is the right answer if quick to implement. If parsing safetensors metadata isn't a 30-minute task, ship (a) — it's the safe default. Document in the PR description which path was chosen.

### 4. LoRA picker filtering — mode-aware

The existing image-side LoRA picker filters by the active checkpoint's `baseModel`. Extend the filtering logic to be aware of Studio mode:

- In **video mode**: only LoRAs with `baseModel === '<wan canonical string>'` show.
- In **image mode** (existing behavior, unchanged): only LoRAs matching the active checkpoint's `baseModel` show.

The Models tab itself does NOT filter by mode — the user manages all LoRAs from one place regardless of which Studio mode is active.

Find the LoRA picker component (likely `ModelSelect.tsx` or one of its children, since that's where the existing filtering lives). The mode awareness should be a single conditional on the visible-list computation, not a refactor of the picker's structure.

### 5. LoRA stack in video mode

The video form gets a LoRA stack control mirroring the image form's pattern. Position: in the video settings popout (per PR #27, the consistency batch), below the Lightning toggle.

UI requirements:
- "Add LoRA" button opens a picker showing only Wan LoRAs.
- **Picker rows display `friendlyName` only.** Never the obfuscated `loraName`.
- Selected LoRAs render as rows with: `friendlyName`, weight slider (0.0–2.0, default 1.0, step 0.05), remove × button.
- Stack is ordered (insertion order; reorder via drag if image side does, otherwise no reorder).
- Empty state: "No LoRAs selected. Add one to refine output."

Stack persists in form state across mode switches (image ↔ video) within the same session. Match whatever persistence pattern the image-side LoRA stack uses.

### 6. Workflow builder — inject Wan LoRAs

In `src/lib/wan22-workflow.ts`, extend `VideoParams` to accept a LoRA stack. The type carries both fields explicitly so the separation between "what ComfyUI sees" and "what humans see" is impossible to forget at the call sites:

```ts
type WanLoraSpec = {
  loraName: string;        // obfuscated on-disk filename — required by ComfyUI to resolve the file
  friendlyName: string;    // human-readable name — used in _meta.title and any logs
  weight: number;
  appliesToHigh: boolean;
  appliesToLow: boolean;
};

type VideoParams = {
  // ... existing fields ...
  loras?: WanLoraSpec[];
};
```

Injection logic — chain through the high-noise and low-noise UNet outputs separately. Same pattern image-side LoRA stacks use, but with two parallel chains because of Wan's MoE structure:

```ts
let highModelRef: [string, number] = ['37', 0];  // t2v high UNETLoader (verify against template)
let lowModelRef:  [string, number] = ['56', 0];  // t2v low UNETLoader

let nextNodeId = 200;  // start after Lightning's range (Phase 1.4a uses 100-101)

if (params.lightning) {
  // Lightning injection from Phase 1.4a runs first, advancing highModelRef and lowModelRef
  // After Lightning: highModelRef = ['100', 0], lowModelRef = ['101', 0]
}

for (const lora of params.loras ?? []) {
  if (lora.appliesToHigh) {
    const id = String(nextNodeId++);
    wf[id] = {
      inputs: {
        lora_name: lora.loraName,           // obfuscated — ComfyUI needs this to find the file
        strength_model: lora.weight,
        model: highModelRef,
      },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `LoRA (high): ${lora.friendlyName}` },  // friendly name only
    };
    highModelRef = [id, 0];
  }
  if (lora.appliesToLow) {
    const id = String(nextNodeId++);
    wf[id] = {
      inputs: {
        lora_name: lora.loraName,
        strength_model: lora.weight,
        model: lowModelRef,
      },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `LoRA (low): ${lora.friendlyName}` },
    };
    lowModelRef = [id, 0];
  }
}

wf['54'].inputs.model = highModelRef;  // ModelSamplingSD3 (high)
wf['55'].inputs.model = lowModelRef;   // ModelSamplingSD3 (low)
```

For i2v: identical logic, different starting node IDs. Check the i2v template for its high-noise and low-noise UNETLoader IDs and parameterize.

**Verify against image-side `workflow.ts`:** read its `LoraLoader` injection. Confirm `_meta.title` uses `friendlyName` there too (or fix it in this PR if not). Pattern consistency is the goal.

### 7. Logging discipline

Any new logging code paths added in this batch use `friendlyName` exclusively when referring to a LoRA. Examples of leaks to avoid:

- `console.log(\`Injecting ${lora.loraName}\`)` — wrong; use `lora.friendlyName`.
- `console.error(\`Failed to apply ${spec.loraName}: ...\`)` — wrong.
- Including `loraName` in error responses to the client.

If you encounter pre-existing image-side code that violates this (search for `loraName` in console.* and error-response paths in `src/`), surface in the PR description. Fix in this PR if scope allows; otherwise note as a follow-up.

### 8. Lightning + user LoRA interaction

A user LoRA injected after Lightning's high-noise loader stacks naturally — the chain runs Lightning's LoRA → user's LoRA → ModelSamplingSD3. Same for low. The user's weight applies on top of Lightning's weight=1.0.

Structurally fine. Quality is a different question: Lightning was distilled against the bare base model, not against arbitrary LoRA combinations. Show a small "Lightning + LoRA stack: experimental" hint in the popout when both are active. No hard block — let the user experiment.

### 9. Project default for video LoRA stack

Add `Project.defaultVideoLoras` as a JSON-encoded string column (Prisma `String?`). Stores a serialized `WanLoraSpec[]`. New clips generated within a project pre-fill the LoRA stack from this default.

The project Settings modal (per Phase 2.1) gets a "Default video LoRAs" section that lets the user build a stack — reuse the same LoRA stack control component used in Studio's video form.

Storage caveat: `defaultVideoLoras` will include `loraName` (obfuscated) and `friendlyName`. Both fields are fine to persist — `loraName` is already in the DB on `LoraConfig`, this is a redundant denormalization for fast read. If a LoRA is later renamed (friendlyName edited in Models tab), the project's stored `friendlyName` becomes stale until the user rebuilds the stack. Acceptable; flagging not a bug.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- Migration `add_wan_lora_fields` applies cleanly. Existing LoRA rows have `appliesToHigh: true, appliesToLow: true`.
- The PR description confirms Pattern A (full obfuscation) is in effect on the image side, with citations to `civitaiIngest.ts` and `registerModel.ts` showing the existing flow. (Per architect verification: ingest uses `randomBytes(6).toString('hex')` for the file stem, stores result as `loraName`, exposes `friendlyName` separately.)
- Ingesting a Wan LoRA from CivitAI sets `baseModel` to the Wan canonical string and creates a row whose `loraName` is the 6-byte hex stem with `.safetensors` suffix.
- The LoRA picker in image mode hides Wan LoRAs.
- The LoRA picker in video mode hides non-Wan LoRAs.
- Adding a Wan LoRA to the video form's stack and generating produces a workflow JSON where `lora_name` is the obfuscated `loraName` and `_meta.title` uses `friendlyName`. Verified by capturing the JSON in network tab or debug log.
- A LoRA with `appliesToHigh: true, appliesToLow: false` produces only one injection, on the high-noise chain.
- Project Settings modal has a default video LoRA stack control. Saving and reloading persists the stack.
- New clips in a project pre-fill the LoRA stack from the project default.
- No new code path logs the obfuscated `loraName`. The friendly name is the human-readable surface everywhere.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. Ingest a Wan LoRA from CivitAI via the Add Models flow. Inspect the on-disk filename at `/models/ComfyUI/models/loras/` — confirm it's a 6-byte hex string + `.safetensors`, NOT the upstream CivitAI name.
2. Open Studio video mode. Open the LoRA picker. Confirm the Wan LoRA appears with its friendly name. Confirm SD-side LoRAs are not in the list.
3. Open Studio image mode with an SDXL checkpoint selected. Open the LoRA picker. Confirm the Wan LoRA is NOT in the list. Confirm matching-base SD LoRAs are.
4. Add the Wan LoRA to the video form's stack with weight 0.8. Generate. Confirm the LoRA visibly affects the output.
5. Capture the workflow JSON sent to ComfyUI (network tab or debug log). Confirm `lora_name` is the obfuscated 6-byte hex filename and `_meta.title` shows the friendly name. Confirm no other place in the JSON leaks the upstream name.
6. Edit the LoRA in the Models tab — set `appliesToLow: false`. Generate again. Confirm output reflects only-high-noise application.
7. Add 3 LoRAs to the stack at varying weights. Generate. Confirm the stack chains correctly (no errors from ComfyUI about disconnected nodes).
8. Set a project's default video LoRA stack to one specific LoRA at weight 0.5. Click "Generate new clip in this project." Confirm the LoRA stack pre-fills with that single entry.
9. Lightning + user LoRA: toggle Lightning on, add a Wan LoRA to the stack. Generate. Confirm output is plausible (artifacts are acceptable — this combination is documented as experimental).
10. Server logs during generation: confirm no log line contains the raw `loraName` (the hex string). If any do, that's a leak.

---

## Out of scope

- LoRA trigger words. Image-side LoRAs already have `triggerWords` populated from CivitAI metadata; the existing column applies. No new UI.
- Per-LoRA negative-prompt fragments. Out of scope.
- Auto-detection of which expert a LoRA was trained against beyond what CivitAI metadata or `.safetensors` internal metadata exposes. Manual user override is the long tail.
- Lightning + user LoRA quality testing or auto-warning beyond the small experimental hint.
- `strength_clip` parameter — the existing image-side `LoraLoader` uses both `strength_model` and `strength_clip`; for Wan video we use `LoraLoaderModelOnly` (no CLIP loader chained through, since Wan uses its own text encoder). Don't add `strength_clip`.
- Visual indicator in the gallery showing "this video was generated with N LoRAs."
- A "popular Wan LoRAs" suggestion list.
- A "remix this video and replace its LoRA stack" UX. Standard remix carries LoRAs along; user edits the stack manually in Studio.
- Comprehensive audit of every existing log statement in the codebase for raw-filename leakage. Scope to new code paths added in this batch and the touch points required to make Wan LoRA injection work. Pre-existing leaks elsewhere are file-as-follow-up.

---

## Documentation

In CLAUDE.md, find or add a section documenting the obfuscation pattern (since the user has explicitly stated this is a privacy/security concern):

> Model filenames (LoRAs, checkpoints, embeddings) are obfuscated at ingest time. `civitaiIngest.ts` generates a 6-byte hex stem via `randomBytes(6).toString('hex')`; the file lands on disk as `<hex>.safetensors`; `LoraConfig.loraName` (and equivalents) store that obfuscated string. The user-visible identifier everywhere — UI rows, picker labels, workflow `_meta.title`, logs, error messages — is `friendlyName`. The only place the obfuscated `loraName` appears observably is the `lora_name` field of `LoraLoader` / `LoraLoaderModelOnly` nodes in workflow JSON sent to ComfyUI, where it's required for ComfyUI to resolve the on-disk file.

Find the Wan video section. Add a subsection "Wan LoRA support":

> Wan 2.2 LoRAs from CivitAI use the same ingest pipeline (with the same 6-byte hex filename obfuscation) as SD LoRAs but require two booleans (`appliesToHigh`, `appliesToLow`) indicating which UNet expert(s) they affect. Most Wan LoRAs apply to both. The video form's LoRA stack injects `LoraLoaderModelOnly` nodes per LoRA per applicable expert, chained between UNETLoader (or Lightning's loader) and ModelSamplingSD3. Lightning + user LoRA combinations are flagged "experimental" in the UI since Lightning was distilled against the bare base, not against arbitrary LoRA stacks.
>
> The LoRA picker filters by base model: video mode shows only Wan LoRAs; image mode shows only LoRAs matching the active checkpoint's base. Models tab shows all LoRAs unfiltered.

Find the API routes table — no new routes; ingest paths are unchanged.

Find the source layout. Update or extend the LoRA stack component to be mode-aware.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
