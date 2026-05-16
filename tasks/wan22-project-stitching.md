# Batch — Project stitching (Phase 3)

Stitches a project's clips into a single mp4 file, output to the unified Gallery as a new `Generation` row. Hard-cut by default; optional crossfade transitions. No audio. ffmpeg runs on mint-pc against local clip files; VM doesn't enter the picture.

After this batch, the user can open a project, click Stitch, and produce a shareable mp4 of the assembled clips in `position` order.

Re-read CLAUDE.md before starting.

---

## What to build

### 1. Schema additions to `Generation`

```prisma
model Generation {
  // ... existing fields ...
  isStitched       Boolean   @default(false)
  parentProjectId  String?
  parentProject    Project?  @relation("StitchedFromProject", fields: [parentProjectId], references: [id], onDelete: SetNull)
  stitchedClipIds  String?   // JSON array of generation IDs that were combined, for traceability
}

model Project {
  // ... existing fields from Phase 2.1 ...
  stitchedExports  Generation[] @relation("StitchedFromProject")
}
```

Notes:
- `isStitched: false` for all existing rows. Default keeps the rest of the codebase unaware.
- `parentProjectId` is nullable; deleting the source project doesn't delete the stitched output (`onDelete: SetNull`). The stitched file lives on as a regular gallery video, just unattached.
- `stitchedClipIds` as a JSON-encoded string array (e.g. `'["cuid1","cuid2","cuid3"]'`). Don't normalize into a join table — single-user app, this is dead simple lookup, the join table is overkill.

Generate a migration named `add_stitched_exports`. Test that `npx prisma migrate dev` runs cleanly.

### 2. ffmpeg stitch helper

`src/lib/stitch.ts` — new file. Single exported function:

```ts
export async function stitchProject(params: {
  generationId: string;       // for the output filename and DB row
  clipPaths: string[];        // ordered local paths of the source clips
  outputPath: string;         // where to write the stitched mp4
  transition: 'hard-cut' | 'crossfade';
  onProgress?: (frame: number, totalFrames: number) => void;
}): Promise<{ width: number; height: number; durationSeconds: number; frameCount: number }>;
```

Implementation:

**Hard-cut path:**

ffmpeg's concat demuxer. Write a temporary concat list:
```
file '/path/to/clip1.webm'
file '/path/to/clip2.webm'
file '/path/to/clip3.webm'
```

Run:
```
ffmpeg -f concat -safe 0 -i <list-file> -c:v libx264 -pix_fmt yuv420p -preset medium -crf 18 -movflags +faststart -an <output>
```

`-an` strips audio (clips have none anyway, but defensive). `-movflags +faststart` puts the moov atom at the start so the file is streamable in the browser. `-pix_fmt yuv420p` ensures broad compatibility.

The concat demuxer requires identical codec/resolution/framerate across inputs. All Wan 2.2 outputs at the same resolution are compatible; the project flow lets users mix resolutions in Phase 2 (different clips at different dimensions). If clip resolutions/framerates differ, the concat demuxer fails with a stream-mismatch error. Handle this case explicitly:

1. Inspect clip metadata via `ffprobe` (already on mint-pc with ffmpeg).
2. If all clips share resolution and framerate → concat demuxer (fast path).
3. If they differ → concat filter with explicit scaling and framerate normalization (slower but works):

```
ffmpeg -i clip1.webm -i clip2.webm -i clip3.webm \
  -filter_complex "[0:v]scale=1280:704,fps=16,setsar=1[v0];[1:v]scale=1280:704,fps=16,setsar=1[v1];[2:v]scale=1280:704,fps=16,setsar=1[v2];[v0][v1][v2]concat=n=3:v=1:a=0[outv]" \
  -map "[outv]" -c:v libx264 -pix_fmt yuv420p -preset medium -crf 18 -movflags +faststart <output>
```

The target resolution and framerate for the slow path: use the first clip's. Don't add a "target resolution" parameter to the helper — the heuristic of "match the first clip" is right 95% of the time and avoids a configuration surface.

**Crossfade path:**

Use the `xfade` filter. Crossfade duration: 0.5s. With N clips and 0.5s overlaps, the timeline computation gets fiddly. The xfade filter takes an `offset` parameter (when the transition starts in the first input's timeline). For chained crossfades:

```
ffmpeg -i clip1.webm -i clip2.webm -i clip3.webm \
  -filter_complex "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=<dur1-0.5>[v01];[v01][2:v]xfade=transition=fade:duration=0.5:offset=<dur1+dur2-1.0>[outv]" \
  -map "[outv]" -c:v libx264 -pix_fmt yuv420p -preset medium -crf 18 -movflags +faststart -an <output>
```

The offset for each subsequent crossfade compounds: it's the cumulative duration up to that point minus the cumulative crossfade overlaps. Compute via `ffprobe` on each clip first to get individual durations, then build the filter graph string programmatically.

Where source clip resolutions differ in the crossfade path: pre-scale via `[0:v]scale=W:H,fps=F[v0]; [1:v]scale=W:H,fps=F[v1]; ...` and feed the scaled streams into xfade. Same target dimensions as the hard-cut slow path (first clip's).

**Progress reporting.**

ffmpeg writes progress lines to stderr in `-progress pipe:2` format if you ask for it. Add `-progress pipe:2 -nostats` to the command. Parse lines like `frame=42` and `progress=continue` / `progress=end`. Convert `frame=N` to a (frame, totalFrames) tuple by knowing the expected total: sum of source clips' frame counts (minus crossfade overlap frames if applicable, computed as `0.5 * fps * (clipCount - 1)`).

`onProgress` callback fires every parsed frame line (or every 30 lines, throttled — the agent's call). The callback is what the SSE stream uses to push progress to the client.

**Spawn, don't shell-execute.** Use `child_process.spawn` with the args as an array. Never interpolate paths into a shell-string command — clip filenames are user-prompt-derived and could contain quotes or spaces.

**Cleanup.** Delete the temporary concat list file when done (in a `finally`). The output mp4 stays at `outputPath`.

### 3. Stitch endpoint

**`POST /api/projects/[id]/stitch`**

Request:
```ts
{
  transition: 'hard-cut' | 'crossfade';
}
```

Response: SSE stream, mirrors `/api/generate-video`'s shape so the queue UX consumer reuses it without modification.

Implementation:

1. Validate the project exists and has at least 2 clips. (One-clip projects: stitching is a no-op, return 400 with "Need at least 2 clips to stitch.")
2. Generate a `cuid` for the output `Generation` row.
3. Compute output path. Match the existing image-path filename convention (likely `{slug}_{timestamp}.mp4` in the gallery storage directory — verify by reading the existing image storage helper).
4. Insert a pending `Generation` row: `mediaType: 'video'`, `isStitched: true`, `parentProjectId: <id>`, `stitchedClipIds: <JSON.stringify(orderedClipIds)>`, prompt = `"Stitched: " + project.name`, frames/fps/dimensions filled in once stitching finishes (set placeholder zeros for now — finalization updates them).
5. Register a job in the comfyws manager. Reuse the queue infrastructure built in Phase 1.2b — the stitch is a "job" with progress events, completion, and abort.

   New `mediaType` on the job: `'stitch'`. The completion notification chain (chime + toast + browser notification) fires the same way. The queue-tray row shows the project name as the prompt summary.

6. Spawn ffmpeg via `stitchProject`. Stream progress events to SSE.
7. On completion: update the `Generation` row with the final dimensions, frame count, fps. Send the SSE final event with the generation ID.
8. On error: update the row to a failed state (or delete it — match the existing image-path error handling), stream error to SSE, return.

Watchdog timeout: 5 minutes. Stitching is much faster than generation (no GPU); even a 30-clip project completes in seconds for hard-cut, maybe a minute for crossfade. 5 minutes is generous.

**Abort handling:** the queue-tray abort button calls the existing abort endpoint, which now needs to handle `'stitch'` jobs. For stitch jobs, abort kills the ffmpeg child process (`process.kill('SIGTERM')`). Add a `'stitch'` branch to whatever the abort path is in comfyws. The partial output file is left at `outputPath`; delete it in the abort handler.

### 4. Stitch button + modal

In the project detail view (Phase 2.1), add a "Stitch" button to the header. Position: next to the play-through toggle. Disabled if the project has fewer than 2 clips, with a tooltip explaining.

Click → opens a small modal:

- Title: project name
- Summary: "Stitching N clips, total duration X.Xs"
- Transition selector: radio group, "Hard cut" (default) / "Crossfade (0.5s)"
- "Stitch" button (primary)
- "Cancel" button

Click Stitch → POST to `/api/projects/[id]/stitch` with the chosen transition, modal closes, the queue tray shows the new stitch job. Studio's existing form-doesn't-block behavior applies — the user can navigate away, generate other things, etc., and the stitch progresses in the background.

### 5. Gallery integration

When viewing a stitched generation in the Gallery modal:

- Sidebar shows "Stitched from project: [project name]" with a link back to the project detail view (or "Project: None (project deleted)" if `parentProjectId` is null but `isStitched` is true).
- Sidebar shows "Source clips: N" with the list of clip IDs (or thumbnails — agent's call, but list of IDs is fine for Phase 3; thumbnail row would be polish).

The tile in the gallery grid: render with a small "stitched" badge (corner pill, similar to the duration badge but in a different position or color). This makes stitched outputs distinguishable at a glance from raw clips.

Add to the All/Images/Videos filter: stitched outputs count as videos. No new filter for "stitched only" yet — defer until you have enough stitched outputs to warrant filtering.

### 6. Project detail view: show stitched exports

In the project detail view, below the linear strip, add a small section: "Stitched exports" with a horizontal row of thumbnails (or just a count + "View latest" link if more than ~3 exist).

This makes the export history visible from the project view without forcing the user to hunt in the gallery for "what did I export from this project."

If zero stitched exports: section is hidden entirely.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- Migration `add_stitched_exports` applies cleanly. Existing rows have `isStitched: false`.
- ffmpeg is invoked via `child_process.spawn` with array args, never shell-string.
- The Stitch button is visible on project detail views with 2+ clips.
- The stitch modal offers Hard cut and Crossfade transition options.
- Submitting the modal POSTs to `/api/projects/[id]/stitch` and adds a job to the queue tray.
- The queue tray's notification chain (chime + toast + browser notification) fires on stitch completion.
- The stitched output appears in the gallery as a video, with the stitched badge.
- The gallery modal sidebar shows the source project link for stitched outputs.
- The project detail view shows stitched exports section when there's at least one export.
- Aborting a stitch via the queue tray kills the ffmpeg process and removes the partial output.
- Deleting the source project leaves the stitched outputs alone (just nulls out `parentProjectId`).

Manual smoke test (deferred to user):

1. Open a project with 3 clips at the same resolution. Click Stitch. Pick hard cut. Confirm the queue tray shows a stitch job, completes within seconds, the stitched mp4 appears in the gallery.
2. Open the stitched output in the gallery modal. Confirm the source project link works. Confirm playback is smooth (no glitches at clip boundaries; that's the test of the concat demuxer fast path).
3. Stitch the same project with crossfade. Confirm the transitions are visibly faded, not hard cuts. Confirm the output is shorter by `(N-1) * 0.5s` (crossfade overlap).
4. Mix clip resolutions: add a 768×768 clip to a project that has 1280×704 clips. Stitch with hard cut. Confirm the slow path kicks in (probably noticeable as 2-3x longer wall time) and produces a coherent output (the smaller clip gets scaled or letterboxed depending on ffmpeg's default).
5. Stitch a 10-clip project. Confirm progress events arrive in the queue tray during stitching.
6. Start a stitch, click Abort in the queue tray. Confirm the ffmpeg process dies (check `ps` on mint-pc), the partial mp4 is gone, the gallery has no orphan generation row.
7. Delete the source project. Confirm the stitched output stays in the gallery and the modal sidebar shows "Project: None (project deleted)".
8. Try to stitch a project with one clip. Confirm the Stitch button is disabled with a tooltip.
9. Generate a new clip in a different tab (image or video) while a stitch is running. Confirm both jobs proceed concurrently in the queue tray and both complete successfully.

---

## Out of scope

- Audio. No audio track on output. Confirmed.
- Per-clip transition customization (different transition between clip 2-3 vs clip 4-5). Out of scope. The whole-project transition is the only knob.
- Other transition types (wipe, slide, dissolve). Crossfade is the only non-cut option.
- Output format choice (webm/mov/etc.). mp4/h264 only.
- Output resolution override. Match the first clip.
- Output codec / bitrate / quality customization. Single quality preset (CRF 18, medium preset).
- Re-stitch / replace UX (overwrite a previous stitched output). Always creates a new gallery entry. User deletes old ones manually.
- Trimming or chopping clips before stitching. Phase 4+ if ever.
- Subtitle / caption overlays. Out of scope.
- Watermarks. Out of scope.
- A "stitched only" filter in the gallery. Defer.
- Thumbnail-grid view of source clips in the gallery sidebar (instead of just an ID list). Polish; defer.
- Stitching across multiple projects. Out of scope; user can copy clips into a new project if they want a multi-project compilation.
- Re-encoding settings panel. Out of scope.
- Two-step stitch (preview then commit). Just commits.
- Don't try to use GPU-accelerated ffmpeg encoding. CPU h264 is fast enough.

---

## Documentation

In CLAUDE.md, add a new section "Project stitching (Phase 3)":

- Describe the schema additions (`isStitched`, `parentProjectId`, `stitchedClipIds`).
- Describe the stitch flow: button → modal → queue job → gallery output.
- Note that stitching runs entirely on mint-pc (no VM involvement).
- Note the ffmpeg fast-path / slow-path heuristic for resolution mismatch.
- Note that stitched outputs survive source project deletion.

Find the API routes table and add `POST /api/projects/[id]/stitch`.

Find the source layout and add `src/lib/stitch.ts`.

When done, push and create the PR via `gh pr create` per AGENTS.md. Include in the PR description: the wall-clock for a 3-clip hard-cut stitch and a 3-clip crossfade stitch, output file size for both, and confirmation that the abort path leaves no orphan files.
