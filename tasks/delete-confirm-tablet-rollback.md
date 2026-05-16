# Batch — Rollback type-to-confirm; restore tap-based delete UX

The delete-confirmation dialog batch (PR matching `delete-confirm-dialog`) introduced type-to-confirm friction on project deletes, gallery modal-sidebar deletes (image and video clips), and Models tab deletes. This is wrong for a tablet-first application. Typing into a confirm dialog requires summoning the soft keyboard for every destructive action — slower and more annoying than the multi-step ellipsis flow it replaced.

Replace the type-to-confirm pattern with tap-based confirmation. Different friction levels are still appropriate for different destructive scopes (a project cascade-delete is much bigger than a single-clip delete), but every level should be tap-only.

Re-read CLAUDE.md before starting. Use `project_knowledge_search` to find the existing `<DeleteConfirmDialog>` component (or whatever it ended up being named) and all its call sites.

---

## Required changes

### 1. Replace type-to-confirm with tap-based confirm in `<DeleteConfirmDialog>`

Find the existing dialog component. Currently:

- Title: "Delete [resourceType]?"
- Body: warning message + a text input asking the user to type the resource name.
- Delete button: disabled until input matches name exactly.

Replace with:

- Title: "Delete [resourceType]?"
- Body: warning message. **No text input.**
- Two buttons: **Cancel** (default focus) and **Delete** (red/destructive style, immediately enabled).
- Pressing Escape cancels. Tapping outside the modal cancels. Tapping Delete confirms.

The friction now comes from the modal itself + having to tap the destructive button intentionally. That's enough for clip deletes (which are individually low-stakes) and adequate for model deletes.

### 2. Add a hold-to-confirm variant for project cascade delete

Project cascade delete (the "Delete everything" radio option introduced by the cascade-delete batch) deletes potentially many items at once. Plain tap-to-confirm is too easy for that scope. Add slightly more friction:

- When the cascade option is selected, the Delete button is **initially disabled for ~2 seconds** after the dialog opens or the radio is toggled. A small countdown indicator or a fading "Wait…" label shows the delay.
- After the delay expires, Delete is enabled.
- Toggling back to "Keep items" (the non-cascade option) immediately enables Delete (no delay needed for the safer choice).

The 2-second delay is the friction equivalent of "did you mean to do that?" — enough to interrupt accidental tap-tap-tap behavior, short enough to not feel punitive when the user actually wanted it.

If implementing the delay feels awkward, an alternative pattern: a **two-step confirm within the dialog**:

- Cascade option selected → Delete button reads "Confirm" instead of "Delete."
- Tap "Confirm" → button morphs to "Delete everything" with a countdown ring or distinct color.
- Tap again → executes.

Either pattern works. Pick whichever fits the existing component's idioms more naturally. Document the choice in the PR description.

For non-cascade project delete (the "Keep items" option), use the same plain tap-to-confirm as clip/model deletes. No delay, no two-step.

### 3. Restore the original gallery tile-level two-tap

The delete-confirm batch's prompt explicitly preserved the gallery's tile-level two-tap delete. Verify that's still the case — tile-level should NOT route through `<DeleteConfirmDialog>`. If somewhere along the way it got routed in (via overzealous component reuse), restore the inline two-tap pattern.

`project_knowledge_search` for the gallery tile delete handler. Confirm it still operates inline without opening the modal dialog.

### 4. Update or remove the "type to confirm" terminology in CLAUDE.md

The delete-confirm batch added documentation describing the type-to-confirm pattern. Update to reflect the new pattern:

> Destructive actions in the app share a single confirm-dialog pattern: `<DeleteConfirmDialog>` opens a modal with a clearly-labeled destructive button (red/Delete) and a Cancel button. Tap to confirm. The dialog focuses Cancel by default, so an accidental tap-anywhere doesn't delete.
>
> Project cascade delete (the "Delete everything" option) adds a brief delay or two-step confirm to the destructive button — its scope is large enough to warrant slight extra friction.
>
> The gallery's tile-level two-tap delete is intentionally not routed through this dialog. Tile-level is sweep-cleanup intent; the modal-level is deliberate single-item intent.

Find any other CLAUDE.md mentions of "type to confirm," "exact match," "case-sensitive match," etc., related to delete UX. Remove them.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `<DeleteConfirmDialog>` no longer renders a text input.
- `grep -rn "type the.*name to confirm\|case-sensitive match" src/` returns no matches.
- Tapping Delete in the dialog (when not in cascade mode) executes the delete immediately, no typing required.
- Cascade project delete has either a 2-second initial-delay disabled state OR a two-step "Confirm → Delete everything" pattern. Document which in the PR description.
- Gallery tile-level delete still uses the original inline two-tap pattern, NOT the modal dialog.
- The dialog's Cancel button has default focus / is the keyboard-default action when the dialog opens.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. Open a clip in the gallery modal. Tap delete in the sidebar. Confirm: dialog opens, no text input, Cancel and Delete buttons visible. Tap Cancel → dialog closes, clip unaffected. Repeat, tap Delete → clip deletes.
2. Open a project. Tap delete. Confirm dialog opens. Verify "Keep items" radio option is preselected. Tap Delete → project deletes, clips remain in gallery (project-less).
3. Open a project. Tap delete. Switch to "Delete everything" radio. Verify Delete button shows the delay or two-step UX. Wait the delay → Delete enables. Tap → cascade fires correctly.
4. Open a checkpoint in the Models tab. Tap delete. Tap Delete in the dialog → file removed from VM, DB row gone.
5. Open a gallery tile (don't open the modal). Tap the inline delete on the tile. Confirm two-tap pattern still works (no modal dialog).
6. Tap outside the dialog at any point during steps 1-4 — dialog closes, no destructive action.

---

## Out of scope

- Restoring the prior "two ellipsis menus" project delete UX. The new dialog is fine, just without typing.
- Adding undo functionality for deletes. Out of scope.
- A "delete N items at once" bulk affordance. Out of scope.
- Replacing the gallery tile-level two-tap with the dialog. Stays as-is.
- Changing the model-delete UX beyond removing the type-to-confirm requirement.
- Auditing every modal in the app for tablet-friendliness. This batch is delete-specific.

---

## Documentation

CLAUDE.md updates listed in section 4 above. When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
