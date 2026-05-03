# Batch — Cascade delete on projects

The current project delete (Phase 2.1, refined by the Phase 2/3 cleanup bundle) drops member items to project-less state and leaves them in the gallery. Useful default. But sometimes the user wants to delete the entire project's contents — say, an experimental project that turned out to be a dead end, or a project of nudges-toward-a-final-cut where the intermediate items are just clutter once the final stitch exists.

This batch extends the project delete dialog with a choice between "keep items" (current behavior) and "delete everything" (cascade). The cascade variant deletes the source items, the stitched exports made from the project, and aborts any in-flight jobs related to the project before the deletion runs.

Re-read CLAUDE.md before starting. The Phase 2/3 cleanup bundle and the delete-confirm dialog batch must be merged before this batch runs.

Throughout this prompt, "items" means any `Generation` row member of a project — videos, images, and stitched exports. Future media types (text/stories planned for a future version) will fold into the same noun without language changes.

---

## What to build

### 1. Update the project delete dialog

The project delete already uses `<DeleteConfirmDialog>` from the delete-confirm batch. Extend the dialog's body to expose a radio choice **before** the type-to-confirm input:

```
What should happen to this project's items?

  ○  Keep items — they'll remain in the gallery without project association (default)
  ●  Delete everything — items, stitched exports, in-flight jobs all removed

[Type the project name to confirm]
[ Cancel ] [ Delete ]
```

The radio defaults to "Keep items" — preserves existing user expectations from the Phase 2.1 / cleanup-bundle behavior. The user has to explicitly pick the cascade variant.

When "Delete everything" is selected, the warning summary updates dynamically:

> This will permanently delete:
> - The project **[name]**
> - **N** items (videos, images)
> - **M** stitched exports made from this project
> - Any in-flight jobs related to the project will be aborted
>
> This cannot be undone.

The counts come from the project's existing `clipCount` (rename internally if convenient — the "items" framing is a UI choice and doesn't require schema renames) plus a new query for `Generation` rows where `parentProjectId === this.id` (the stitched exports per Phase 3's schema).

The type-to-confirm input rules from the delete-confirm batch are unchanged — exact match required, Delete button disabled until matched.

### 2. Pass the choice through to the API

`DELETE /api/projects/[id]` accepts a query parameter or request-body field indicating the cascade choice:

```
DELETE /api/projects/[id]?cascade=true
```

Query parameter is cleanest for a DELETE method (DELETE bodies are technically allowed but sketchy in practice). Default `cascade=false` if omitted — preserves backwards compatibility for any caller that hits the route without the new parameter.

Validate: `cascade` is `'true'` or `'false'` (string from query) or boolean if the agent finds a different parameterization cleaner. Invalid value → 400.

### 3. Implement the cascade deletion logic

In the route's DELETE handler, branch:

**`cascade=false`** (existing behavior, unchanged):

The Phase 2/3 cleanup bundle's transaction:

```ts
await prisma.$transaction([
  prisma.generation.updateMany({
    where: { projectId: params.id },
    data: { position: null, projectId: null },
  }),
  prisma.project.delete({ where: { id: params.id } }),
]);
```

(Note: the cleanup bundle clears `position`; the existing `onDelete: SetNull` handles `projectId` automatically. The explicit updateMany is defensive.)

**`cascade=true`** (new):

Run in this order, **outside** a single transaction (because file I/O and SSH calls aren't transactional):

1. **Abort in-flight jobs.** Query the active-jobs state in `comfyws.ts` for any job where `projectId === params.id`. For each, call the existing `abortJob(promptId)` path. This kills GPU work via `/interrupt` (per Phase 1.4 work) and cleans up VM-side files via the existing SSH cleanup. The abort path is fire-and-forget per its existing implementation; don't wait for ffmpeg or sampling to actually stop before proceeding.

   Stitch jobs in flight: the abort path for `mediaType === 'stitch'` was already wired in Phase 3 (sends `SIGTERM` to the ffmpeg child, removes the partial output). Same call works.

   If the abort hits a known race window (e.g. the stitch abort that the user flagged as occasionally not killing fast enough — see the "Known issues" section below), proceed with deletion anyway. Better to have a stranded ffmpeg/ComfyUI process for a few seconds than to block the user's deletion request.

2. **Find all items the cascade will touch.** Two queries:
   ```ts
   const sourceItems = await prisma.generation.findMany({
     where: { projectId: params.id },
     select: { id: true, localPath: true, mediaType: true },
   });
   const stitchedExports = await prisma.generation.findMany({
     where: { parentProjectId: params.id },
     select: { id: true, localPath: true, mediaType: true },
   });
   const allToDelete = [...sourceItems, ...stitchedExports];
   ```

3. **Delete files from disk.** For each item, unlink `localPath` from mint-pc's local storage. The existing `DELETE /api/generations/[id]` route has this logic — extract it into a shared helper `deleteItemFile(localPath: string)` if not already shared, and reuse here. Errors on individual file deletes log via `console.error` but don't abort the cascade — a missing file (already deleted out-of-band, etc.) shouldn't block the rest of the deletion.

   Don't try to handle file deletes transactionally with the DB delete. Filesystem and DB aren't going to be in sync at the millisecond level no matter what we do; the cleanup pattern is "delete files, then delete rows, accept brief inconsistency on errors." Same pattern Phase 1.3's regular item delete already uses.

4. **Delete the DB rows.** Single transaction:
   ```ts
   await prisma.$transaction([
     prisma.generation.deleteMany({
       where: {
         OR: [
           { projectId: params.id },
           { parentProjectId: params.id },
         ],
       },
     }),
     prisma.project.delete({ where: { id: params.id } }),
   ]);
   ```

   The `deleteMany` covers both source items and stitched exports. The project delete completes the cascade.

5. **Return.** Response shape: `{ ok: true, deletedItems: N, deletedStitches: M }` so the client can show a confirmation toast.

### 4. Client-side state cleanup after cascade

Per the cleanup bundle batch's pattern: deleting a project broadcasts a state-clearing event so the Studio pill, queue tray, and any sessionStorage references update. Cascade delete uses the same broadcast — no new mechanism needed.

The gallery's currently-displayed item list won't reflect the cascade-deleted items until refresh OR until the gallery's existing event-driven refresh mechanism fires. Verify which exists; if there's an event for "item deleted," fire it for each cascaded item. If there isn't (gallery just re-fetches on tab focus), the items will disappear on next gallery view. That's acceptable.

If the user is currently viewing the project detail view at the moment of cascade delete, navigate them away (to the projects listing or main gallery) before the broadcast — same as the existing non-cascade delete flow.

### 5. Known issue — stitch abort race window

The user has observed that aborting an in-flight stitch via the queue tray sometimes doesn't appear to actually abort the ffmpeg process. Likely cause: ffmpeg completes faster than the SIGTERM signal can land, so by the time the abort handler runs, ffmpeg has already exited normally and the resulting file lands in the output directory.

This is not a fix in scope for THIS batch. But it's relevant because cascade delete uses the abort path for in-flight stitches. If the race hits during cascade:

- ffmpeg finishes naturally before the SIGTERM lands.
- The stitched output file is created and a `Generation` row may be inserted.
- The cascade's `prisma.generation.deleteMany({ where: { OR: [{projectId}, {parentProjectId}] } })` runs *after* the abort attempt, so it should pick up any newly-created row.
- But the file on disk: depending on timing, may not be in the `allToDelete` query result captured at step 2 above.

The mitigation for this batch: **after the deleteMany, run one more sweep for any orphaned files**. Add a `console.warn` and a second pass:

```ts
const stragglers = await prisma.generation.findMany({
  where: { OR: [{ projectId: params.id }, { parentProjectId: params.id }] },
});
if (stragglers.length > 0) {
  console.warn(`[cascade-delete] ${stragglers.length} stragglers appeared after deleteMany — race window`);
  // Best-effort second pass
  for (const item of stragglers) await deleteItemFile(item.localPath).catch(() => {});
  await prisma.generation.deleteMany({ where: { id: { in: stragglers.map(s => s.id) } } });
}
```

This is belt-and-suspenders against the abort race. It almost never fires; when it does, it cleans up the straggler quietly.

The proper fix for the abort race lives in a separate future batch — investigate whether the abort path needs to wait for a SIGTERM ack before declaring success, or whether ComfyUI's queue API for stitch jobs needs different handling. Out of scope here.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- The project delete dialog shows a radio choice between "Keep items" (default) and "Delete everything."
- The dialog warning text updates dynamically based on radio selection.
- `DELETE /api/projects/[id]?cascade=true` deletes source items, stitched exports, and the project.
- `DELETE /api/projects/[id]` (no cascade param) preserves existing keep-items behavior.
- In-flight jobs related to the project are aborted via the existing `abortJob` path before deletion runs.
- File deletion errors on individual items log but don't abort the cascade.
- The straggler sweep runs after the main deleteMany and logs if it finds anything.
- The response shape includes counts for deleted items and deleted stitches.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. Create a project, generate 2 videos, 1 image (assign post-hoc per Phase 2.3), and 1 stitched export. Confirm gallery shows 4 items, project detail view shows 3 source items + 1 stitch.
2. Delete the project with "Keep items" selected. Confirm: project gone from listing, all 4 items still in the gallery (project-less). The stitched export's sidebar shows "Project: None (project deleted)."
3. Reset: create another similar project + items. Delete with "Delete everything" selected. Type project name to confirm. Confirm: project gone, all 4 items gone from the gallery, files gone from disk (verify with `ls` on the storage directory).
4. Repeat step 3 but with a generation in-flight at the moment of deletion. Confirm: the in-flight job is aborted (queue tray entry transitions to error/aborted), GPU drops, deletion completes.
5. Repeat step 3 with a stitch in-flight. Try to time the abort with a stitch that's about to complete. If the straggler sweep fires, confirm the warning log appears and the file is still cleaned up.
6. Try cascade delete on a project with no items at all (just an empty project). Confirm: clean delete, no errors.
7. Try cascade delete via curl with `cascade=true` and verify the response includes `{ ok: true, deletedItems: N, deletedStitches: M }`.

---

## Out of scope

- Fixing the stitch abort race window. Separate future batch.
- A "soft delete" with a recoverable trash. The type-to-confirm dialog is the protection layer.
- Cascade delete from the gallery side (delete an item AND all related items). Out of scope; one direction is enough.
- Selective cascade ("delete the source items but keep the stitched exports" or vice versa). The cascade is all-or-nothing per item type.
- Bulk project delete with cascade. Out of scope.
- A "what would be deleted" preview screen showing the actual items. The count summary in the dialog is sufficient.
- Audit log / history of cascade deletions. Out of scope.
- Auto-cascade if the project has been untouched for N days. Out of scope.
- A confirmation step beyond type-to-confirm (e.g. type "DELETE EVERYTHING"). The radio choice IS the second confirmation.

---

## Documentation

In CLAUDE.md, find the project deletion paragraph (added/updated by the cleanup bundle batch). Append:

> The delete dialog offers a cascade option: "Delete everything" removes source items, stitched exports made from the project, and aborts any in-flight related jobs before deletion. Default is the keep-items behavior — items drop to project-less state. The cascade path is non-transactional across filesystem and DB; individual file-delete errors log but don't abort the run, and a straggler sweep handles the abort-race edge case where a stitch ffmpeg completes between the abort signal and the main deleteMany.

Find the API routes table and update `DELETE /api/projects/[id]` to mention the optional `cascade=true` query parameter and the new response shape.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
