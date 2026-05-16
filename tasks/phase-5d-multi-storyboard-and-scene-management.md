# Batch — Phase 5d: Multi-storyboard + scene management + canonical play/stitch

This batch closes the storyboard surface. Six distinct capabilities, all riding on the same data model migration:

1. **Multiple storyboards per project.** Tab strip at the top of the storyboard section. Each tab is an independent storyboard with its own scenes, keyframes, clips, and quick-generate toggle. Switch between them; rename them; delete them.
2. **Insert scenes.** "Insert scene" affordance at any position. Empty by default; user fills via Edit modal.
3. **Reorder scenes.** Drag-to-reorder within a storyboard. Position numbers renumber automatically.
4. **Collapse all scenes.** A "Compact" toggle in the storyboard header. When on, every scene shows description-only — prompt and thumbnails hidden. For navigating 20+ scene scripts.
5. **Attach existing clip to a scene.** Pick any project clip (or even a clip from another project) as a scene's canonical without regenerating. Useful when you've generated something useful and want to retroactively label it.
6. **Play canonical scenes / Stitch canonical scenes.** Sibling buttons to the existing "Play all" / "Stitch": these operate on the storyboard's canonical-clip sequence in scene-position order, not the project's full clip strip.

A storyboard is now a relational thing, not a JSON column. The migration converts the existing `Project.storyboardJson` data into rows in a new `Storyboard` table.

Re-read CLAUDE.md before starting, particularly all Phase 5 sections (5a/5b/5c/6).

---

## Critical: disk-avoidance and tablet UX

Disk-avoidance contract is unaffected — this batch doesn't touch the workflow build path, the WS finalize path, or any output-handling logic. The forbidden-class-type guards apply equally. Verify with the standard greps.

Tablet UX rules apply throughout. Six new surfaces (tab strip, compact toggle, insert affordance, drag handles, attach-existing modal, play/stitch canonical buttons), each needing ≥44px tap targets. Drag-to-reorder uses the same `@dnd-kit` setup the project clip strip already uses — match patterns exactly.

---

## Required changes

### Part 1 — Schema migration: Storyboard becomes relational

`prisma/schema.prisma`:

```prisma
model Storyboard {
  id            String   @id @default(cuid())
  projectId     String
  project       Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  name          String   @default("Untitled storyboard")
  scenesJson    Json                              // StoryboardScene[]
  storyIdea     String                            // user's input that generated the storyboard
  generatedAt   DateTime
  quickGenerate Boolean  @default(false)          // 5c toggle, now per-storyboard
  position      Int      @default(0)              // user-orderable; default 0 for first storyboard
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([projectId, position])
}

model Project {
  // ... existing fields ...
  storyboards  Storyboard[]
  // REMOVE: storyboardJson Json?
}
```

Apply via `npx prisma db push`. The `storyboardJson` column gets dropped; existing data migrates per Part 2.

### Part 2 — Migration script

`scripts/migrate-storyboard-to-relational.ts` — one-shot script that runs before the schema push. (Or a guarded function that runs on app startup if `Project.storyboardJson` still exists in the DB; agent's preference.)

Logic:

```ts
// For each project where storyboardJson IS NOT NULL:
const projects = await prisma.$queryRaw`
  SELECT id, "storyboardJson" FROM "Project" WHERE "storyboardJson" IS NOT NULL
`;

for (const p of projects) {
  const old = p.storyboardJson as {
    scenes: StoryboardScene[];
    storyIdea: string;
    generatedAt: string;
    quickGenerate?: boolean;
  };
  await prisma.storyboard.create({
    data: {
      projectId: p.id,
      name: 'Storyboard',
      scenesJson: old.scenes,
      storyIdea: old.storyIdea,
      generatedAt: new Date(old.generatedAt),
      quickGenerate: old.quickGenerate ?? false,
      position: 0,
    },
  });
}

// Then run prisma db push to drop the column.
```

The script is idempotent — running twice with the column already dropped is a no-op. Run order: (1) script populates Storyboard rows from existing JSON, (2) `npx prisma db push` drops the JSON column. Document in PR description.

If the agent prefers a single-pass approach (use the existing column to populate the new table within a transaction, then drop), that's acceptable too — what matters is that no data is lost.

### Part 3 — Types

`src/types/index.ts`:

```ts
export interface Storyboard {
  id: string;                        // NEW — was implicit, now explicit row id
  projectId: string;                 // NEW
  name: string;                      // NEW — user-editable
  scenes: StoryboardScene[];         // unchanged
  storyIdea: string;                 // unchanged
  generatedAt: string;               // ISO
  quickGenerate: boolean;            // unchanged
  position: number;                  // NEW — for ordering tabs
}
```

`ProjectDetail` (the API response shape) gets a `storyboards: Storyboard[]` field instead of the previous `storyboard: Storyboard | null`.

### Part 4 — API routes

The storyboard route lives under the project. New shape:

**`GET /api/projects/[id]/storyboards`** — returns `{ storyboards: Storyboard[] }` ordered by position. (Optional — `GET /api/projects/[id]` already returns the project; just expand its `select` to include storyboards. Don't add a separate endpoint unless useful.)

**`POST /api/projects/[id]/storyboards`** — creates a new empty storyboard. Body: `{ name?: string }`. Returns `{ storyboard: Storyboard }`. The new row has `position = MAX(position) + 1` for that project (or 0 if first), `scenesJson = []`, `storyIdea = ''`, `generatedAt = now`, `quickGenerate = false`. Used for "Create new storyboard" tab affordance.

**`PUT /api/storyboards/[id]`** — saves a single storyboard atomically. Body: `{ storyboard: Storyboard }`. Replaces all fields. Returns `{ storyboard }`. Validates: scenes array length 0-50 (relaxed from 5a's 1-20 cap because users now can build incrementally and 5a's "must have ≥1 scene" doesn't fit the empty-storyboard-then-fill workflow); each scene has non-empty description, positivePrompt, integer durationSeconds 1-10; name 1-100 chars after trim.

**`DELETE /api/storyboards/[id]`** — deletes the storyboard. Returns `{ ok: true }`. Cascade: project's clips with `sceneId` matching any of this storyboard's scene IDs become orphans (sceneId stays, but no scene exists to reference). Same as 5b's "delete storyboard preserves clips" semantics.

**`POST /api/storyboards/[id]/reorder`** — accepts `{ position: number }`, repositions this storyboard among its siblings. Sibling positions shift to make room. Optimistic-update on the client.

**Replace** the existing `POST /api/projects/[id]/storyboard/route.ts` (singular) and `PUT /api/projects/[id]/storyboard/route.ts` with the new shape. The old singular routes go away. If client code still references them, the agent finds and updates.

The `/api/storyboard/generate` route (LLM-side) stays — it generates a `Storyboard` shape that the client then PUTs to either an existing or new storyboard's id.

### Part 5 — ProjectDetail tab strip

The storyboard section header gets a tab strip above the existing collapse-toggle row:

```
┌───────────────────────────────────────────────────────────────────┐
│ [ Main ▼ ]  [ Alt take ]  [ Dark version ]  [ + ]                 │
│                                                                     │
│ 📓 Storyboard ▼                          Generated 2h ago · 5 scenes│
│                                          ⚡ Quick generate  [○━━]   │
│                                          📋 Compact            [○━━]│
│                                                                     │
│ [ Generate keyframes (3 needed) ]                                   │
│ [ ▶ Play canonical ]   [ 🪡 Stitch canonical ]                      │
│ [ Regenerate ]   [ Delete ]                                         │
└───────────────────────────────────────────────────────────────────┘
```

Tab UX:
- Each tab is the storyboard's `name`. Tap to switch (saves selected tab to sessionStorage keyed by project id).
- Active tab visually distinct (filled bg, border).
- Long-press (or tap-and-hold) on a tab opens a small menu: Rename / Delete / Reorder. Tablet-friendly — long-press timeout ~500ms.
- Drag-to-reorder tabs uses `@dnd-kit` (mirror project clip strip pattern).
- "+" tab at the end opens a small create-storyboard popover or modal: name input (pre-filled with "Storyboard N" suggestion), "Create" button. Default name is `Storyboard ${storyboards.length + 1}` if untaken.
- When the project has zero storyboards, no tab strip — just the empty state ("Plan with AI") that lives at the bottom of an implicit single tab.
- When the project has exactly one storyboard, show the tab strip anyway so the "+" is reachable.

Selected storyboard state:

```ts
const [selectedStoryboardId, setSelectedStoryboardId] = useState<string | null>(null);

// On project load:
useEffect(() => {
  if (!project) return;
  const saved = sessionStorage.getItem(`storyboard-tab-${project.id}`);
  if (saved && project.storyboards.some((s) => s.id === saved)) {
    setSelectedStoryboardId(saved);
  } else {
    setSelectedStoryboardId(project.storyboards[0]?.id ?? null);
  }
}, [project?.id]);

// Persist on change:
useEffect(() => {
  if (selectedStoryboardId && project) {
    sessionStorage.setItem(`storyboard-tab-${project.id}`, selectedStoryboardId);
  }
}, [selectedStoryboardId, project?.id]);
```

The rest of the storyboard section (scenes, buttons, modals) renders for the *selected* storyboard. All existing 5a/5b/5c/6 behavior moves inside this scope.

Renaming: tap the tab's name in the long-press menu → small inline modal with name input. Validates 1-100 chars; PUT-saves to `/api/storyboards/[id]`.

Deleting: tap Delete in the long-press menu → confirm dialog ("Delete storyboard '<name>'? This removes the scene plan only. Project clips are not affected."). On confirm: DELETE /api/storyboards/[id]; if this was the active tab, switch to the next sibling (or null if it was the last); refresh project.

### Part 6 — Compact (collapse all) toggle

Storyboard section header gets a "Compact" toggle alongside "Quick generate":

```
⚡ Quick generate  [○━━]
📋 Compact        [○━━]
```

When ON, every scene card shows description-only:

```
┌──────────────────────────────────────────────┐
│ Scene 3 · 4s                       [✏️] [⋮]   │
│ A young girl climbs creaky stairs...          │
└──────────────────────────────────────────────┘
```

Scene number, duration badge, description (truncated to 1-2 lines), Edit and overflow-menu buttons. No prompt. No keyframe thumbnail. No clip thumbnail. No Generate buttons.

When OFF, the existing 5b/6 layout stands.

Toggling is per-storyboard, persisted via sessionStorage:

```ts
const [compactMode, setCompactMode] = useState(false);

useEffect(() => {
  if (!selectedStoryboardId) return;
  const saved = sessionStorage.getItem(`storyboard-compact-${selectedStoryboardId}`);
  setCompactMode(saved === 'true');
}, [selectedStoryboardId]);

useEffect(() => {
  if (selectedStoryboardId) {
    sessionStorage.setItem(`storyboard-compact-${selectedStoryboardId}`, String(compactMode));
  }
}, [compactMode, selectedStoryboardId]);
```

Per-scene expansion in compact mode: tapping a scene card's description (or a chevron) expands just that scene to full layout; tap again to recollapse. (Compact-mode-with-spot-expand. Useful when scanning 20+ scenes for a specific one to edit.)

### Part 7 — Insert scenes

In non-compact mode, between every pair of scenes (and above the first, and below the last), render a thin insertion affordance:

```
┌──────────────────────────────────────────────┐
│ Scene 1 · 4s                                  │
│ ...                                            │
└──────────────────────────────────────────────┘

  ┄┄┄┄┄┄ + Insert scene here ┄┄┄┄┄┄

┌──────────────────────────────────────────────┐
│ Scene 2 · 3s                                  │
└──────────────────────────────────────────────┘
```

Tap → opens the SceneEditModal in "create" mode (empty form, no scene to edit). On save, inserts a new scene at the tapped position. Position numbers shift for everything after.

`SceneEditModal` extends to support insert mode:

```ts
interface SceneEditModalProps {
  scene: StoryboardScene | null;          // null = create mode
  insertAtPosition?: number;              // required when scene is null
  // ... existing props
}
```

Create mode:
- `description` and `positivePrompt` are blank but required to save (can't insert an empty scene — must have at least description and prompt).
- `durationSeconds` defaults to 4.
- New scene gets a fresh cuid for `id`.
- `canonicalClipId` and `canonicalKeyframeId` start null.
- On save: build the full storyboard with the new scene inserted at `insertAtPosition`, all subsequent scenes' `position` values incremented by 1. PUT `/api/storyboards/[id]`.

In compact mode, the inter-scene insertion affordance is hidden (too cramped). Insertion happens via the storyboard-level "Add scene" button that appears at the bottom of the scene list:

```
[ + Add scene ]
```

This adds a scene at the end (`insertAtPosition: scenes.length`). Same modal flow.

### Part 8 — Reorder scenes

Drag-to-reorder via `@dnd-kit` — mirror the project clip strip pattern. `DndContext` + `SortableContext` wrap the scene list with `verticalListSortingStrategy`.

Each scene card gets a drag handle on the left (or top, in compact mode) — small grip icon, ≥44px tap target. Drag picks up the card; drop anywhere in the list reorders.

Optimistic update on the client: rearrange the scenes array in local state, recompute positions (0-indexed sequential), then PUT the storyboard. On PUT failure, revert and surface a brief error toast.

Reordering preserves all scene fields including `id`. The `Generation.sceneId` references are stable — clips and keyframes follow their scenes regardless of position.

In compact mode, the same drag-to-reorder works (the cards are smaller but the handle is still there). Useful for big-picture reorganization.

### Part 9 — Attach existing clip to scene

The canonical clip picker (5b's `CanonicalClipPickerModal`) gets a new section: "Attach an existing clip."

```
┌──────────────────────────────────────────────┐
│ Canonical clip — Scene 3                [×]   │
├──────────────────────────────────────────────┤
│ Clips generated from this scene:              │
│                                                │
│ <existing per-scene clips list>                │
│                                                │
│ ─────────────────────────────────────────     │
│                                                │
│ Or attach an existing clip:                    │
│                                                │
│ [ Pick from project ]   [ Pick from gallery ]  │
└──────────────────────────────────────────────┘
```

Two pickers:

**"Pick from project"** — opens a sub-modal listing all video clips in this project (including those already attached to other scenes — a clip can be attached to multiple scenes if useful). Layout matches the existing GalleryPicker but scoped to project clips. Tap a clip → that clip's id is written to the scene as `canonicalClipId` (PUT storyboard); also writes `sceneId` on the clip if not already set (or always overwrites — agent's design call). The picker closes.

**"Pick from gallery"** — opens the existing GalleryPicker but with the video filter selected. Same flow on tap. This allows attaching clips from other projects (they'll keep their `projectId` pointing at the original; only `sceneId` changes).

Important: when attaching, `Generation.sceneId` gets written. This means the clip will now show up in the scene's per-scene clip list on subsequent loads. Detaching: tap the canonical badge in the picker → clears `canonicalClipId` AND nullifies `sceneId` on the clip. (Or: a separate "Detach" button on the existing-clip row in the picker. Either UX is acceptable.)

For keyframe equivalent (Phase 6's `CanonicalKeyframePickerModal`): same treatment. "Attach an existing image" with the same two pickers. Filter the gallery picker to images for that one.

### Part 10 — Play canonical scenes

In the storyboard section header (or just below it), add a "Play canonical" button alongside the existing project-level "Play all" toggle:

```
[ ▶ Play canonical ]
```

Visibility:
- Hidden when the storyboard has fewer than 2 scenes with canonical clips.
- Shown when ≥2 scenes have resolved canonical clips (per `resolveCanonicalClipId`).

Tap → toggles the project's existing play-through view, but with `videoClips` replaced by the canonical-clip sequence:

```ts
const canonicalClipsInSceneOrder = storyboard.scenes
  .map((s) => resolveCanonicalClipId(s, clips))
  .filter((id): id is string => id !== null)
  .map((id) => clips.find((c) => c.id === id))
  .filter((c): c is ProjectClip => c !== undefined && c.mediaType === 'video');
```

Reuse the existing `<video>` player + clip chips + "Play again" UI from the project-level play-through. Just feed it a different array.

Differences from project-level "Play all":
- The chips are labeled "Scene 1", "Scene 2", etc., not "Clip 1, 2, 3".
- The header text shows "Scene N of M (canonical)" instead of "Clip N of M".
- A clip that's canonical for multiple scenes shows in the sequence multiple times (one chip per occurrence). Same clip, different scene contexts.

When toggled on, the project-level "Play all" toggle is hidden (only one play mode at a time). When toggled off, returns to whatever was before (linear strip or project-level play-through).

### Part 11 — Stitch canonical scenes

In the storyboard section header, add a "Stitch canonical" button alongside the existing project-level Stitch button:

```
[ 🪡 Stitch canonical ]
```

Visibility:
- Hidden when the storyboard has fewer than 2 scenes with canonical clips.
- Shown when ≥2 scenes have resolved canonical clips.

Tap → opens the existing `StitchModal` pre-populated with:
- The canonical clips in scene-position order, all checked
- The user can still uncheck individual clips before submitting (existing modal behavior; useful if a scene's canonical isn't yet good enough)
- The "Stitch" button on the modal submits to `POST /api/projects/[id]/stitch` with the explicit `clipIds` array (existing field from Phase 3.1)

The stitched output's `parentProjectId` is the project, same as today. There's no separate "stitched from storyboard" relationship — the stitch is a project-level artifact regardless of how clips were selected. If you want storyboard-stitch traceability later, that's its own batch.

The stitch modal needs no changes to support this — it already accepts a clipIds array. The "Stitch canonical" button just opens it with that array pre-populated.

### Part 12 — Migration of existing storyboard handlers

Every place in the codebase that reads `project.storyboard` (singular) becomes `project.storyboards.find((s) => s.id === selectedStoryboardId)`. This is the bulk of the diff in `ProjectDetail.tsx`.

`StoryboardGenerationModal` (5a): when generating from scratch, the modal needs to know which storyboard receives the result. Two cases:

- **First storyboard for a project** — modal creates a new storyboard and saves the LLM result to it.
- **Regenerate existing storyboard** — modal targets the active storyboard's id, replacing its scenes / storyIdea / generatedAt.

The modal accepts a `targetStoryboardId: string | null` prop. When null, POST to `/api/projects/[id]/storyboards` (create) then PUT scenes; when set, PUT to `/api/storyboards/[id]`.

`StoryboardGenerationModal`'s "Plan with AI" CTA from the empty state targets null (creates new). The "Regenerate" button targets the active storyboard's id.

Also: the empty state of the storyboard section needs adjusting. With multi-storyboard, "no storyboards yet" looks different from "have storyboards but the selected one is empty (just inserted scenes manually)". The empty state shows when `project.storyboards.length === 0`. When there's at least one storyboard but it has zero scenes, render the storyboard tab + an in-section "+ Add scene" or "Plan with AI" CTA. (The user might have created an empty storyboard via the "+" tab and now wants to fill it.)

### Part 13 — Update keyframe + chaining + remix paths

5b's `SceneTriggerContext` and Studio's apply-trigger don't change semantically — they still carry `sceneId`, `prompt`, `durationSeconds`, etc. But the resolution helpers (`resolveCanonicalClipId`, `resolveCanonicalKeyframeId`) now operate on a specific storyboard's scenes, so the calling code must pass the active storyboard.

5c's quick-generate inline path: same. The toggle is now per-storyboard (already on the schema); the handler reads it from the active storyboard.

Phase 6's keyframe batch button ("Generate keyframes (N needed)"): operates on the active storyboard's scenes. N is computed from those scenes' canonicals.

The cross-storyboard scenario: if Scene X exists in Storyboard A and the user generates a clip from it, then switches to Storyboard B, the clip is associated with Scene X's id (which exists in A, not B). Storyboard B doesn't see the clip. Correct behavior — clips belong to scenes via the soft sceneId reference, scenes belong to storyboards. No leakage.

### Part 14 — Clean up the singular `storyboard` field in API responses

`/api/projects/[id]` previously returned `project.storyboard: Storyboard | null`. Now returns `project.storyboards: Storyboard[]`. Update the type and remove all consumers of the singular form.

If any external consumer (shouldn't exist — single-user app) depended on the old shape, document the breaking change in PR description.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "model Storyboard" prisma/schema.prisma` shows the new model.
- `grep -n "storyboardJson" prisma/schema.prisma` returns nothing — column dropped.
- `npx prisma db push` applies cleanly. Existing storyboards migrate to rows.
- New routes exist and work: `POST /api/projects/[id]/storyboards`, `PUT /api/storyboards/[id]`, `DELETE /api/storyboards/[id]`, `POST /api/storyboards/[id]/reorder`.
- The old singular routes (`POST /api/projects/[id]/storyboard`, etc.) are removed; no live callers remain.
- ProjectDetail's storyboard section shows a tab strip when storyboards exist.
- Tapping a tab switches the rendered storyboard.
- "+" tab creates a new storyboard.
- Long-press on a tab opens Rename / Delete / Reorder menu.
- Compact toggle hides per-scene prompt + thumbnails; description-only view.
- Insert scene affordance creates new scenes at any position.
- Scene drag-to-reorder works; positions renumber; PUT persists.
- "Attach an existing clip" section in canonical clip picker; same in keyframe picker.
- "Play canonical" button visible when ≥2 scenes have canonical clips; plays them in scene order.
- "Stitch canonical" button visible under same condition; opens stitch modal pre-populated with canonical clip IDs.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet, full sequence):

1. **Migration.** Apply schema change. Confirm existing projects' storyboards (singular column) became Storyboard rows (Prisma Studio or `psql`). Confirm the JSON column is gone.
2. **Single-storyboard backwards compat.** Open a project that previously had one storyboard. Confirm it renders correctly under a single tab.
3. **Create second storyboard.** Tap "+". Name it "Alt take". Confirm it creates an empty storyboard, switches to it. Click "Plan with AI" → generates a fresh storyboard. Confirm it lands in the active tab, not the original.
4. **Switch tabs.** Tap the original tab. Confirm scenes from the original render (including all previously generated keyframes/clips). Tap "Alt take" again. Confirm the second storyboard's scenes render. Switch persists across reload.
5. **Rename.** Long-press a tab → Rename. Type a new name. Confirm tab updates.
6. **Delete.** Long-press → Delete. Confirm dialog. Confirm deletion. Tab disappears; switch falls through to next sibling. Project clips that were associated with the deleted storyboard's scenes remain (orphan sceneIds — checked via gallery).
7. **Reorder tabs.** Drag a tab to a new position. Confirm reorder persists.
8. **Compact toggle.** Toggle ON. Confirm all scenes show description-only. Toggle OFF — full layout returns. Per-storyboard, per-session.
9. **Per-scene spot expand in compact.** With compact ON, tap a scene's description. Confirm just that scene expands to full layout. Tap again to recollapse.
10. **Insert scene at position 0.** Tap "Insert scene here" above Scene 1. Confirm modal opens in create mode. Fill description + prompt. Save. Confirm new scene becomes Scene 1; existing scenes shift to 2, 3, 4...
11. **Insert scene at end.** Tap the "+ Add scene" button at the bottom of the scene list. Same flow.
12. **Reorder scenes.** Drag Scene 3 to position 1. Confirm the scenes renumber: old Scene 3 is now Scene 1; old Scenes 1 and 2 become 2 and 3. PUT persists; reload confirms.
13. **Attach project clip.** Open canonical clip picker for a scene with no clips. Tap "Pick from project". Confirm sub-modal lists project's video clips. Tap one. Confirm: the clip becomes that scene's canonical; closing the picker shows the clip's thumbnail on the scene card. Confirm via DB: `Generation.sceneId` was updated.
14. **Attach gallery clip from another project.** Same flow but tap "Pick from gallery". Pick a clip from a different project. Confirm: scene now references that clip; the clip's `projectId` stays pointing at its original project; the clip's `sceneId` updates to the new scene.
15. **Detach.** Open picker for a scene with an attached clip. Detach (tap badge or detach button). Confirm canonical resets; clip's sceneId nullifies.
16. **Attach existing keyframe.** Same as #13 but for keyframe picker. Filter to images.
17. **Play canonical.** With 3 scenes having canonical clips, tap "Play canonical". Confirm: player loads scene 1's canonical, plays through; auto-advances to scene 2's; etc. Chips show "Scene 1" / "Scene 2" / "Scene 3". "Play again" works.
18. **Play canonical hidden when insufficient.** With <2 canonical clips, button is hidden.
19. **Stitch canonical.** With 3 scenes having canonical clips, tap "Stitch canonical". Confirm: stitch modal opens with all 3 clips checked, in scene-position order. Submit. Confirm: stitched output appears in project's stitched-exports strip; `Generation.stitchedClipIds.selected` matches the canonical scene clips.
20. **Stitch canonical with deselect.** Same as #19 but uncheck Scene 2's canonical before submitting. Confirm: only scenes 1 and 3 stitch.
21. **Multi-storyboard isolation.** Switch between two storyboards. Confirm scenes, keyframes, clips, in-flight states, and quickGenerate toggles are independent per storyboard.
22. **Cross-storyboard clip scope.** Generate a clip from Storyboard A's Scene 5. Switch to Storyboard B. Confirm Scene 5 in B (different scene id) doesn't show that clip.
23. **Empty storyboard.** Create a new storyboard via "+". Don't generate scenes. Manually insert one via "+ Add scene". Confirm the manual scene works for keyframe and video generation. Confirm the storyIdea field is empty (no LLM ran).
24. **Disk-avoidance.** After heavy use: `ssh <gpu-vm> ls /models/ComfyUI/output/*.png` returns "no such file or directory."

---

## Out of scope

- **Storyboard duplication** ("clone this storyboard"). Could be a future feature; for first cut, regenerate or manually rebuild.
- **Cross-project storyboard linking.** Storyboards belong to one project.
- **Storyboard versioning** (history, undo, branching beyond multi-storyboard). Replace-on-regenerate within a single storyboard's scenes is still the model.
- **Storyboard export** (download as JSON / markdown). Out of scope.
- **Bulk scene operations** (delete multiple scenes, duplicate scene). Per-scene only.
- **Scene lineage tracking** (when a clip is generated from Scene X, then attached to Scene Y, track both). Single sceneId, last-write-wins.
- **Keyboard shortcuts for scene operations.** Tap-only.
- **Inserting a scene with auto-LLM expansion** ("LLM, write Scene 3.5 between these two"). Iterative LLM editing is post-Phase-6.
- **Storyboard-level batch attach** ("attach the project's clips to scenes by some heuristic"). One scene at a time.
- **Auto-generating storyboards across multiple projects** or templates. Out of scope.
- **A "stitched from storyboard X" relationship on stitched outputs.** Stitch is a project artifact; users who care about provenance can name their stitches accordingly.
- **Sharing or exporting a storyboard separately from its project.** Storyboards always live within a project.

---

## Documentation

In CLAUDE.md, replace the existing Phase 5a section's storage description ("storyboards live as `Project.storyboardJson`") with:

> **Storyboards are relational.** A project has zero or more `Storyboard` rows (cascade-delete with project). Each storyboard owns its own `scenesJson` (StoryboardScene[]), `storyIdea`, `quickGenerate` toggle, and tab `position`. The previous `Project.storyboardJson` column was migrated and dropped.

Add a Phase 5d section under the Phase 5c / Phase 6 sections:

> ## Phase 5d — Multi-storyboard + scene management + canonical playback/stitch
>
> **Multiple storyboards per project.** ProjectDetail's storyboard section gains a tab strip. Each tab is an independent storyboard with its own scenes, quick-generate toggle, and in-flight states. Tabs persist via sessionStorage per project.
>
> **Scene management.** Per-scene drag-to-reorder. Insert-scene affordances between scenes (full mode) or "+ Add scene" button (compact mode). Compact toggle (per-storyboard, sessionStorage-persisted) hides per-scene prompt and thumbnails; useful for navigating 20+ scene scripts. Per-scene spot-expand within compact mode.
>
> **Attach existing clip / keyframe.** Canonical pickers gain "Attach an existing clip" and "Attach an existing image" sub-modals. "Pick from project" lists project clips; "Pick from gallery" opens the gallery picker. Attaching writes `Generation.sceneId` on the clip; canonical points at it.
>
> **Play canonical / Stitch canonical.** Sibling buttons to project-level Play all / Stitch. Operate on the storyboard's canonical-clip sequence in scene-position order. Reuse the existing player + stitch modal infrastructure; pass `clipIds` accordingly.

In the source layout, add:
- `prisma/schema.prisma`'s new `Storyboard` model (replacing `Project.storyboardJson`).
- New routes: `POST /api/projects/[id]/storyboards`, `PUT /api/storyboards/[id]`, `DELETE /api/storyboards/[id]`, `POST /api/storyboards/[id]/reorder`.
- Migration script: `scripts/migrate-storyboard-to-relational.ts`.
- ProjectDetail's storyboard section is now multi-tab; the rest of the storyboard infrastructure (per-scene cards, modals, in-flight tracking) operates within an active-tab scope.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
