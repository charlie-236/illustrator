# Batch — Unify `dirForItem` with `dirForGeneration` (M3 cleanup)

After the stitch-source-clip-dir fix took Path A and extracted `dirForGeneration` into `src/lib/outputDirs.ts`, two callers use the shared helper (extract-last-frame and stitch). A third near-duplicate remains: `dirForItem` in `src/app/api/projects/[id]/route.ts`, used by `deleteItemFile` for cascade deletes. Same purpose; subtly different shape.

This batch deletes the duplicate and points its caller at the shared helper. **No behavior change** — purely consolidation. The unification preserves the more defensive of the two implementations' edge-case behavior on null/unknown `mediaType`.

Re-read CLAUDE.md before starting. Disk-avoidance contract is unaffected.

---

## What the two helpers look like today

**`src/lib/outputDirs.ts` — `dirForGeneration` (canonical):**

```ts
export function dirForGeneration(g: { mediaType: string; isStitched: boolean }): string {
  if (g.mediaType === 'image') return process.env.IMAGE_OUTPUT_DIR ?? '';
  if (g.isStitched) return process.env.STITCH_OUTPUT_DIR ?? process.env.VIDEO_OUTPUT_DIR ?? process.env.IMAGE_OUTPUT_DIR ?? '';
  return process.env.VIDEO_OUTPUT_DIR ?? process.env.IMAGE_OUTPUT_DIR ?? '';
}
```

**`src/app/api/projects/[id]/route.ts` — `dirForItem` (sibling):**

```ts
function dirForItem(item: { mediaType?: string | null; isStitched?: boolean }): string {
  if (!item.mediaType || item.mediaType !== 'video') return process.env.IMAGE_OUTPUT_DIR ?? '';
  if (item.isStitched) return process.env.STITCH_OUTPUT_DIR ?? process.env.VIDEO_OUTPUT_DIR ?? process.env.IMAGE_OUTPUT_DIR ?? '';
  return process.env.VIDEO_OUTPUT_DIR ?? process.env.IMAGE_OUTPUT_DIR ?? '';
}
```

Two real differences:

1. **Input typing.** `dirForItem` accepts `mediaType?: string | null` and `isStitched?: boolean`. `dirForGeneration` requires both as concrete types.
2. **Default branch.** `dirForItem` falls into the image branch for *any* non-video mediaType (including null, undefined, 'image', and any future type like 'audio'). `dirForGeneration` only treats explicit `'image'` as image; anything else falls through to the video branches.

`dirForItem`'s defensive default is the better behavior. If a future `mediaType` is added (the project model is broadening — Phase 5 storyboards, future stories) and a row is encountered before the helper is updated, falling into IMAGE_OUTPUT_DIR is a safer guess than picking VIDEO/STITCH.

The fact that the two callers of today's `dirForGeneration` (extract-last-frame and stitch) only ever pass `mediaType === 'video'` rows means the behavior change is invisible to them. We can absorb `dirForItem`'s shape into `dirForGeneration` without touching the existing callers' semantics.

---

## Required changes

### 1. Update `src/lib/outputDirs.ts` — widen signature, defensive default

Replace the body with `dirForItem`'s logic; rename parameter for clarity. Keep the exported name `dirForGeneration`.

```ts
/**
 * Resolve the output directory for a generation row based on its media type.
 *
 * Image rows live in IMAGE_OUTPUT_DIR.
 * Stitched video rows live in STITCH_OUTPUT_DIR.
 * Source video clips live in VIDEO_OUTPUT_DIR.
 *
 * Any non-video mediaType (including null, undefined, 'image', or future types)
 * falls into IMAGE_OUTPUT_DIR — defensive default for unknown types.
 *
 * Each non-image branch falls back through the other env vars so the helper
 * degrades gracefully when output dirs aren't split (all three pointing at the
 * same path is a valid configuration).
 */
export function dirForGeneration(g: {
  mediaType?: string | null;
  isStitched?: boolean | null;
}): string {
  if (g.mediaType !== 'video') return process.env.IMAGE_OUTPUT_DIR ?? '';
  if (g.isStitched) return process.env.STITCH_OUTPUT_DIR ?? process.env.VIDEO_OUTPUT_DIR ?? process.env.IMAGE_OUTPUT_DIR ?? '';
  return process.env.VIDEO_OUTPUT_DIR ?? process.env.IMAGE_OUTPUT_DIR ?? '';
}
```

The signature widens (both fields optional/nullable). Existing callers (extract-last-frame, stitch) pass concrete `{ mediaType: string; isStitched: boolean }` shapes — TypeScript accepts these against the wider signature with no changes needed at call sites.

### 2. Delete `dirForItem` from `src/app/api/projects/[id]/route.ts`

Remove the local helper. Add an import at the top:

```ts
import { dirForGeneration } from '@/lib/outputDirs';
```

Update `deleteItemFile` to call `dirForGeneration` instead of `dirForItem`. The function call signature is identical at the use site — `dirForItem(item)` becomes `dirForGeneration(item)`.

`deleteItemFile`'s body is unchanged otherwise. The item shape it receives (`{ filePath, mediaType, isStitched }` from `select` clauses) matches the widened helper signature.

### 3. No other changes

- Don't touch `extract-last-frame/route.ts` or `stitch/route.ts` — both already import `dirForGeneration` from the canonical location.
- Don't touch the `Generation`-row select clauses anywhere. They already include `mediaType` and `isStitched` where needed.
- Don't change the env var fallback chain. The existing `??` cascade is correct.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -rn "dirForItem" src/` returns nothing — the helper is fully removed.
- `grep -rn "dirForGeneration" src/` shows the export in `src/lib/outputDirs.ts` and imports in `extract-last-frame/route.ts`, `projects/[id]/stitch/route.ts`, and `projects/[id]/route.ts`.
- `grep -n "function dirForItem" src/app/api/projects/\[id\]/route.ts` returns nothing.
- `grep -n "from '@/lib/outputDirs'" src/app/api/projects/\[id\]/route.ts` returns one match (the new import).
- The widened `dirForGeneration` signature in `src/lib/outputDirs.ts` accepts `mediaType?: string | null` and `isStitched?: boolean | null`.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. **Cascade-delete a project with mixed media.** Create a project, generate 1 image, 2 video clips, 1 stitched output. Confirm strip shows 4 items. Cascade-delete with "Delete everything" selected, type project name, confirm. Verify:
   - Image file removed from `IMAGE_OUTPUT_DIR`.
   - Video .webm files removed from `VIDEO_OUTPUT_DIR`.
   - Stitched .mp4 removed from `STITCH_OUTPUT_DIR`.
   - DB rows gone (Prisma Studio or `psql`).
2. **Cascade-delete with co-located output dirs** (regression check for users who haven't split): point `IMAGE_OUTPUT_DIR`, `VIDEO_OUTPUT_DIR`, `STITCH_OUTPUT_DIR` at the same path. Repeat step 1. Confirm cascade-delete still cleans every file.
3. **Stitch a project** (regression check for the existing dirForGeneration callers). Confirm no regression — source clips resolve correctly, output mp4 lands in STITCH_OUTPUT_DIR.
4. **Extract last frame** from a project's latest video clip (the i2v starting frame picker). Confirm no regression.
5. **Cascade-delete a project containing a row with null mediaType** (rare/synthetic case): if you can construct one via `psql` direct UPDATE, do so and confirm the cascade still runs without error and routes the file lookup to IMAGE_OUTPUT_DIR. If you can't easily construct this, skip — the test exercises the defensive default that's mostly future-proofing.

---

## Out of scope

- Changing `extract-last-frame/route.ts` or `stitch/route.ts` callers. They consume the wider signature with no edits.
- Changing the env var fallback chain.
- Renaming `dirForGeneration`. Established name; established import.
- Adding new mediaType handling for future types (audio, text, etc.). Defensive default routes to IMAGE_OUTPUT_DIR; explicit handling can be added when those types ship.
- Touching the `Generation` schema or `mediaType` column type.
- Refactoring `deleteItemFile` itself. Only its `dirForItem(...)` call changes to `dirForGeneration(...)`.
- Refactoring how cascade delete decides what to query. The two `findMany` calls stay as they are.

---

## Documentation

In CLAUDE.md, find the `dirForGeneration` reference (added in the stitch-source-clip-dir batch's documentation update). Update its description to note:

> The shared helper lives in `src/lib/outputDirs.ts` and is used by `extract-last-frame/route.ts`, `projects/[id]/stitch/route.ts`, and `projects/[id]/route.ts` (cascade delete). Non-video mediaTypes (including null/undefined and future types) route to `IMAGE_OUTPUT_DIR` as a defensive default.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
