# Batch — Fix StitchModal complete-event handler shape

PR #51 (sse-complete-event-parity) updated the stitch route's SSE `complete` event from a flat shape (`{ id, filePath, frames, fps, ... }`) to the parity shape (`{ records: GenerationRecord[] }`), and updated Studio's video consumer correctly. It missed one consumer: `StitchModal.handleStitch` in `src/components/ProjectDetail.tsx`.

The stale handler still parses `data` as the old flat shape into `result.id`, `result.filePath`, etc. With the new payload those top-level fields don't exist, so every field is `undefined`. The optimistic `onStitched(...)` prepend produces a `ProjectStitchedExport` with undefined id and filePath, and `imgSrc(undefined)` throws when the strip re-renders. Server, DB, and disk are all fine — refreshing the page recovers correct state from the gallery API.

Fix: update `StitchModal.handleStitch`'s `complete` branch to parse the records array and pull fields from the record. No server-side changes (the route already emits the right shape).

Re-read CLAUDE.md before starting.

---

## Required changes

### `src/components/ProjectDetail.tsx` — `StitchModal.handleStitch` complete branch

Find the SSE event-loop `else if (eventName === 'complete')` branch. Today it looks roughly like:

```ts
} else if (eventName === 'complete') {
  const result = JSON.parse(data) as {
    id: string;
    filePath: string;
    frames: number;
    fps: number;
    width?: number;
    height?: number;
    createdAt: string;
  };
  if (promptId && generationId) completeJob(promptId, generationId);
  setStatus('done');
  onStitched({
    id: result.id,
    filePath: result.filePath,
    frames: result.frames,
    fps: result.fps,
    width: result.width ?? 0,
    height: result.height ?? 0,
    createdAt: result.createdAt,
    promptPos: `Stitched: ${projectName}`,
  });
}
```

Replace the parsing and field reads with the new shape:

```ts
} else if (eventName === 'complete') {
  const parsed = JSON.parse(data) as { records: GenerationRecord[] };
  const record = parsed.records[0];
  if (!record) {
    setStatus('error');
    setErrorMsg('Stitch completed but no record returned');
    return;
  }
  if (promptId && generationId) completeJob(promptId, generationId);
  setStatus('done');
  onStitched({
    id: record.id,
    filePath: record.filePath,
    frames: record.frames ?? 0,
    fps: record.fps ?? 0,
    width: record.width,
    height: record.height,
    createdAt: record.createdAt,
    promptPos: record.promptPos,
  });
}
```

Notes:

- `record.promptPos` is already populated by the server with the "Stitched: <projectName>" string — no need to re-construct from `projectName`. (Verify via `project_knowledge_search` for `promptPos` in the stitch route's `prisma.generation.create({...})` call. If the server stores it differently, fall back to the existing `\`Stitched: ${projectName}\`` template — but prefer the record's value if it matches.)
- `record.frames` and `record.fps` are typed as `number | null` in `GenerationRecord` (because images have null). Stitched outputs always have non-null values, but the `?? 0` defensive coalesce matches the existing pattern in this handler and avoids a type complaint.
- `record.width` and `record.height` are non-null `number` on `GenerationRecord` — drop the `?? 0` defaults since they're not optional. `ProjectStitchedExport`'s width/height fields require numbers, not nullable.
- `GenerationRecord` import: confirm it's already imported at the top of the file. If not, add `import type { GenerationRecord } from '@/types';` to the existing imports block (or extend the existing types import line).

### Verify the existing pre-fix behavior of this branch is the only consumer to update

`grep -rn "eventName === 'complete'" src/components/` — confirm only ProjectDetail.tsx and Studio.tsx have stitch/video complete consumers, and Studio.tsx was already updated by PR #51. ProjectDetail.tsx's StitchModal is the only stale one.

### No server-side changes

`src/app/api/projects/[id]/stitch/route.ts` and `src/lib/comfyws.ts`'s `finalizeStitchSuccess` already emit `{ records: [record] }` per PR #51. Don't touch them. The cosmetic typing complaint about `finalizeStitchSuccess`'s `record: Record<string, unknown>` parameter is intentionally out of scope here — it's a separate (cosmetic) batch.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "records: GenerationRecord\[\]" src/components/ProjectDetail.tsx` returns at least one match (the new parsing in `StitchModal.handleStitch`).
- `grep -n "result.filePath\|result.frames\|result.fps" src/components/ProjectDetail.tsx` returns nothing — the old flat-shape reads are gone.
- The stitch route and `comfyws.ts`'s stitch finalize are unchanged from their current state — `git diff origin/main src/app/api/projects/\[id\]/stitch/route.ts src/lib/comfyws.ts` should show no changes from this batch.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. Open a project with at least 2 video clips. Stitch. Confirm SSE progresses through `init` → `progress` → `complete` with no client-side errors in the browser console. The stitched output appears in the project's stitched-exports strip immediately (no refresh needed).
2. Tap the new stitched tile. Modal opens, video plays. No `imgSrc(undefined)` error in the console.
3. Refresh the page. Confirm the same stitched output is still present and renders correctly. (Pre-fix behavior was: optimistic prepend was broken, but refresh recovered correct state. Post-fix: optimistic prepend is also correct.)
4. Stitch again, this time with a project that has only 2 clips (minimum). Confirm the modal closes cleanly post-stitch and the new export shows up.
5. Open the browser network panel during a stitch and confirm the SSE `complete` event payload is `{"records":[{...full record fields...}]}` — confirms the route side is unchanged.

---

## Out of scope

- Tightening `finalizeStitchSuccess`'s `record: Record<string, unknown>` signature in `src/lib/comfyws.ts`. Cosmetic; separate batch.
- Refactoring StitchModal's overall SSE loop structure. Only the `complete` branch changes.
- Updating other SSE consumers in ProjectDetail.tsx if any exist (none do, per the audit). Stitch is the only generation flow this component consumes.
- Removing `width`/`height` defaults from `ProjectStitchedExport`. The shape stays.
- Adding a "stitched" badge or UX polish. Just the bug fix.

---

## Documentation

No CLAUDE.md changes — the documented shape (in the table for `/api/projects/[id]/stitch`'s SSE events) already says `complete` is `{ records: GenerationRecord[] }`. The bug was the client-side handler not catching up, not a doc gap.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
