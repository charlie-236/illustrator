# Batch — Project generation flow (Phase 2.2)

Second half of Phase 2. After this batch, you can generate a new clip from within a project, the form pre-fills with the project's defaults and the previous clip's prompt, you can opt to use the previous clip's last frame as the next i2v starting frame, and you can preview the project's clips back-to-back via a play-through toggle.

Re-read CLAUDE.md and the Phase 2.1 PR before starting. Specifically: confirm the schema and routes match what 2.1 shipped (the `Generation.projectId` and `Generation.position` fields, the `Project` model and its `default*` fields).

This batch installs ffmpeg as a dependency. ffmpeg is the right tool here for the same reason it's the right tool for Phase 3 — installing it now means no setup work later.

---

## What to build

### 1. ffmpeg installation

Add ffmpeg as a system dependency. The project already runs on a Linux mint-pc; install via `apt-get` if it isn't there. Add a check in the existing setup/bootstrap pattern (whatever exists — `package.json` postinstall, a setup script, or just a section in CLAUDE.md telling the user to install it manually).

If the agent finds no clean place to put a system install, document the manual install:

```bash
sudo apt-get install -y ffmpeg
ffmpeg -version  # confirm
```

…in CLAUDE.md, in a new "System dependencies" section. The agent's call.

### 2. Last-frame extraction endpoint

**`POST /api/extract-last-frame`**

Request:
```ts
{ generationId: string }
```

Implementation:
1. Look up the generation row, confirm `mediaType === 'video'`, get `localPath`.
2. Run ffmpeg to extract the last frame as a PNG:
   ```
   ffmpeg -sseof -0.1 -i <localPath> -update 1 -q:v 1 -frames:v 1 -f image2 -
   ```
   The `-sseof -0.1` seeks 0.1 seconds before the end (more reliable than seeking to exact end). `-update 1 -frames:v 1` writes a single image. Output to stdout; capture as a Buffer.
3. Base64-encode the PNG buffer.
4. Return `{ frameB64: string }` (data URI, including the `data:image/png;base64,` prefix — easier for the client to paste into Studio's existing starting-frame state).

Use Node's `child_process.execFile` (not `spawn` with shell) to avoid shell-injection. Validate that `localPath` doesn't contain `..` even though it comes from the DB (defense in depth).

Error handling: ffmpeg failure → 500 with the stderr captured. Generation not found or wrong media type → 404 / 400.

Don't write the frame to disk. Stdout-only.

### 3. Project-aware Studio entry

When the user clicks "Generate new clip in this project" from a project detail view, the Studio tab opens with:

- Mode toggle set to **Video**.
- Form pre-filled with the project's defaults (`defaultFrames`, `defaultSteps`, `defaultCfg`, `defaultWidth`, `defaultHeight`). Where the project doesn't have a default for a field, fall back to the Wan 2.2 baseline (the existing video-mode defaults).
- Project context badge in the Studio header: a small pill showing "Project: [name]" with a × to clear (clearing returns Studio to project-less mode and the form keeps current values, doesn't reset).
- If the project has at least one existing clip, the Studio prompt textarea pre-fills with the latest clip's prompt (Q4 (b) — "carry forward").
- If the project has at least one existing clip, a checkbox appears below the starting-frame toggle: **"Use last frame of previous clip"**.
  - Checked → starting-frame mode is `i2v`, the picker is disabled (the source is fixed), and on submit the client calls `/api/extract-last-frame` for the project's latest clip and uses the returned base64 as the starting frame.
  - Unchecked → user can use the existing manual gallery picker, or no starting frame at all.
  - This checkbox replaces the manual gallery picker UI when checked. When unchecked, the existing picker UX from 1.2a returns.

The "Project: [name]" badge persists across page refresh via sessionStorage (or whatever mechanism Studio uses for mode toggle persistence — match it). If the user closes Studio and reopens, the project context survives until explicitly cleared.

### 4. Submit-time logic

When the Studio form submits in video mode with a project context:

1. If "Use last frame of previous clip" is checked: client fetches `/api/extract-last-frame` for the previous clip, gets the base64, sets the form's starting-image state.
2. POST `/api/generate-video` with body extended by:
   ```ts
   {
     projectId: string,
     // ... existing fields ...
   }
   ```
3. The route persists `projectId` on the resulting `Generation` row, computes `position` as `max(position) + 1` for that project (or `1` if no clips yet), and stores it.
4. On completion, the new clip appears in the project's linear strip in the next-position slot.

Update `/api/generate-video`'s validation: `projectId`, if present, must reference an existing project. If not, 400. Don't accept arbitrary strings.

### 5. Play-through toggle

In the project detail view's linear strip, add a "Play through" button (icon: play, or play+chain — the agent's design call) at the top of the strip area, next to whatever existing controls live there.

**Default state:** linear strip view (Phase 2.1 layout).

**Activated state:** the strip is replaced by a single full-width video player. The player chains the project's clips:

- Plays clip 1 from start to end.
- On `ended`, immediately loads clip 2's `src` and plays.
- Continues through all clips.
- Final clip ends → player shows a "Play again" button.

Implementation:
- Single `<video>` element. On the element's `ended` event, the player advances to the next clip's path and calls `play()`.
- Show clip index ("Clip 3 of 7") below the player.
- Clip selector chips below the player (1, 2, 3, …, N) — click any to jump directly to that clip.
- Native HTML5 controls on the player.
- Toggling "Play through" off returns to the linear strip view.

Edge cases:
- Project with one clip: hide the play-through toggle (linear strip is the same thing).
- Project with zero clips: hide the play-through toggle.

The audio gap consideration: Wan 2.2 generates no audio so the click-between-clips problem doesn't surface yet. When/if it does (Phase 3+ or a future audio-capable model), we transcode at stitch time. Don't try to solve client-side; the play-through is a preview, not a finished product.

### 6. Project context cleared by remix

Existing remix-into-Studio flow (Phase 1.3): clicking remix on a gallery clip loads its params into Studio. After this batch, that flow does **not** preload project context — remixing always opens Studio in project-less mode.

Reasoning: remix is "use this clip as a starting point for a new generation," which conceptually breaks the project lineage. If the user wants to add a remix to the project, they navigate to the project view and click "Generate new clip" instead.

If during smoke testing this feels wrong (remixing within a project should keep the project context), file a follow-up. Current call: clean separation between remix and project flows.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- ffmpeg is callable from the application's runtime environment (`ffmpeg -version` works).
- `/api/extract-last-frame` returns a valid PNG data URI for a video generation.
- "Generate new clip in this project" is no longer disabled. Clicking it navigates to Studio with project context loaded.
- The project context badge in Studio's header shows the project name and is dismissible.
- The video form pre-fills with the project's defaults (with Wan 2.2 fallback for unset fields).
- The prompt textarea pre-fills with the latest clip's prompt when the project has at least one clip.
- The "Use last frame of previous clip" checkbox appears only when the project has at least one clip and the user is in video mode with a project context.
- Submitting with the checkbox checked extracts the last frame and uses it as the i2v starting image.
- The new clip is persisted with the correct `projectId` and `position`.
- The "Play through" toggle works on a project with multiple clips; it's hidden on projects with 0 or 1 clips.
- Remix from gallery does not preload project context.

Manual smoke test (deferred to user):

1. Create a project with default frames=81, default cfg=4.0. Save. Click "Generate new clip in this project."
2. Confirm Studio opens in video mode. Confirm the form shows frames=81, cfg=4.0. Confirm the project badge is visible in the header.
3. Type a prompt, click Generate. Confirm a clip is created. Wait for completion.
4. Return to the project detail view. Confirm the new clip is in the strip in position 1.
5. Click "Generate new clip" again. Confirm the prompt pre-fills with what you just used.
6. Check the "Use last frame of previous clip" checkbox. Confirm the gallery picker is hidden/disabled. Type a slightly different prompt. Click Generate. Confirm the last-frame extraction call fires (check network tab) and returns a base64 PNG. Confirm the resulting video starts visually where the previous one ended.
7. Once you have 3+ clips, click "Play through." Confirm the strip is replaced by a single player. Confirm clips advance automatically. Confirm the clip-index chips work. Toggle off — confirm strip returns.
8. Clear the project context via the × on the badge. Confirm the form values stay (don't reset). Generate a clip — confirm it goes into project-less state (no `projectId`).
9. Remix a clip from the gallery while in project-less mode. Confirm Studio doesn't pick up project context.
10. From a project detail view with clips, navigate to the gallery. Confirm the project clips show "Project: [name]" in the modal sidebar.

---

## Out of scope

- Per-clip override of project defaults at the project level. The project has one default set; if user wants different params per clip, they edit at submit time.
- Move-clip-between-projects UX. Out of scope.
- Project clip filtering or search. Out of scope.
- Project export / FFmpeg stitching to a single mp4. Phase 3.
- Take system (multiple takes per clip slot, pick best). Phase 4.
- Planner / storyboard. Phase 5+.
- Last-frame extraction caching. The ffmpeg call is fast (<1s); don't bother caching extracted frames. If it ever feels slow we can.
- Last-frame extraction for non-final clips. The "carry forward last frame" feature uses *latest* clip's last frame only. If user wants to branch from clip 3 of 8, they remix. Don't build a "extract last frame from arbitrary clip" UI.
- Project context surviving full app navigation away from Studio (e.g. to the Models tab and back). sessionStorage persistence is what we have; no further plumbing.
- A "default starting frame" set at the project level. Out of scope; the last-frame-of-previous-clip feature handles the natural use case.
- Better play-through audio gap handling. Wan 2.2 has no audio.
- Crossfade transitions between clips during play-through. That's stitching territory (Phase 3).

---

## Documentation

In CLAUDE.md's Projects section (added by 2.1), add subsections:

- **Project-aware generation:** the entry-point button, the project context badge, the form pre-fill behavior.
- **Prompt threading:** carry-forward (latest clip's prompt) and last-frame extraction.
- **Play-through preview:** description, single-player implementation, audio-gap caveat.
- **System dependency:** ffmpeg, why we need it (last-frame extraction now, stitching in Phase 3).

Find the API routes table. Add `POST /api/extract-last-frame` and update `/api/generate-video` to mention the new optional `projectId` field.

When done, push and create the PR via `gh pr create` per AGENTS.md. Include a screenshot of Studio with project context active and the "Use last frame" checkbox visible, and confirmation that the play-through plays a 3-clip project end-to-end.
