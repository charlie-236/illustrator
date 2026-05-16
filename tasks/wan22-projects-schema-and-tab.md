# Batch — Projects schema and Projects tab (Phase 2.1)

First half of Phase 2. After this batch, you can create projects, view a project's clip sequence as a linear strip, edit project defaults, and delete projects. Generation from within a project + prompt threading + last-frame extraction land in Phase 2.2.

Re-read CLAUDE.md before starting.

---

## What to build

### 1. Schema

Add a new `Project` model and a relation on `Generation`.

```prisma
model Project {
  id              String       @id @default(cuid())
  name            String
  description     String?
  styleNote       String?      // freeform text user keeps as a creative anchor
  defaultFrames   Int?         // overrides Wan 2.2 default of 57
  defaultSteps    Int?
  defaultCfg      Float?
  defaultWidth    Int?
  defaultHeight   Int?
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt
  generations     Generation[]
}

model Generation {
  // ... existing fields ...
  projectId       String?
  project         Project?     @relation(fields: [projectId], references: [id], onDelete: SetNull)
  position        Int?         // null for non-project generations; sequence within a project otherwise
}
```

Notes:
- All defaults nullable. A project with no defaults set inherits the Wan 2.2 baseline at clip-creation time.
- `onDelete: SetNull` for the relation: deleting a project doesn't delete its clips. They drop back to project-less state and remain in the unified Gallery.
- `position` is `Int?`, nullable. Non-project clips have no position. Project clips default to `max(position) + 1` at insert time, computed in the route (Phase 2.2 territory).
- Don't add a unique constraint on `(projectId, position)`. Reorder operations may temporarily violate it during multi-row updates; better to enforce ordering at write-time in application code than fight Prisma transactional constraints. The position field is for sort, not for primary-key uniqueness.

Generate a migration named `add_projects`. Test that `npx prisma migrate dev` runs cleanly against a copy of the dev DB before committing.

### 2. API routes

**`GET /api/projects`** — list all projects.

Response:
```ts
{
  projects: Array<{
    id: string;
    name: string;
    description: string | null;
    styleNote: string | null;
    clipCount: number;          // computed via _count
    coverFrame: string | null;  // most recent project clip's localPath, null if no clips
    createdAt: string;
    updatedAt: string;
  }>
}
```

Order: most recently updated first.

**`GET /api/projects/[id]`** — full project plus its clips in order.

Response:
```ts
{
  project: {
    id, name, description, styleNote,
    defaultFrames, defaultSteps, defaultCfg, defaultWidth, defaultHeight,
    createdAt, updatedAt,
  },
  clips: Array<{
    id: string;
    localPath: string;
    prompt: string;
    frames: number;
    fps: number;
    width: number;
    height: number;
    position: number;
    createdAt: string;
    favorite: boolean;
  }>;
}
```

Clips ordered by `position ASC, createdAt ASC` (createdAt as tiebreaker if position is somehow null, defensive).

**`POST /api/projects`** — create.

Request:
```ts
{
  name: string;        // required, non-empty after trim
  description?: string;
  styleNote?: string;
  defaultFrames?: number;
  defaultSteps?: number;
  defaultCfg?: number;
  defaultWidth?: number;
  defaultHeight?: number;
}
```

Validate the defaults against the same rules as `/api/generate-video`'s validation (multiples of 32 for dimensions, 8N+1 for frames, etc.). If any default is invalid, return 400 with a clear message.

Returns the created project.

**`PATCH /api/projects/[id]`** — update. Same validation rules apply. Partial updates allowed.

**`DELETE /api/projects/[id]`** — delete. Per the schema, clips drop to project-less. Return `{ ok: true }`.

**`PATCH /api/projects/[id]/reorder`** — reorder clips.

Request:
```ts
{
  clipOrder: string[];  // ordered list of generation IDs
}
```

Validate that every ID in `clipOrder` belongs to this project and that the count matches. On valid input: update each clip's `position` to its index in the array, in a single Prisma transaction. Return `{ ok: true }`.

If validation fails (unknown IDs, count mismatch): 400.

### 3. Projects tab

Add a "Projects" tab to the main tab bar. Position: after Studio, before Gallery — same logic as the existing Gallery placement (organizational tab next to creation tab).

**Tab listing view:**

- Top bar: a "+ New Project" button (right side).
- Grid of project cards, 2-3 columns depending on viewport. Each card:
  - Cover frame (the `coverFrame` from the API; if null, a placeholder graphic). For video cover frames, render `<video preload="metadata" muted playsInline>` so the first frame shows as a thumbnail, same pattern as the gallery tiles.
  - Project name (bold)
  - Description (one line, ellipsis on overflow) or muted "No description" if null
  - Clip count: "12 clips" / "1 clip" / "No clips"
  - Last updated timestamp, relative ("3 hours ago") — match the project's existing time-display convention
- Click anywhere on the card → navigate to project detail view.
- Empty state when zero projects: large centered call-to-action "Create your first project".

**New Project modal:**

A modal triggered by the "+ New Project" button. Form fields:
- Name (required, text input)
- Description (optional, textarea)
- Style note (optional, textarea, with a small hint: "Creative anchor — what is this project about?")
- A collapsible "Default settings" section (collapsed by default), containing:
  - Default frames (slider, same widget as Studio's video form, snaps to 8N+1)
  - Default steps
  - Default CFG
  - Default width × height (the same resolution presets from Studio's video form)

Submit calls POST /api/projects, closes modal, navigates to the new project's detail view.

### 4. Project detail view

The view that opens when a project card is clicked, or when navigating directly via project ID.

**Header:**
- Project name (large, editable inline — click to edit, save on blur or Enter).
- Description below (also inline-editable).
- A "Settings" button on the right that opens a modal with the same form as New Project (minus the name field, which is in the header). Used for editing defaults and style note.
- A "Delete project" button in the header's overflow menu. Two-tap confirm pattern, same as the Gallery's delete-clip pattern.

**Style note** (if present): rendered below the description in a muted box, distinct from the description. The visual hint is "this is creative direction, not a description."

**New clip button:** "Generate new clip in this project" — disabled in this batch with a "Coming in 2.2" tooltip. Wire-up lands next batch. The button being visible in this batch is fine — it's a teaser for the user to know the loop closes; the missing functionality will be obvious from the disabled state.

**Linear strip:**

Horizontal-scrollable strip of clip tiles in `position` order. Each tile:
- Same first-frame thumbnail logic as Gallery video tiles (`<video preload="metadata">`).
- Duration badge in corner.
- Position number ("1", "2"...) in the opposite corner.
- Click → opens the existing Gallery modal with previous/next navigation scoped to this project's clips.

**Reorder UX:**

Drag-and-drop on the linear strip. Use whatever drag-and-drop library is already in the project; if there isn't one, add `@dnd-kit/core` (lightweight, well-supported, accessible). On drop:
- Update the local UI state immediately (optimistic).
- POST `/api/projects/[id]/reorder` with the new order.
- On error, revert and show a toast.

Empty state: "No clips yet. Generate the first one in Phase 2.2." (Or whatever phrasing the agent prefers — point is the empty state is informative, not blank.)

**Filter / search:** explicitly out of scope for this batch. If a project has 50 clips and the user wants to find one, they can scroll. We'll add filter UI when it becomes a real pain point.

### 5. Gallery integration

The existing Gallery (Phase 1.3) shows all clips, regardless of project. Don't change that.

Add one small affordance: each video tile in the gallery, in the modal sidebar, gets a new line: "Project: [name]" (linking to the project detail view) or "Project: None". This makes the project-clip relationship visible from the gallery side.

The remix-from-gallery flow stays unchanged — remixing a project clip into Studio doesn't preload the project context. Project-aware generation is Phase 2.2.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- Migration `add_projects` applies cleanly. Existing `Generation` rows have `projectId: null`, `position: null`.
- The Projects tab is visible in the main tab bar.
- Creating a project via the modal works end-to-end.
- The project detail view loads a project and renders its clips in `position` order.
- Drag-and-drop reordering persists across page refresh.
- Editing project name/description inline persists across page refresh.
- Editing project defaults via the Settings modal persists across page refresh.
- Deleting a project sets its clips' `projectId` to null (verify via DB query); the clips remain in the unified Gallery.
- The Gallery modal sidebar shows the project link (or "None") for video clips.
- "Generate new clip in this project" button is visible but disabled with a clear tooltip.

Manual smoke test (deferred to user):

1. Open Projects tab. Confirm empty state. Create a project named "Test 1" with no defaults. Confirm card appears with "No clips" and the empty cover.
2. Open Test 1's detail view. Confirm the layout: header with name + description + settings button + delete in overflow, empty linear strip, disabled new-clip button.
3. Manually assign an existing video clip to Test 1 via direct DB write (or a quick Prisma Studio session). Refresh the project view. Confirm the clip appears in the linear strip.
4. Add 2-3 more clips the same way. Confirm they appear in `position` order. Drag the third clip to first position. Refresh. Confirm the order persists.
5. Edit the project name inline. Refresh. Confirm persistence.
6. Open the Settings modal. Set default frames = 81, default steps = 24. Save. Refresh. Confirm.
7. Delete the project (two-tap). Confirm the project is gone from the listing. Open the Gallery — confirm the clips that were in it are still present (now project-less). The Gallery modal sidebar shows "Project: None" for them.
8. Try to create a project with an empty name. Confirm the form rejects the submit.
9. Try to PATCH defaults with an invalid value (frames = 50). Confirm 400.

---

## Out of scope

- Generation flow from project context. Phase 2.2.
- Prompt threading (carry-forward, last-frame). Phase 2.2.
- Play-through preview. Phase 2.2.
- Filter / search within a project's clips. Out of scope until needed.
- Bulk operations (assign N clips to a project at once, move clips between projects). Out of scope.
- Project archiving / hiding. Delete is the only lifecycle action.
- Per-clip notes (annotations on a clip within a project). Out of scope.
- Clip pinning within a project. Out of scope; reorder handles "I want this one first."
- Project sharing / export. Out of scope; single-user app.
- A "duplicate project" affordance. Out of scope.
- A "merge two projects" affordance. Out of scope.
- A "project cover frame override" (let user pick which clip is the cover). Out of scope; latest-clip is good enough.

---

## Documentation

In CLAUDE.md, add a new section "Projects (Phase 2)":

- Schema additions: Project model, Generation.projectId/position.
- API routes: GET /api/projects, GET /api/projects/[id], POST /api/projects, PATCH /api/projects/[id], DELETE /api/projects/[id], PATCH /api/projects/[id]/reorder.
- Projects tab and project detail view.
- Note that generation-from-project lands in Phase 2.2.

Find the API routes table and add all six new endpoints.

Find the source layout. Add the new tab component, project detail component, and project-card component.

When done, push and create the PR via `gh pr create` per AGENTS.md.
