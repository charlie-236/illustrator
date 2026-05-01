# Batch — Extract useModelLists hook + clean up ModelSelect effect deps

Three related quality-of-life changes in the model-list UI:

1. `ModelSelect.tsx` and `ModelConfig.tsx` independently fetch the same three endpoints (`/api/models`, `/api/checkpoint-config`, `/api/lora-config`) on mount and on refresh. Extract that into a single `useModelLists` hook so both consumers stay in sync and the fetch logic lives in one place.
2. The auto-pick of `modelsData.checkpoints[0]` currently runs inside `refreshLists` in `ModelSelect.tsx`. That means every refresh (e.g., after a save bumps `modelConfigVersion`) re-runs the auto-pick. It should only fire once on initial load when no checkpoint is selected.
3. `ModelSelect.tsx` has `// eslint-disable-next-line react-hooks/exhaustive-deps` over both the `useCallback` for `refreshLists` and the `useEffect` that calls it. The deps are inconsistent (`refreshLists` depends on `[checkpoint, onCheckpointChange]`, the effect on `[refreshToken]`). Fix this without disabling the lint rule.

Re-read CLAUDE.md before starting. Disk-avoidance is unaffected. This is a pure UI refactor.

---

## Task 1 — Add `src/lib/useModelLists.ts`

New file (placed in `lib/` for consistency with other shared logic — there's no existing `hooks/` directory). Custom hook that owns the three-fetch-and-derive logic. Returns the loaded data + a `refresh` function + a `loading` flag. Exact shape:

```ts
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CheckpointConfig, LoraConfig, ModelInfo } from '@/types';

export interface ModelLists {
  checkpoints: string[];
  loras: string[];
  checkpointNames: Record<string, string>;       // checkpointName → friendlyName
  checkpointBaseModels: Record<string, string>;  // checkpointName → baseModel
  loraNames: Record<string, string>;             // loraName → friendlyName
  loraTriggerWords: Record<string, string>;      // loraName → trigger words
  loraBaseModels: Record<string, string>;        // loraName → baseModel
}

const EMPTY: ModelLists = {
  checkpoints: [],
  loras: [],
  checkpointNames: {},
  checkpointBaseModels: {},
  loraNames: {},
  loraTriggerWords: {},
  loraBaseModels: {},
};

export function useModelLists(refreshToken?: number): {
  data: ModelLists;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [data, setData] = useState<ModelLists>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch('/api/models').then((r) => r.json() as Promise<ModelInfo>),
      fetch('/api/checkpoint-config').then((r) => r.json() as Promise<CheckpointConfig[]>).catch(() => []),
      fetch('/api/lora-config').then((r) => r.json() as Promise<LoraConfig[]>).catch(() => []),
    ])
      .then(([modelsData, ckptConfigs, loraConfigs]) => {
        const checkpointNames: Record<string, string> = {};
        const checkpointBaseModels: Record<string, string> = {};
        for (const c of ckptConfigs) {
          if (c.friendlyName) checkpointNames[c.checkpointName] = c.friendlyName;
          if (c.baseModel) checkpointBaseModels[c.checkpointName] = c.baseModel;
        }
        const loraNames: Record<string, string> = {};
        const loraTriggerWords: Record<string, string> = {};
        const loraBaseModels: Record<string, string> = {};
        for (const l of loraConfigs) {
          if (l.friendlyName) loraNames[l.loraName] = l.friendlyName;
          if (l.triggerWords?.trim()) loraTriggerWords[l.loraName] = l.triggerWords;
          if (l.baseModel?.trim()) loraBaseModels[l.loraName] = l.baseModel;
        }
        setData({
          checkpoints: modelsData.checkpoints ?? [],
          loras: modelsData.loras ?? [],
          checkpointNames,
          checkpointBaseModels,
          loraNames,
          loraTriggerWords,
          loraBaseModels,
        });
      })
      .catch((err) => {
        setError(String(err));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshToken]);

  return { data, loading, error, refresh };
}
```

Key design notes:
- `refresh` has no dependencies. It captures nothing from props/state, so it's a stable reference.
- The effect lists `[refresh, refreshToken]`. Both are stable from React's perspective; ESLint passes without a disable.
- Auto-pick logic lives in the consumer, not the hook — see Task 2.
- The hook does not handle the legacy `/generations/` URL prefix or any other path translation; the existing `imgSrc()` helper handles that elsewhere.

## Task 2 — Refactor `ModelSelect.tsx` to use the hook

Replace the local `refreshLists` callback + all the `useState` for the seven derived fields (`models`, `checkpointNames`, `checkpointBaseModels`, `loraNames`, `loraTriggerWords`, `loraBaseModels`, `loading`) with:

```ts
import { useModelLists } from '@/lib/useModelLists';

const { data: lists, loading, error, refresh } = useModelLists(refreshToken);
```

Then everywhere the component reads `models.checkpoints`, switch to `lists.checkpoints`. Same for `models.loras` (→ `lists.loras`), `checkpointNames` / `checkpointBaseModels` / `loraNames` / `loraTriggerWords` / `loraBaseModels` (all on `lists`).

The `<ModelSheet onRefresh={refreshLists} ...>` call becomes `<ModelSheet onRefresh={refresh} ...>`.

The `if (error) return <p ...>` block stays, but reads `error` from the hook (now string-or-null instead of empty-string-or-string). Adjust the JSX condition accordingly: `if (error)` still works since both `null` and empty string are falsy.

### Handling auto-pick

Move the "if no checkpoint is selected, default to the first one" logic out of the fetch callback and into a separate effect that runs only when the data actually changes from empty to non-empty:

```ts
useEffect(() => {
  if (!checkpoint && lists.checkpoints.length > 0) {
    onCheckpointChange(lists.checkpoints[0]);
  }
}, [checkpoint, lists.checkpoints, onCheckpointChange]);
```

This way:
- Initial mount with no selection → picks the first checkpoint once.
- After a save bumps `refreshToken` → lists refetch, but `checkpoint` is now set, so the auto-pick is a no-op.
- If the user explicitly clears their selection (we don't currently support this), the next refresh would re-pick — same behavior as before.

ESLint will be satisfied with the listed deps. No `eslint-disable` should remain in this file.

## Task 3 — Refactor `ModelConfig.tsx` to use the hook

`ModelConfig.tsx`'s `refreshModelLists` is structurally identical to `ModelSelect`'s but uses different state shapes. Replace it with `useModelLists()` (no `refreshToken` argument — `ModelConfig` only refreshes via the explicit Refresh button or after a save/delete).

State to remove:
- `checkpoints`, `loras`, `loadingModels`, `ckptNames`, `loraNames` (the five locals that the hook now provides)

State derived from the hook (rename in the destructure to avoid wide search-and-replace):

```ts
const { data: lists, loading: loadingModels, refresh: refreshLists } = useModelLists();
const { checkpoints, loras, checkpointNames: ckptNames, loraNames } = lists;
```

That keeps the rest of the component readable with minimal renaming. The five-name local destructure is fine — it only re-runs when `lists` changes, which is rare.

The existing places that call `refreshModelLists()` (after delete, after IngestPanel completion, the Refresh button) all become calls to `refreshLists()`.

The auto-pick of `selectedCheckpoint` / `selectedLora` (`setSelectedCheckpoint((prev) => prev || modelData.checkpoints[0] || '')`) needs to move out of the fetch callback into separate effects, mirroring Task 2's pattern. There are two of them — one for checkpoint, one for LoRA:

```ts
useEffect(() => {
  if (!selectedCheckpoint && checkpoints.length > 0) {
    setSelectedCheckpoint(checkpoints[0]);
  }
}, [selectedCheckpoint, checkpoints]);

useEffect(() => {
  if (!selectedLora && loras.length > 0) {
    setSelectedLora(loras[0]);
  }
}, [selectedLora, loras]);
```

The standalone `refreshNames()` function (the one that fetches just the configs after a save) becomes redundant — instead of fetching just the configs, call `refreshLists()`. Slightly more network traffic (also re-fetches `/api/models`) but simpler and the cost is negligible at single-user scale. Delete `refreshNames` and update its two call sites in `saveCheckpoint` and `saveLora` to call `refreshLists()` instead.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -rn "eslint-disable.*react-hooks/exhaustive-deps" src/components/ModelSelect.tsx` returns nothing.
- `src/lib/useModelLists.ts` exists and exports `useModelLists`.
- `ModelSelect.tsx` and `ModelConfig.tsx` both consume the hook — no duplicated `Promise.all([fetch('/api/models'), fetch('/api/checkpoint-config'), fetch('/api/lora-config')])` blocks remain in either file.
- `npm run lint` passes without new warnings (or matches the existing baseline).

Manual smoke test (deferred to user):
1. Open Studio → Settings drawer. Checkpoint dropdown populates correctly. (Note: this batch does NOT fix the still-deferred dropdown-loading bug — if dropdowns are empty, that's a separate API/tunnel issue.)
2. Open Models tab. Same lists, same friendly names.
3. Save a checkpoint friendly-name change in the Models tab. Confirm the picker in Studio reflects the new name.
4. Tap the Refresh button in Studio's checkpoint picker sheet. Confirms a manual reload works.
5. Delete a model. List updates without a stale entry.

---

## Out of scope

- Don't fix the model-loading bug itself (the deferred `/api/models` issue). Empty dropdowns due to API/tunnel issues are a separate problem.
- Don't change `/api/models` or any backend route.
- Don't add SWR, react-query, or any other data-fetching library. Native fetch + custom hook only.
- Don't change `Studio.tsx`'s checkpoint-config fetch (the one that loads `defaultPositivePrompt` / `defaultNegativePrompt` when `p.checkpoint` changes) — that's per-checkpoint, not the list.
- Don't preemptively add an `embeddings` field to the hook for the queued embeddings feature. That batch will extend the hook when it lands.

---

## Documentation

In CLAUDE.md, the Source Layout entry for `lib/` should include a line for `useModelLists.ts`, slotted alphabetically:

```
useModelLists.ts    React hook: shared fetcher for /api/models + /api/checkpoint-config + /api/lora-config; consumed by ModelSelect and ModelConfig
```

The existing entries for `ModelSelect.tsx` and `ModelConfig.tsx` are still accurate — no changes there.

When done, push and create the PR via `gh pr create` per AGENTS.md.
