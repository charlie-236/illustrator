# Batch — Studio project switcher

The Studio header's project context badge (Phase 2.2) is currently set-once: you arrive via "Generate new clip in this project" from a project detail view, the badge populates, you can clear it with ×, and that's the only entry point. Switching to a different project means navigating to that project and clicking Generate. Tedious for iterating across projects.

Fix: make the badge itself a clickable project picker that lets the user switch projects in place.

Re-read CLAUDE.md before starting. Phases 2.1, 2.2, and 2.3 must be merged before this batch runs.

---

## What to build

### Make the badge clickable

The Studio header's project context badge has three states:

**State A — no project context (default):**
- Display: a small muted pill labeled "No project" (or whichever phrasing matches existing UI tone — match the empty-state convention used elsewhere).
- Click → opens picker.

**State B — project active:**
- Display: pill labeled "Project: [name]" with × button to clear (existing Phase 2.2 behavior).
- Click on the pill body (NOT the ×) → opens picker.
- Click × → clears project context, returns to State A. (Existing behavior, unchanged.)

**State C — picker open:**
- Anchored dropdown showing:
  - "None" option at the top (selecting clears project context, equivalent to clicking ×).
  - List of all projects, sorted most-recently-updated-first, each row showing name + clip count.
  - Search/filter input above the list if more than ~10 projects exist (cheap UX win, optional).
  - "+ Create new project" at the bottom (opens the existing New Project modal from Phase 2.1; on success, auto-applies the newly created project as the active context).
- Click outside or press Escape → closes picker without changing context.
- Click a project → switches active project, closes picker.

The picker is the same shape as the gallery modal's picker from Phase 2.3. Reuse the same component if possible — extract `<ProjectPicker>` (or `<ProjectSelector>`, whatever fits the project's naming) so both call sites consume it. Differences are positioning (dropdown vs. modal-anchored) and which option is "none" vs "unassign," but the core list rendering is identical.

### Switch behavior — hard reset on apply

When the user picks a different project (whether from State A, B, or C):

1. The Studio video form resets to the new project's defaults: width, height, frames, steps, cfg, Lightning toggle, LoRA stack, default video LoRAs (per Phase 1.4b if shipped). Wan 2.2 baseline fallback for any field the new project doesn't override.
2. The prompt textarea pre-fills with the new project's latest clip's prompt (Phase 2.2 carry-forward). If the new project has zero clips, the prompt textarea clears to empty.
3. The "Use last frame of previous clip" checkbox state resets to off. If the new project has at least one clip, the checkbox is available; otherwise hidden (Phase 2.2 behavior).
4. The starting-frame manual gallery picker (if the user had one selected) clears.
5. Seed clears (or randomizes — match whatever the existing reset-on-project-switch does in Phase 2.2's "Generate new clip in this project" flow).

If the user picks "None" (or clicks ×), the project context clears but **the form values stay** — the user keeps whatever they had typed. This matches Phase 2.2's existing behavior for clearing context (just removes the project association without touching form state).

The asymmetry between "switching to a different project" (hard reset) vs. "clearing project entirely" (no reset) is intentional: switching projects is "I want this OTHER project's setup," clearing is "I'm not in any project right now, but I'm still working on this thing."

### Edge cases

- **Switching to the same project that's already active.** Picker treats this as a no-op — close picker, no form changes. Don't reset on re-pick.
- **Switching while a generation is in flight.** The active job in the queue tray retains its `projectId` (the row was created with whichever project was active at submit time). Switching projects in Studio doesn't retroactively change job state. The queue tray reflects the project the job was generated in, not whichever project Studio currently shows.
- **No projects exist.** State A pill shows "No project," click opens picker that contains only "None" (greyed out / not selectable since it's already implicit) and the "+ Create new project" option. Effectively the picker becomes "create your first project."
- **Project deletion while it's the active context.** Per the cleanup bundle batch, this clears Studio's pill on event broadcast. After that fires, Studio is in State A. If the user has the picker open at the moment of deletion, refresh the list (delete the just-deleted entry from the visible list).

### Persistence

Selected project persists across page refresh via the same sessionStorage mechanism Phase 2.2 already uses for active project context. Switching projects updates the sessionStorage value. Clearing or reaching State A clears it.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- The Studio header badge is clickable in all three states (no project, project active, picker open).
- Selecting a different project from the picker resets the form to that project's defaults and pre-fills the prompt with the new project's latest clip prompt.
- Selecting the same project that's already active is a no-op.
- "+ Create new project" in the picker opens the existing New Project modal and auto-applies the result.
- Selecting "None" clears project context without resetting form values.
- The × on the badge still works (matches the "None" path).
- Keyboard: Escape closes the picker, Enter on a focused project entry selects it.
- The picker reuses the same `<ProjectPicker>`-or-equivalent component as Phase 2.3's gallery sidebar picker (verify with `grep -rn "ProjectPicker" src/` showing both call sites).
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. Open Studio in image or video mode with no project context. Confirm the badge reads "No project." Click it — confirm the picker opens with all projects listed.
2. Select a project. Confirm the badge updates, the form resets to that project's defaults, the prompt populates with that project's latest clip's prompt.
3. With project A active, click the badge again. Confirm the picker opens with project A highlighted (or marked as active somehow).
4. Click project B from the picker. Confirm: badge updates, form resets to B's defaults (different from A's), prompt updates to B's latest clip's prompt.
5. Type a custom prompt. Click the × on the badge. Confirm: badge clears to "No project," form values STAY (the prompt you typed is preserved).
6. Type something else. Click the badge. Pick project C. Confirm: form resets, your typed prompt is gone.
7. Test "+ Create new project." Confirm the existing New Project modal opens, on save the new project becomes active.
8. Refresh the page mid-edit. Confirm the active project survives refresh.
9. From a project detail view, click "Generate new clip in this project" for a third project. Confirm Studio opens with that project active (existing Phase 2.2 entry point still works).
10. While at project A in Studio, generate a clip. Switch to project B mid-generation. Confirm the in-flight job in the queue tray still shows project A (the job's projectId doesn't retroactively change).

---

## Out of scope

- Soft-fill behavior (only resetting fields the user hasn't touched). Confirmed: hard reset on project switch.
- A "switch and preserve prompt" affordance. The user can copy-paste manually if they want to preserve specific text across switches.
- Confirmation dialog before reset. The cleanup-bundle batch's delete confirm is the only friction layer; project switching is non-destructive (form values can be retyped or remixed back from gallery).
- Multi-project context (working on clips for multiple projects simultaneously). Single active project at a time.
- Recently-used projects shortlist at the top of the picker. Out of scope.
- Search/filter in the picker beyond what's already specified (10+ projects). Out of scope.
- Pinning favorite projects. Out of scope.
- Showing project cover frames as picker thumbnails. Text-only picker rows are fine.
- A keyboard shortcut to open the picker (e.g. Cmd+P). Out of scope.

---

## Documentation

In CLAUDE.md, find the Phase 2.2 project context section. Update:

> The Studio header's project context badge is a clickable project picker. Selecting a different project hard-resets the form to that project's defaults and pre-fills the prompt with the new project's latest clip prompt. Selecting "None" or clicking × clears the project association without resetting form values. The picker is the same component used by Phase 2.3's gallery modal sidebar.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
