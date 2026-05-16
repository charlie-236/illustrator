# Batch — Wan LoRA expert scope: ingest detection + manual override UI

CivitAI ships paired Wan 2.2 LoRAs as two separate files: one trained against the high-noise expert, one against the low-noise expert. Each file's weights are designed to inject into ONE specific transformer chain. The schema has `appliesToHigh` and `appliesToLow` flags on `LoraConfig` to control this — but they default to `(true, true)` for every ingested LoRA, and there's no UI to edit them. The original Wan LoRA support batch assumed single-expert LoRAs were "a minority case"; that assumption no longer matches reality.

Result today: ingest both paired files, add both to a stack, each file injects into BOTH chains. Each transformer ends up with the wrong-expert weights applied to it alongside the right-expert weights. Output is structurally corrupted; the artist intent isn't faithfully reproduced.

Two-part fix:

1. **Ingest auto-detection.** Inspect the CivitAI filename + version name for `high_noise` / `low_noise` patterns. When detected, set `appliesToHigh` / `appliesToLow` accordingly at ingest time. Most users never edit anything; the right thing happens automatically.
2. **Per-LoRA override UI in the Models tab.** Two checkboxes in the LoRA editor (Wan 2.2 LoRAs only). Tablet-friendly. Required for the long tail — single-expert LoRAs that don't follow naming conventions, user overrides, edge cases the heuristic misses.

Re-read CLAUDE.md before starting.

---

## Critical: disk-avoidance contract is unaffected

This batch touches:
- `src/lib/registerModel.ts` (new helper + write to existing upsert)
- `src/components/ModelConfig.tsx` (two new form fields in the LoRA editor)
- The PUT route at `src/app/api/lora-config/route.ts` (verify-only — already accepts the fields per the existing partial-update spread)

Nothing in the workflow build path, the WS finalize path, or any image/video output handling changes. The forbidden-class-type guards are untouched. Verify with greps after the change.

---

## Required changes

### Part 1 — Ingest detection in `src/lib/registerModel.ts`

Add a helper alongside the existing `extractCategoryFromTags`:

```ts
/**
 * Detect whether a Wan 2.2 LoRA file targets the high-noise or low-noise expert
 * based on its CivitAI filename and version name.
 *
 * Returns null when no clear signal is present — caller should keep schema
 * defaults (both true) so non-paired LoRAs retain "applies to both" behavior.
 *
 * Patterns matched (case-insensitive): "high noise", "high_noise", "high-noise",
 * "highnoise" — and the same for "low".
 */
function detectWanExpertScope(meta: CivitAIMetadata): {
  appliesToHigh: boolean;
  appliesToLow: boolean;
} | null {
  const haystack = [
    meta.files?.[0]?.name ?? '',
    meta.name ?? '',
  ].join(' ').toLowerCase();

  const highMatch = /high[\s_-]?noise/.test(haystack);
  const lowMatch  = /low[\s_-]?noise/.test(haystack);

  if (highMatch && !lowMatch) return { appliesToHigh: true,  appliesToLow: false };
  if (lowMatch  && !highMatch) return { appliesToHigh: false, appliesToLow: true };

  // Both matched (ambiguous label) or neither → no override; keep defaults.
  return null;
}
```

Conservative by design: matches only the explicit "high noise" / "low noise" idiom (`high_noise`, `high-noise`, `highnoise`, `high noise`, etc.). Doesn't try to infer from "h"/"l" suffixes or from version-numbered patterns alone — too many false positives.

The exact `CivitAIMetadata` field shapes (`files[0].name`, `name`) match what `extractCategoryFromTags` already reads. If the existing helper uses different field paths, mirror those — substance is what matters.

### Apply detection in the LoRA upsert

In the LoRA branch of `registerModel.ts`'s upsert, call the helper and conditionally override the schema defaults:

```ts
// LoRA branch
const category = extractCategoryFromTags(civitaiMetadata);
const expertScope = detectWanExpertScope(civitaiMetadata);

const record = await prisma.loraConfig.upsert({
  where: { loraName: filename },
  create: {
    loraName: filename,
    friendlyName,
    triggerWords,
    baseModel,
    category,
    description,
    url,
    // Detection overrides; otherwise schema defaults (true, true) apply via Prisma
    ...(expertScope ?? {}),
  },
  update: {
    friendlyName,
    triggerWords,
    ...(baseModel ? { baseModel } : {}),
    ...(category ? { category } : {}),
    description,
    url,
    // Re-ingest only updates expert scope when the heuristic produces a positive
    // detection — protects user manual overrides from being clobbered. Mirrors the
    // category guard pattern.
    ...(expertScope ?? {}),
  },
});
```

The conditional spread `...(expertScope ?? {})` is the load-bearing pattern. When `expertScope` is null (no detection), no fields are added to the upsert — schema defaults fire on create, existing values stay on update.

Don't touch the checkpoint or embedding branches.

### Part 2 — Override UI in `src/components/ModelConfig.tsx`

In the LoRA editor (Models tab → LoRAs sub-tab → row detail panel), add a "Wan 2.2 expert scope" section. Position: after the existing "Base Model" select, before "Category" — keeps the Wan-specific controls grouped near the base-model context that determines whether they're relevant.

**Visibility:** show only when the LoRA's baseModel matches the Wan canonical string. Use whatever constant `VideoLoraStack.tsx` exports (`WAN_BASE_MODEL`); if not easily importable, a `baseModel === 'Wan 2.2'` check inline is fine — surface in the PR description if you went the inline route. Image-side LoRAs don't see meaningless controls.

**Form state:** add `appliesToHigh: boolean` and `appliesToLow: boolean` to `loraForm` and `LORA_BLANK`. Default both to `true`. The form-load effect (which fires on `selectedLora` change) populates from the fetched config. The save body (`saveLora`'s PUT) includes both. The PUT route already accepts these fields per the existing partial-update spread (`...(body.appliesToHigh !== undefined && { appliesToHigh: Boolean(body.appliesToHigh) })`); no route changes.

**UI shape — checkboxes via label-as-touch-target pattern:**

Mirror the radio pattern from `DeleteConfirmDialog.tsx`. Label is the tap surface (44-48px touch target via padding); the `<input type="checkbox">` is the visual indicator inside.

```tsx
{loraForm.baseModel === WAN_BASE_MODEL && (
  <div>
    <label className="label">Wan 2.2 expert scope</label>
    <p className="text-xs text-zinc-400 mb-2">
      Wan 2.2 has two transformer experts (high-noise and low-noise). Paired CivitAI
      LoRAs ship as two files, one per expert — each should apply to only its
      target. General-purpose LoRAs apply to both.
    </p>
    <div className="space-y-2">
      <label className="flex items-start gap-3 p-3 rounded-xl border border-zinc-700 hover:border-zinc-600 cursor-pointer transition-colors">
        <input
          type="checkbox"
          checked={loraForm.appliesToHigh}
          onChange={(e) => loraField('appliesToHigh', e.target.checked)}
          className="mt-0.5 accent-violet-500 flex-shrink-0"
        />
        <div>
          <p className="text-sm font-medium text-zinc-200">Applies to high-noise expert</p>
          <p className="text-xs text-zinc-500 mt-0.5">Inject into the high-noise transformer chain</p>
        </div>
      </label>
      <label className="flex items-start gap-3 p-3 rounded-xl border border-zinc-700 hover:border-zinc-600 cursor-pointer transition-colors">
        <input
          type="checkbox"
          checked={loraForm.appliesToLow}
          onChange={(e) => loraField('appliesToLow', e.target.checked)}
          className="mt-0.5 accent-violet-500 flex-shrink-0"
        />
        <div>
          <p className="text-sm font-medium text-zinc-200">Applies to low-noise expert</p>
          <p className="text-xs text-zinc-500 mt-0.5">Inject into the low-noise transformer chain</p>
        </div>
      </label>
    </div>
    {!loraForm.appliesToHigh && !loraForm.appliesToLow && (
      <p className="text-xs text-amber-400/80 mt-2">
        Both unchecked — this LoRA will not be injected into any chain.
      </p>
    )}
  </div>
)}
```

The amber hint when both are unchecked surfaces the pathological case (user accidentally disabling everything) without blocking — they may have a reason.

### Part 3 — Studio submit-time enrichment is already correct

`useModelLists.ts` exposes `loraAppliesToHigh` and `loraAppliesToLow` records. Studio's video submit code reads from these maps when building each `WanLoraSpec` for the POST body. After this batch:

- New ingests populate the flags correctly via auto-detection.
- User edits via the new UI persist to the DB.
- `useModelLists` reads the up-to-date values on next refresh.
- Studio sends correct flags in the WanLoraSpec.
- `applyUserLoras` in `wan22-workflow.ts` injects each LoRA into only its target chain.

No Studio changes needed in this batch. Verify by reading the existing flow — if anything in the Studio video submit path *isn't* reading from `useModelLists` for these flags, surface in the PR description; do not silently fix.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "detectWanExpertScope" src/lib/registerModel.ts` shows the new helper definition and its call site in the LoRA branch.
- `grep -n "appliesToHigh\|appliesToLow" src/components/ModelConfig.tsx` shows the new form state and UI.
- The LoRA editor in the Models tab shows the expert-scope checkboxes for Wan 2.2 LoRAs and hides them for non-Wan LoRAs.
- Both checkboxes are tablet-friendly (label wraps the input as the touch surface; ≥44px effective tap area via the label's padding).
- The PUT route at `src/app/api/lora-config/route.ts` is unchanged in this batch (already accepts the fields).
- The workflow builder (`src/lib/wan22-workflow.ts`) is unchanged.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. **Auto-detect: high-noise file.** Find a paired CivitAI Wan 2.2 LoRA with "high_noise" in the filename. Ingest via Add Models. Inspect the new row (Prisma Studio or `psql`): confirm `appliesToHigh = true`, `appliesToLow = false`.
2. **Auto-detect: low-noise file.** Same paired LoRA, ingest the low-noise file. Confirm row has `appliesToHigh = false`, `appliesToLow = true`.
3. **Auto-detect: ambiguous filename.** Ingest a Wan LoRA whose filename has neither "high_noise" nor "low_noise". Confirm both flags = true (schema defaults).
4. **UI override.** Open the LoRA editor for the high-noise LoRA from step 1. Confirm both checkboxes are visible. Uncheck "Applies to high-noise expert" (should be checked) and check "Applies to low-noise expert" — wait, that's the inverse. Just verify the UI reflects the DB values, then untoggle and re-toggle one of them, save, reload the page, confirm persistence.
5. **UI scope.** Open the editor for an SDXL or Pony LoRA. Confirm the expert-scope section is hidden (non-Wan baseModel).
6. **Re-ingest preserves manual override.** Take the high-noise LoRA from step 1; via the UI, manually flip both flags to (false, true). Save. Re-ingest the same LoRA from CivitAI through Add Models. Inspect the row: confirm the heuristic re-detected (true, false) — the heuristic's positive detection updates the values. (This is intentional — the heuristic re-runs on re-ingest. If you want the manual edit to survive re-ingest, edit the file's CivitAI filename to no longer match the pattern, or accept the auto-detect behavior.)
7. **Both unchecked warning.** In the LoRA editor, uncheck both checkboxes. Confirm the amber "this LoRA will not be injected into any chain" hint appears. Save anyway.
8. **End-to-end paired generation.** Ingest a paired LoRA (both files). Confirm steps 1–2 set the flags correctly. Add both to a video LoRA stack at weight 1.0. Generate. Confirm output is plausible (paired LoRAs working as intended, not double-injection corruption). Compare side-by-side to a generation with only the high file at default `(true, true)` — there should be a visible quality difference.
9. **Workflow JSON spot-check.** Capture the workflow JSON sent to ComfyUI during step 8 (network panel or debug log). Confirm the high-noise LoRA produces exactly one `LoraLoaderModelOnly` node injected into the high chain, and the low-noise LoRA produces exactly one injected into the low chain. Total: 2 LoRA nodes for 2 files, not 4.
10. **Image-side regression check.** Generate an SDXL image with a LoRA applied. Confirm no errors, no UI regressions in the image-side LoRA picker.

---

## Out of scope

- Backfilling existing LoRA rows that were ingested before this batch. They keep their `(true, true)` defaults; the user fixes via the new UI or by re-ingesting (which re-runs the heuristic). For Charlie's collection size (small), manual fix-up is fine.
- Schema changes. Both fields already exist with defaults; no migration needed.
- Detection heuristics beyond filename + version name. Don't try to read `.safetensors` internal metadata, don't probe the file. The filename pattern is the canonical signal.
- Detection from `model.name` alone — too generic, false-positive-prone.
- Per-LoRA UI in Studio's video form (the running-batch picker). Models tab is the canonical edit surface.
- Showing the expert-scope state in the picker rows or in the gallery sidebar. Models tab only.
- Lightning + user LoRA quality validation. Existing experimental warning stands.
- Adding a "high-only / low-only / both" tri-state radio instead of two checkboxes. Two checkboxes match the underlying schema shape (two independent booleans) and allow the both-unchecked case (which is currently legal — the workflow injection just skips). Don't conflate.
- Surfacing the heuristic's confidence to the user. If detection ran and produced a result, the values are written; the UI shows whatever's in the DB.
- Auto-pairing detected high/low LoRAs in the Models tab UI ("we noticed these two are a pair"). Out of scope; future feature if useful.
- Image-side LoRA changes. The flags exist on every LoRA row but only matter for the Wan video workflow.

---

## Documentation

In CLAUDE.md, find the LoRA-related Wan 2.2 documentation (likely under "Wan LoRA support" or similar). Add a paragraph:

> **Expert scope.** Wan 2.2 has two transformer experts (high-noise, low-noise). Paired CivitAI LoRAs ship as two files, one per expert. `LoraConfig.appliesToHigh` and `appliesToLow` (both boolean, schema default true) control which transformer chain each LoRA injects into. Auto-detected at ingest from the CivitAI filename pattern (`high_noise` / `low_noise`); user-editable in the Models tab LoRA editor for non-paired LoRAs or detection misses. The workflow builder (`applyUserLoras` in `wan22-workflow.ts`) creates one `LoraLoaderModelOnly` node per active flag — a paired-correctly stack of N pairs produces N×2 nodes total (one per chain).

In the schema doc block in CLAUDE.md, the `LoraConfig` model already shows `appliesToHigh` and `appliesToLow` (added in the original Wan LoRA support batch). No schema-doc-block changes needed.

In the source layout entry for `registerModel.ts`, update to note the helper:

> `extractCategoryFromTags` and `detectWanExpertScope` are called from the relevant branches of `registerModel`. Both consume the CivitAI metadata returned by the ingest pipeline; both return null when no positive signal is present, leaving schema defaults intact.

In the source layout entry for `ModelConfig.tsx`, mention the new conditional UI section: "LoRA editor includes Wan 2.2 expert-scope checkboxes (visible only for Wan LoRAs)."

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
