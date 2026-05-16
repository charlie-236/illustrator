# Batch — Image generations inherit project context

When the user has a project active in Studio and generates an image, the image is currently created as a project-less row. Clip generations correctly inherit the project (with `projectId` set and `position` auto-computed); the image path is missing the equivalent plumbing at three layers — type, route validation, and finalize-time DB write.

This is a Phase 2 oversight: when projects launched, the work focused on video clips because the project's primary purpose is stitching. The image-into-project case wasn't tested. The fix mirrors the existing video-side pattern in the image path.

Re-read CLAUDE.md before starting. Use `project_knowledge_search` to confirm the video-side pattern before mirroring it — `finalizeVideoJob` in `src/lib/comfyws.ts` is the reference implementation.

---

## Three layers to fix

### Layer 1: `GenerationParams` type

In `src/types/index.ts`, the `GenerationParams` interface lacks `projectId`. Add it as an optional field:

```ts
export interface GenerationParams {
  // ... existing fields ...
  projectId?: string;
}
```

Mirror the video side: `VideoJobParams` has `projectId?: string` for the same purpose.

### Layer 2: `/api/generate` route

In `src/app/api/generate/route.ts`, add validation for `projectId` alongside the existing parameter checks:

```ts
if (params.projectId !== undefined && params.projectId !== null) {
  if (typeof params.projectId !== 'string' || params.projectId.length === 0) {
    return bad('projectId must be a non-empty string when provided');
  }
  // Verify the project actually exists — same check the video route does
  const project = await prisma.project.findUnique({ where: { id: params.projectId } });
  if (!project) {
    return bad('projectId does not reference an existing project');
  }
}
```

Mirror the video route's validation. Look at `/api/generate-video`'s `projectId` handling (it returns 400 on a missing project) and match.

The route already passes `params` through `manager.stashJobParams(...)` after stripping `referenceImages`/`mask`. The `projectId` field flows through that path naturally — no special handling needed at stash time.

Verify: `stashJobParams` doesn't strip `projectId` from the rest spread. It currently strips `baseImage` and `denoise`. Leave `projectId` intact.

### Layer 3: `finalizeImageJob` in `src/lib/comfyws.ts`

In `finalizeImageJob`, after the `imageBuffers` length check and before the `Promise.all` over records, add the position computation that mirrors `finalizeVideoJob`:

```ts
let position: number | undefined;
if (params.projectId) {
  const maxResult = await prisma.generation.aggregate({
    where: { projectId: params.projectId },
    _max: { position: true },
  });
  position = (maxResult._max.position ?? 0) + 1;
}
```

Then in the `prisma.generation.create()` call inside the `imageBuffers.map(...)`, add `projectId` and `position` to the `data` object:

```ts
const record = await prisma.generation.create({
  data: {
    filePath,
    promptPos: params.positivePrompt,
    // ... all existing fields ...
    mediaType: 'image',
    projectId: params.projectId,
    position: params.projectId ? position : null,
  },
});
```

Mirror `finalizeVideoJob`'s pattern exactly — same conditional, same null fallback when no project.

### Sequencing concern with `image-batch-independence`

The `image-batch-independence` batch (which slots in before this) changes image generation to N independent jobs. With this fix and that batch combined: a 4-take image batch with project context active produces 4 rows, each with `projectId` set, each with sequential `position` values (`max + 1`, `max + 2`, etc.).

The position-allocation logic in this fix uses `max + 1` per take, which works correctly across N independent finalizations *as long as they finalize sequentially*. ComfyUI processes prompts one at a time, so finalization is also sequential — each take's `aggregate` query sees the previous take's row already committed. No race.

If somehow two image takes finalize simultaneously (different ComfyUI server, parallel GPU work — not currently a config), both would compute the same `max + 1` and collide. Same race exists today on the video side; not making it worse. Out of scope to fix racing finalizations; document if encountered.

### What about Studio's submit code?

`Studio.tsx` already has access to the active project context (the `Project: ...` pill at the top of Studio reflects `activeProjectId` or similar context state). Currently the image submit path doesn't pass it through to `/api/generate`.

Find the image-mode `handleGenerate` function in Studio. Where the request body is assembled (`generateParams` object), add `projectId`:

```ts
const generateParams = {
  ...basePayload,
  projectId: activeProjectId ?? undefined,  // pass through if project is active
};
```

Use whatever variable name Studio uses for the active project. `project_knowledge_search` for "activeProjectId" or "activeProject" to find it. The video path already does this for its own POST body.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `GenerationParams` type has `projectId?: string`.
- `/api/generate` validates `projectId` (existence in DB, type, non-empty).
- `finalizeImageJob` reads `params.projectId` and computes `position` when a project is active.
- New image rows created during a project-active session have `projectId` and `position` set in the DB.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. Open Studio. Activate a project (the pill shows "Project: Tester" or whatever name). Generate an image.
2. Check the project detail view. The new image appears as the latest tile in the project's strip.
3. Open the image in the gallery modal. Verify the project association is shown (sidebar or wherever project membership is surfaced).
4. Generate an image with no project active. Confirm it lands in the gallery as a project-less row (no regression).
5. Switch projects mid-Studio session, generate again. Confirm the new image lands in the *currently-active* project, not the previous one.
6. Generate batch=4 (after `image-batch-independence` lands) with project active. Confirm all 4 images appear in the project with sequential `position` values.
7. Use the existing "assign retroactively to project" UX (per Phase 2.3) on a pre-existing project-less image. Confirm that path still works (this batch doesn't touch the retroactive-assign route).

---

## Out of scope

- Backfilling existing project-less images to projects. The user can use the retroactive-assign UX on individual images if they want them in a project.
- A "default project" setting at the user level. Activate-then-generate is the model; this batch just makes that work for images.
- Changing the project-detail strip to highlight "newly added" items. The strip already updates on project changes; the new images appear in the right place automatically.
- Schema changes. The existing `Generation` schema has `projectId` and `position` columns; they were just never populated by the image path.
- The position-uniqueness race condition under hypothetical parallel GPU configs. Single-GPU sequential finalization makes this a non-issue today.
- Studio UI changes to indicate "this generation will join the active project." The pill at the top of Studio is sufficient context.

---

## Documentation

In CLAUDE.md, find the section describing project clips and project membership. Update to clarify that **both images and clips inherit the active project** at generation time:

> When a project is active in Studio, both image and video generations are created with `projectId` set on the resulting `Generation` row, and `position` is auto-computed as `max(existing positions in this project) + 1`. The project's linear strip shows images and clips in `position` order, mixed together. Clips can also be retroactively assigned to a project after generation; images can be assigned the same way (per Phase 2.3).

Find the API routes section. Update `POST /api/generate` to mention the optional `projectId` parameter, mirroring the existing description for `POST /api/generate-video`.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
