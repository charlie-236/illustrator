# Batch — Phase 2/3 cleanup bundle

Three small defects discovered during smoke testing of merged Phase 2.1, 2.2, and 3 work. All independent, all small, bundled into one PR for review economy.

Re-read CLAUDE.md before starting. Phases 2.1, 2.2, 3, and the per-checkpoint defaults batch (PR #26) must be merged before this batch runs.

---

## Fix 1: Dangling position values on orphaned clips

**Defect.** Phase 2.1's project DELETE route relies on Prisma's `onDelete: SetNull` to clear `projectId` on clips that belong to the deleted project. That mechanism only nulls `projectId` — it leaves `position` set. Result: clips that "drop back to project-less state" carry phantom position values that may collide if those clips are later assigned to a different project (Phase 2.3 already exposes this assignment surface).

**Fix.** In `DELETE /api/projects/[id]`, before the actual project delete:

```ts
await prisma.generation.updateMany({
  where: { projectId: params.id },
  data: { position: null },
});
await prisma.project.delete({ where: { id: params.id } });
```

Order matters: clear `position` first, then delete the project. If the project delete fails (FK constraint, etc.), the position clear is harmless leftover — clips still belong to the project with cleaner state. The reverse order would leave `position` permanently dirty if the project delete succeeded but `updateMany` failed.

Actually, run it in a transaction to avoid the partial-failure ambiguity:

```ts
await prisma.$transaction([
  prisma.generation.updateMany({
    where: { projectId: params.id },
    data: { position: null },
  }),
  prisma.project.delete({ where: { id: params.id } }),
]);
```

Acceptance: after deleting a project that had 3 clips, all 3 clips have `projectId: null` AND `position: null` in the DB.

## Fix 2: Studio pill staleness after project delete

**Defect.** After deleting a project, any client-side state holding the project's ID stays populated. The Studio header's "Project: [name]" badge in particular renders against deleted projects, showing the old project name (or breaking on next navigation).

**Fix.** When the project DELETE succeeds, broadcast the deletion to client state. Two paths depending on the existing state model:

- If a global active-projects state container exists (or a Context/Zustand store), have the delete handler clear any references to the deleted ID before navigating away.
- If state is local to components, fire a custom event (e.g. `window.dispatchEvent(new CustomEvent('project-deleted', { detail: { id } }))`) that subscribed components listen for and clear matching state.

The Studio pill specifically: read its source-of-truth and ensure the deletion path clears it. If the pill reads from sessionStorage (per Phase 2.2's persistence pattern), the delete handler also needs to scrub the sessionStorage key:

```ts
const stored = sessionStorage.getItem('studio.activeProjectId');
if (stored === deletedProjectId) {
  sessionStorage.removeItem('studio.activeProjectId');
}
```

Verify which keys exist (`grep -rn "sessionStorage\|localStorage" src/`) and clear all that reference project IDs.

Other places that may hold project IDs and need clearing:
- The active-jobs state container (Phase 1.2b queue tray) — jobs may reference a `projectId` for stitch ETA labeling. Don't delete the jobs themselves; they continue running. Just clear the project-name display on those rows so they read "Stitched export" instead of the stale name.
- Any in-flight playthrough state on the project detail view. Navigation away from the deleted project handles this implicitly (component unmounts).

Acceptance: deleting a project while in Studio with that project's pill active — the pill clears immediately, no flash of the old name, no broken state on next interaction.

## Fix 3: CheckpointConfig dimension UI consistency

**Defect.** Per-checkpoint defaults (PR #26) lets the user type any width and height as separate freeform numeric inputs in ModelConfig. Studio's image mode uses a fixed dropdown of canonical resolutions from a `RESOLUTIONS` constant. A user can save defaults like 700×1024 in ModelConfig that aren't in Studio's dropdown — the saved value loads but doesn't match any option, so the dropdown either shows blank or falls back to a default. Either way, the soft-fill semantics break.

**Fix.** Single source of truth on canonical resolutions. Drop the freeform width/height inputs in ModelConfig's per-checkpoint defaults section. Replace with the same `RESOLUTIONS` dropdown Studio uses.

Implementation:

1. Locate `RESOLUTIONS` in `src/lib/` or wherever it lives. It's a list of `{label, width, height}` tuples (or similar).
2. In ModelConfig's checkpoint defaults form, replace the two freeform number inputs (`defaultWidth`, `defaultHeight`) with a single dropdown bound to RESOLUTIONS. Selected value sets both `defaultWidth` and `defaultHeight` together.
3. Add an "(no default)" option at the top — selecting it clears both fields to null.
4. Server-side, in the existing PATCH-checkpoint-config route, validate that `defaultWidth × defaultHeight` is a pair found in RESOLUTIONS (or both null). Reject otherwise with 400.

The independent multiples-of-32-or-64 validation that PR #26 added stops being meaningful once resolution is fixed-list-only — the list contains only valid resolutions by construction. Remove the multiples-of-N check; replace with the pair lookup.

The video form's dimensions also have a fixed list (the resolution presets `1280×704`, `768×768`, `704×1280` from Phase 1.2a). They don't use `RESOLUTIONS` directly — they're hardcoded in the video form. Don't touch the video form in this batch; the inconsistency between image's RESOLUTIONS list and video's hardcoded presets is a separate concern (and arguably correct, since image and video have different optimal resolution lists).

Acceptance: ModelConfig's checkpoint defaults form has one resolution dropdown, not two number inputs. The dropdown's options match RESOLUTIONS exactly. Saving a value populates `defaultWidth` and `defaultHeight` in the DB; selecting "(no default)" sets both to null. Server-side, posting an out-of-list pair returns 400.

---

## Acceptance criteria (combined)

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- The DELETE project route clears `position` on orphaned clips, in a transaction with the project delete.
- After deleting a project, no client-side state references the deleted project's ID.
- ModelConfig's checkpoint defaults form uses a single resolution dropdown bound to `RESOLUTIONS`.
- Server-side validation rejects out-of-list resolution pairs.
- `git log --oneline -1 origin/<branch>` shows the agent's commit (i.e., the agent actually committed and pushed).

Manual smoke test (deferred to user):

1. Create a project with 2 clips. Delete the project. Inspect the DB: confirm both clips have `projectId: null` AND `position: null`.
2. Open Studio, click "Generate new clip in this project" from a project, then in another tab/window delete that project. Return to Studio. Confirm the pill clears (refresh if needed; if a refresh is needed, that's a separate UX concern but not a blocker for this fix). Generate something — confirm no errors and the resulting clip is project-less.
3. Open ModelConfig → Checkpoints → pick one with defaults. Confirm the resolution field is now a single dropdown matching the Studio image-form resolution picker exactly. Pick a value, save, refresh, confirm persistence.
4. Try to PATCH the checkpoint-config endpoint via curl with `defaultWidth: 700, defaultHeight: 1024`. Confirm 400 with a clear error.
5. Select "(no default)" in the dropdown, save, confirm both DB fields are null.
6. Switch to that checkpoint in Studio. Confirm the resolution dropdown receives the saved value cleanly (no fallback-to-default behavior, no blank).

---

## Out of scope

- Updating Studio's video resolution presets to use a shared list. Leave video presets hardcoded.
- A "force-clear all project references" sweep on app load. The targeted clears are enough.
- Audit of every sessionStorage / localStorage key in the app. Just the project-related ones.
- Backfill migration to clear orphaned `position` values on existing clips. The cleanup landed retroactively in Fix 1; existing dirty rows persist until their next assignment-or-orphan event. Single-user app, low data volume, no need to backfill.
- Notify the user in the queue tray that a stitch's source project was deleted. The tray entry transitioning to a generic label is sufficient.
- A "deleted projects archive" view. Out of scope.

---

## Documentation

In CLAUDE.md, find the projects section. Add a small note under the project-deletion paragraph:

> Project deletion clears both `projectId` and `position` on member clips, in a single transaction. Client-side state holding the deleted project's ID is broadcast-cleared so the Studio pill, queue tray labels, and any persisted sessionStorage references update immediately.

In CLAUDE.md's per-checkpoint defaults section (added by PR #26), update to clarify:

> Default resolution is a single value drawn from the canonical `RESOLUTIONS` list shared with Studio's image form. Width and height are persisted as separate columns but are saved and validated as a pair.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
