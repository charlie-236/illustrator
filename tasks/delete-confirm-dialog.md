# Batch — Delete UX consistency

The current "..." → Delete → "..." → Delete pattern for project deletion is awkward — clicking ellipsis twice with a flyout in between makes the destructive action feel both hidden AND poorly guarded. Other deletes in the app have their own variants (gallery's two-tap-confirm tile button, model picker's separate path). Across the app there's no consistent pattern for destructive actions.

This batch establishes one pattern: a primary "Delete" button (or icon) that opens a confirm dialog requiring the user to type the resource name to confirm. Apply uniformly across project / clip / model deletes.

Re-read CLAUDE.md before starting.

---

## The pattern

A single shared component `<DeleteConfirmDialog>` (or whatever fits the project's component conventions). Props:

```ts
type DeleteConfirmProps = {
  open: boolean;
  resourceType: 'project' | 'clip' | 'checkpoint' | 'lora' | 'embedding';
  resourceName: string;          // displayed to user, also what they must type
  onConfirm: () => void;
  onCancel: () => void;
  warningMessage?: string;       // optional contextual warning (e.g. "12 clips will be unassigned")
};
```

UI:

- Modal dialog, centered, dimmed backdrop (existing modal conventions).
- Title: "Delete [resourceType]?" (e.g. "Delete project?")
- Body: "This will permanently delete **[resourceName]**. [warning, if any]"
- Type-to-confirm: an input field with placeholder "Type the [resourceType] name to confirm"
- Two buttons: Cancel (default) and Delete (red/destructive style, disabled until input matches name exactly).
- Pressing Enter when the input matches submits delete; Escape cancels.

Type-to-confirm is the friction layer. Standard pattern in tools that take destructive actions seriously (GitHub, Stripe, AWS). Two-tap doesn't scale — the user develops muscle memory and stops reading. Type-to-confirm forces them to look at what they're about to destroy.

Case-sensitive match. Names in this app are user-controlled; case sensitivity isn't a meaningful obstacle to legitimate users and adds a bit of friction against accidental destruction.

The match is exact. No trim, no fuzzy. If the user has trailing whitespace, the button stays disabled — that's correct, not annoying.

## Where to apply it

### Project delete

Currently behind two ellipsis menus. Replace with:

- A primary "Delete project" button in the project detail view's overflow menu (one ellipsis, one click) OR — better — a danger-styled "Delete project" button in the project Settings modal alongside the other project edit fields.
- Click → opens `<DeleteConfirmDialog>` with `resourceType: 'project'`, `resourceName: project.name`, `warningMessage: '${clipCount} clips will be unassigned (not deleted).'`
- Confirm → calls existing DELETE route, navigates away from the project detail view.

The agent picks between "overflow menu button" and "Settings modal danger zone" based on which fits cleaner with the existing layout. Both are acceptable — the goal is one obvious-but-guarded entry point, not the specific location.

### Clip delete (gallery)

The gallery's existing two-tap-confirm tile button is the closest to consistent with this pattern but doesn't ask for the name. Two paths:

**(a) Keep two-tap on gallery tiles, add `<DeleteConfirmDialog>` on the modal sidebar's delete button.**

Reasoning: tile-level delete is a sweep-cleanup pattern (you're scrolling, you spot junk, you nuke it). Forcing type-to-confirm on every tile-level delete would slow down legitimate cleanup work. The modal's delete is the deliberate "I'm looking at this one specific clip and want it gone" path; that's where the friction belongs.

**(b) Apply `<DeleteConfirmDialog>` to both.**

Reasoning: consistency. Every delete asks the same question.

I lean (a). Tile-level is sweep, modal-level is deliberate. Different friction levels for different intents. If you find yourself accidentally deleting clips from the tile view, that's the signal to escalate to (b). Don't preemptively over-protect.

The agent ships (a). The two-tap pattern stays on tiles unchanged; the modal-sidebar delete uses the new dialog.

For the modal dialog, `resourceName` for a clip is the prompt summary (first ~60 chars). If the prompt is longer than 60 chars or ambiguous, the user can copy-paste from the displayed name into the confirm field — that's fine. Don't over-engineer name disambiguation.

### Model delete (checkpoints, LoRAs, embeddings)

The Models tab has its own delete UX (DeleteRow component, per the model-delete-by-filename batch from earlier). Update DeleteRow's onDelete handler to open `<DeleteConfirmDialog>` instead of confirming inline.

`resourceType` is `'checkpoint' | 'lora' | 'embedding'` per the current model. `resourceName` is the friendly name (or filename if friendly name is empty). `warningMessage` is "The file will be deleted from the VM and the metadata row from the database. This cannot be undone."

The existing `DeleteRow`'s loading and error states stay — the dialog calls onConfirm, which kicks off the existing fetch flow.

### Stitched output delete

Stitched outputs are gallery video rows (per Phase 3). They use the gallery's existing delete path, which means tile-level keeps two-tap and modal-level gets the new dialog. Same as regular video clips. No special-casing.

If a stitched output's source project still exists, the delete dialog's warning message includes a note: "This is a stitched export from project [name]. The source project and its clips are unaffected." Reassures the user that "delete" here is bounded.

### Don't apply to

- Generation aborts. Already a discrete action with its own affordance.
- Job removal from queue tray after completion. Already auto-dismisses or one-click-dismiss.
- Reorder operations in the project detail view. Not destructive.
- Form-clear / reset-to-defaults actions. Not destructive.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `<DeleteConfirmDialog>` exists as a reusable component.
- Project delete uses the dialog.
- Gallery modal sidebar delete (image and video) uses the dialog. Tile-level two-tap is unchanged.
- Model delete in the Models tab uses the dialog.
- The dialog requires exact case-sensitive match before enabling the Delete button.
- Pressing Enter when matched submits; Escape cancels.
- `grep -rn "DeleteConfirmDialog" src/` shows the component definition and at least four call sites (project, clip-modal, checkpoint, lora). Embedding may or may not have a delete path yet (per the model-delete-by-filename batch); include it if it exists.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. Open a project. Click delete (wherever it landed — overflow menu or Settings modal). Confirm the dialog opens with the project name visible. Click Delete with empty input — confirm it's disabled. Type the project name with one wrong character — still disabled. Type it correctly — Delete becomes enabled. Press Enter. Confirm the project deletes.
2. Open a video clip in the gallery modal. Click delete in the sidebar. Confirm dialog opens. Cancel. Confirm clip is unaffected. Try again, type, confirm. Clip deletes.
3. Open a gallery tile (don't open the modal). Click the inline delete on the tile. Confirm two-tap pattern still works (no dialog).
4. Open a checkpoint in the Models tab. Click delete. Confirm dialog. Try a wrong name — disabled. Type correctly — confirm deletion proceeds; file is removed from VM, DB row gone.
5. Try Escape during the dialog — closes without deleting. Try clicking the backdrop — closes without deleting. Try pressing Enter with the field empty — nothing happens.
6. Try Tab cycling within the dialog — focus moves Cancel → input → Delete and wraps back. Clean keyboard navigation.

---

## Out of scope

- Undo for deletions. Out of scope; type-to-confirm is the protection layer.
- A "soft delete" pattern with a Trash tab. Out of scope.
- Time-delayed delete (e.g. "Project will be deleted in 30 days unless you cancel"). Out of scope.
- Bulk delete with bulk type-to-confirm. Single resource at a time.
- A "deleted recently" log. Out of scope.
- Replacing the gallery's tile-level two-tap with the dialog. Phase-it-if-it-bites principle.
- Delete confirmation on aborts. Aborts already have their own pattern.
- A typo-tolerant match (Levenshtein within 1, etc.). Exact match.
- A "remember my choice for this session" checkbox to skip future confirms. Out of scope; the friction is the feature.

---

## Documentation

In CLAUDE.md, add a small section "Delete confirmation pattern":

> Destructive actions in the app share a single confirm-dialog pattern: `<DeleteConfirmDialog>` requires the user to type the resource's name to enable the Delete button. Applied to project deletes, gallery modal deletes (image and video clips), and model-tab deletes (checkpoints, LoRAs, embeddings). The gallery's tile-level two-tap delete pattern is intentionally NOT replaced — different intents (sweep cleanup vs. deliberate single-item deletion) get different friction levels.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
