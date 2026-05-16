# Batch — Fix project stitching reading source clips from STITCH_OUTPUT_DIR

Project stitching fails immediately with `ffprobe failed (code 1):` (empty stderr). The pending stitched `Generation` row is created and then deleted; the SSE stream returns 200 with an `error` event. Cause: `src/app/api/projects/[id]/stitch/route.ts` uses `STITCH_OUTPUT_DIR` for both the output mp4 path **and** the source clip paths. Source clips are `.webm` files written by `/api/generate-video` to `VIDEO_OUTPUT_DIR` — when the user has split env vars per the env-refactor batch, the source paths point at the wrong directory and ffprobe gets non-existent files.

This is a regression introduced by the env-refactor batch (`tasks/env-refactor.md`, PR #41). That prompt instructed the agent to swap the route's single `outputDir` from `IMAGE_OUTPUT_DIR` to `STITCH_OUTPUT_DIR` but didn't flag that the route reads source clips as well as writing output — the source side needs `VIDEO_OUTPUT_DIR` (or `STITCH_OUTPUT_DIR` for the unusual case of a stitched output added to a project as a clip and re-stitched).

`src/app/api/extract-last-frame/route.ts` already has the right pattern via a `dirForGeneration({ mediaType, isStitched })` helper. Mirror it.

Re-read CLAUDE.md before starting. Use `project_knowledge_search` to confirm the helper's exact signature and fallback chain.

---

## Required changes

### 1. `src/app/api/projects/[id]/stitch/route.ts` — resolve each source clip's directory per-row

Two specific changes inside the POST handler.

**(a) Extend the Prisma select on `allVideoClips`** to include the fields `dirForGeneration` consumes:

```ts
// BEFORE
const allVideoClips = await prisma.generation.findMany({
  where: { projectId, mediaType: 'video' },
  orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  select: { id: true, filePath: true },
});

// AFTER
const allVideoClips = await prisma.generation.findMany({
  where: { projectId, mediaType: 'video' },
  orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  select: { id: true, filePath: true, mediaType: true, isStitched: true },
});
```

The `clips` typing further down (`{ id: string; filePath: string }[]`) needs widening to include the new fields. Either inline the shape or extract a type alias — agent's call.

**(b) Replace the `clipPaths` build** to resolve each clip's directory via `dirForGeneration`:

```ts
// BEFORE
const clipPaths = clips.map((c) => {
  const filename = c.filePath.replace('/api/images/', '').replace('/generations/', '');
  return path.join(outputDir, filename);
});

// AFTER
const clipPaths = clips.map((c) => {
  const filename = c.filePath.replace('/api/images/', '').replace('/generations/', '');
  const clipDir = dirForGeneration(c);
  if (!clipDir) {
    throw new Error(`Source clip directory env var not configured for clip ${c.id}`);
  }
  return path.join(clipDir, filename);
});
```

The throw inside `.map()` propagates up to the route's outer scope; the existing route doesn't try/catch around this section, so the error becomes a 500. That's the right behavior — fail-closed when source env vars are missing. If the agent prefers an explicit pre-check before the map, that's also fine; substance is what matters.

**The output path stays at `STITCH_OUTPUT_DIR`.** Don't change this:

```ts
const outputPath = path.join(outputDir, filename);  // stays — output goes to STITCH_OUTPUT_DIR
```

The top-of-handler `STITCH_OUTPUT_DIR` env check stays as-is. Only the clip-source side changes.

### 2. Add the `dirForGeneration` helper

Two acceptable paths — agent picks based on what fits cleanly:

**Path A (preferred): extract to a shared lib.** Create `src/lib/outputDirs.ts` exporting:

```ts
/**
 * Resolve the output directory for a generation row based on its media type.
 *
 * Image rows live in IMAGE_OUTPUT_DIR.
 * Stitched video rows live in STITCH_OUTPUT_DIR.
 * Source video clips live in VIDEO_OUTPUT_DIR.
 *
 * Each branch falls back through the other env vars so the helper degrades
 * gracefully when a user hasn't split their output dirs (all three pointing
 * at the same path is a valid configuration).
 */
export function dirForGeneration(g: { mediaType: string; isStitched: boolean }): string {
  if (g.mediaType === 'image') return process.env.IMAGE_OUTPUT_DIR ?? '';
  if (g.isStitched) return process.env.STITCH_OUTPUT_DIR ?? process.env.VIDEO_OUTPUT_DIR ?? process.env.IMAGE_OUTPUT_DIR ?? '';
  return process.env.VIDEO_OUTPUT_DIR ?? process.env.IMAGE_OUTPUT_DIR ?? '';
}
```

Update `src/app/api/extract-last-frame/route.ts` to import the shared helper instead of defining its own copy. The existing helper there has the same signature; the swap should be drop-in.

`src/app/api/projects/[id]/route.ts` has a sibling helper called `dirForItem` with a slightly different signature (takes a nullable `mediaType` and treats non-video as image). Don't change that one in this batch — it has its own tested shape and changing it expands scope. Note in the PR description that `dirForItem` is a known duplicate that could be unified later.

**Path B (if Path A feels like scope expansion): inline the helper at the top of the stitch route.** Copy the function verbatim from `extract-last-frame/route.ts`. Don't touch any other file. Note in the PR description that there are now three near-duplicates of this helper in the codebase.

Either path is fine. The bug fix is the priority; the de-duplication is a nice-to-have.

### 3. No other route or helper changes

Don't touch `src/lib/stitch.ts` — `stitchProject()` receives `clipPaths` as fully-resolved absolute paths and doesn't care which directory they came from.

Don't touch `/api/generate-video`. Don't touch `/api/extract-last-frame`'s logic (only the import line if Path A).

Don't touch the schema. The `mediaType` and `isStitched` columns already exist and are populated correctly on every row.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "dirForGeneration" src/app/api/projects/\[id\]/stitch/route.ts` returns at least one match (the per-clip resolution call).
- `grep -n "select: { id: true, filePath: true, mediaType: true, isStitched: true }" src/app/api/projects/\[id\]/stitch/route.ts` returns one match (the extended `allVideoClips` query).
- `grep -n "path.join(outputDir, filename)" src/app/api/projects/\[id\]/stitch/route.ts` returns **exactly one** match — the output path. The previous (buggy) per-clip use is gone.
- For Path A: `grep -rn "dirForGeneration" src/` shows the export in `src/lib/outputDirs.ts` and imports in both stitch and extract-last-frame routes; the inline copy in `extract-last-frame/route.ts` is gone.
- For Path B: `grep -rn "dirForGeneration" src/` shows two top-level definitions (extract-last-frame and stitch) — note this in the PR description.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — Charlie):

1. **Split-paths configuration** (the regression case): with `.env` setting `VIDEO_OUTPUT_DIR` and `STITCH_OUTPUT_DIR` to different absolute paths, open a project with at least 2 video clips, click Stitch, hit Confirm. Confirm: SSE progresses through `init` → `progress` → `complete`; the resulting `.mp4` lands in `STITCH_OUTPUT_DIR`; the gallery shows the stitched output with the **Stitched** badge; tapping it plays the video. No `ffprobe failed` errors in the PM2 logs.
2. **Same-path configuration** (regression check for users who haven't split): set `VIDEO_OUTPUT_DIR` and `STITCH_OUTPUT_DIR` to the same path. Repeat the stitch from step 1. Confirm it still succeeds. (This is the "graceful degradation" check — the helper's fallback chain should make co-located paths work fine.)
3. **Stitch a project containing one stitched output as a member clip** (rare but legal): take a project, stitch its videos, then drag the resulting stitched output into another project as a regular clip. Stitch that second project. Confirm the clip resolves from `STITCH_OUTPUT_DIR` (not `VIDEO_OUTPUT_DIR`) and the stitch-of-stitch succeeds.
4. **No regression in extract-last-frame**: open a project with a video clip and click "Choose starting frame." Confirm last-frame previews extract correctly. (If Path A was taken, this verifies the shared-import didn't break the existing route. If Path B was taken, this is just a sanity check.)
5. **Cascade-delete still works**: cascade-delete a project that has both videos and a stitched output. Confirm both files are removed from disk in their respective directories. (This exercises `dirForItem` in `projects/[id]/route.ts` — unchanged in this batch but worth confirming nothing collateral broke.)

---

## Out of scope

- Don't change `dirForGeneration` semantics. The existing shape (with the `??` fallback chain) is correct and battle-tested in extract-last-frame.
- Don't modify `extract-last-frame` beyond the import line if Path A is taken. Its logic is correct.
- Don't modify `/api/generate-video` or its seed-zero-related logic. Separate batch.
- Don't unify `dirForItem` (in `projects/[id]/route.ts`) with `dirForGeneration`. It has a slightly different signature and its own callers; the unification is a separate cleanup batch.
- Don't add migration logic to move existing files between directories. Users with split env vars who have pre-split files keep them where they are; the helper resolves new files correctly going forward.
- Don't change the schema. `mediaType` and `isStitched` columns are already populated.

---

## Documentation

In CLAUDE.md, find the **`POST /api/projects/[id]/stitch`** subsection. Add a sentence (or short paragraph) noting the directory resolution:

> The route reads each source clip from its media-type-appropriate directory via `dirForGeneration` (image → `IMAGE_OUTPUT_DIR`; stitched → `STITCH_OUTPUT_DIR`; otherwise `VIDEO_OUTPUT_DIR`), with `??` fallbacks across the three env vars so co-located output directories degrade gracefully. The output `.mp4` always writes to `STITCH_OUTPUT_DIR`.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
