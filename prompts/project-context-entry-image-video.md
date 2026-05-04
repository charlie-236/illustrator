# Batch — Project context entry has image and video options

Project Detail's "Generate new clip" button unconditionally opens Studio in video mode. There's no equivalent "Generate new image in this project" entry. To put a new image in a project from the project view, the user has to enter video mode, then manually switch to image mode in Studio. Project context inheritance works for both modes (per the image-project-inheritance batch), but the entry experience treats video as the primary path.

The project model has broadened. Projects are general containers for creative output: today they hold images and video clips; Phase 5 will add JSON storyboards as project members; future phases add long-form stories and prompt roleplay. The "Generate new X in this project" surface should reflect what's available now (image + video) and be ready to extend later.

This batch adds an image-mode entry alongside the existing video-mode entry. Future phases will add more entry types as new generation surfaces ship.

Re-read CLAUDE.md before starting.

---

## Required changes

### `src/types/index.ts` — extend `ProjectContext`

`ProjectContext` (the trigger payload from Projects → Studio) currently has no mode field. Add one:

```ts
export interface ProjectContext {
  projectId: string;
  projectName: string;
  mode: 'image' | 'video';   // NEW — which Studio mode to open
  latestClipId: string | null;
  latestClipPrompt: string | null;
  latestClipMediaType: string | null;
  latestClipFilePath: string | null;
  defaults: {
    frames: number | null;
    steps: number | null;
    cfg: number | null;
    width: number | null;
    height: number | null;
    lightning: boolean | null;
    videoLoras: WanLoraSpec[] | null;
  };
}
```

The `defaults` block stays as-is — it's video-shaped today; image-mode entry consumes only `width`/`height` and ignores the rest. (If/when image-side project defaults become a thing, they get their own block under `defaults` — but that's out of scope here.)

### `src/components/ProjectDetail.tsx` — two-button entry

Find the existing "Generate new clip" button. Replace with two buttons of equal visual weight, side by side or stacked depending on layout fit. Tablet-friendly (44–48px touch targets):

```tsx
<div className="flex gap-2">
  <button
    onClick={() => onGenerateInProject(project, latestClip, 'image')}
    className="..."  // match existing button styling
  >
    Generate image
  </button>
  <button
    onClick={() => onGenerateInProject(project, latestClip, 'video')}
    className="..."  // same styling
  >
    Generate clip
  </button>
</div>
```

Both buttons use the same visual treatment — they're equal options, not primary/secondary. Match the existing single-button styling exactly.

If the layout has limited horizontal space on narrow tablets, stack vertically. If the existing button has an icon, both buttons get matching mode-appropriate icons (image icon for "Generate image"; video icon for "Generate clip"); otherwise neither does.

The `latestClip` argument continues to come from the same source the existing button uses. The `'clip'` terminology in the button label matches the gallery filter taxonomy ("Clips" = unstitched videos).

### `src/components/ProjectDetail.tsx` — `Props.onGenerateInProject` signature widens

```ts
onGenerateInProject: (
  project: ProjectDetail,
  latestClip: ProjectClip | null,
  mode: 'image' | 'video',
) => void;
```

### `src/app/page.tsx` — `handleGenerateInProject` accepts mode

```ts
const handleGenerateInProject = useCallback((
  project: ProjectDetail,
  latestClip: ProjectClip | null,
  mode: 'image' | 'video',
) => {
  const context: ProjectContext = {
    projectId: project.id,
    projectName: project.name,
    mode,                                       // NEW
    latestClipId: latestClip?.id ?? null,
    latestClipPrompt: latestClip?.prompt ?? null,
    latestClipMediaType: latestClip?.mediaType ?? null,
    latestClipFilePath: latestClip?.filePath ?? null,
    defaults: {
      frames: project.defaultFrames,
      steps: project.defaultSteps,
      cfg: project.defaultCfg,
      width: project.defaultWidth,
      height: project.defaultHeight,
      lightning: project.defaultLightning ?? null,
      videoLoras: project.defaultVideoLoras ?? null,
    },
  };
  setProjectContextTrigger(context);
  setTab('studio');
}, []);
```

### `src/components/Studio.tsx` — apply-trigger respects mode

The `useEffect` consuming `projectContextTrigger` currently switches to video mode unconditionally. Branch on `projectContextTrigger.mode`:

```ts
useEffect(() => {
  if (!projectContextTrigger) return;

  setProjectContext(projectContextTrigger);
  saveSessionProjectContext(projectContextTrigger);

  if (projectContextTrigger.mode === 'video') {
    // Existing video-mode setup
    setMode('video');
    setLastVideoResults([]);  // or setVideoResult(null) if H4 hasn't landed yet
    setSubmitError(null);

    setVideoP({
      frames: projectContextTrigger.defaults.frames ?? VIDEO_DEFAULTS.frames,
      steps: projectContextTrigger.defaults.steps ?? VIDEO_DEFAULTS.steps,
      cfg: projectContextTrigger.defaults.cfg ?? VIDEO_DEFAULTS.cfg,
      width: projectContextTrigger.defaults.width ?? VIDEO_DEFAULTS.width,
      height: projectContextTrigger.defaults.height ?? VIDEO_DEFAULTS.height,
    });

    if (projectContextTrigger.defaults.lightning !== null && projectContextTrigger.defaults.lightning !== undefined) {
      setLightningAndPersist(projectContextTrigger.defaults.lightning);
    }
    if (projectContextTrigger.defaults.videoLoras) {
      const entries = projectContextTrigger.defaults.videoLoras.map((s) => ({ loraName: s.loraName, weight: s.weight }));
      setVideoLorasAndPersist(entries);
    }

    try { sessionStorage.setItem('studio-mode', 'video'); } catch { /* ignore */ }
  } else {
    // NEW image-mode setup
    setMode('image');
    setLastImageRecords([]);
    setSubmitError(null);

    // Pre-fill image dimensions from project defaults if set, otherwise leave whatever's there
    if (projectContextTrigger.defaults.width !== null || projectContextTrigger.defaults.height !== null) {
      setP((prev) => ({
        ...prev,
        ...(projectContextTrigger.defaults.width !== null ? { width: projectContextTrigger.defaults.width } : {}),
        ...(projectContextTrigger.defaults.height !== null ? { height: projectContextTrigger.defaults.height } : {}),
      }));
    }
    // Don't apply Lightning, video LoRAs, frames/steps/cfg — those are video-only

    try { sessionStorage.setItem('studio-mode', 'image'); } catch { /* ignore */ }
  }

  // Carry forward latest clip's prompt regardless of mode
  if (projectContextTrigger.latestClipPrompt) {
    setP((prev) => ({ ...prev, positivePrompt: projectContextTrigger.latestClipPrompt! }));
  }

  onProjectContextTriggerConsumed();
}, [projectContextTrigger, /* keep existing deps */]);
```

For image-mode entry: the project's `defaultWidth`/`defaultHeight` are stored as Wan-friendly values (e.g. 1280×704). Image generations can use any dimensions; if a user feels the project defaults aren't right for image, they adjust in Studio. Don't translate or mangle.

The "Choose starting frame" button (per Phase 2.3 follow-up bundle) is video-only — already in the video-only section of Studio, automatically hidden in image mode.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "mode:" src/types/index.ts` shows the new field on `ProjectContext`.
- ProjectDetail's "generate" UI shows two buttons: "Generate image" and "Generate clip".
- `handleGenerateInProject` in `src/app/page.tsx` accepts a `mode` parameter and propagates it to the trigger.
- Studio's apply-trigger effect branches on `projectContextTrigger.mode` (`grep -n "projectContextTrigger.mode" src/components/Studio.tsx` shows the branch).
- Tapping "Generate image" in a project opens Studio in image mode with the project context badge active.
- Tapping "Generate clip" opens Studio in video mode (existing behavior preserved).
- A new image generation submitted while in this image-mode-with-project-context inherits the project (per existing image-project-inheritance plumbing).
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. Open a project with mixed images and clips. Confirm two buttons: "Generate image" and "Generate clip".
2. Tap "Generate image". Confirm Studio opens in image mode, project badge visible, prompt pre-filled from the latest clip if any.
3. Generate. Confirm the new image appears in the project's strip at the end (position auto-incremented).
4. Tap "Generate clip" from the same project. Confirm Studio opens in video mode, project badge visible, defaults pre-filled.
5. Generate a video. Confirm it joins the project too.
6. From an empty project (no clips), tap each button. Confirm prompt is empty, no errors, project badge still active.
7. Confirm the project's video-shaped defaults (lightning, videoLoras, frames/steps/cfg) are applied only when entering video mode. Image mode picks up only width/height if those are set.
8. Open the gallery. Confirm the new image and new clip both show project membership in the modal sidebar.

---

## Out of scope

- New entry types for Phase 5 (JSON storyboards) or future long-form stories / prompt roleplay. Add those when their batches land. The two-mode entry is the right shape now; the trigger payload is extensible.
- Image-side project defaults (default checkpoint, default LoRA stack, default sampler for image). The `Project` schema only has video defaults today; adding image defaults is its own batch when the user actually wants them.
- A "Generate stitched output" button. Stitching is a separate flow with its own UI.
- Changing the project membership model. Both image and video can already be project members.
- Project card cover-frame rendering. Already mediaType-aware.
- Reordering or hiding either button based on project content (e.g. "image-only project hides Generate clip"). Both buttons always visible — projects can hold any media type.
- Migrating the `defaults` block of `ProjectContext` to a more structured shape (e.g. `defaults: { video: {...}, image: {...} }`). Premature; do it when image-side defaults arrive.

---

## Documentation

In CLAUDE.md, find the section describing project context entry (likely near "generate-new-clip-in-project" in the Phase 2.2 area). Replace whatever describes the unconditional video-mode entry with:

> Project Detail offers two entry points: "Generate image" and "Generate clip". Each opens Studio in the corresponding mode with the project context active. The project's defaults (frames/steps/cfg/dimensions/lightning/videoLoras) pre-fill the video form when entering video mode; only dimensions pre-fill the image form when entering image mode. Generated items inherit the project regardless of mode.

If there's a paragraph anywhere describing projects as "video-first," update it:

> Projects are general containers for generated outputs. Today they hold images and video clips; future phases will add JSON storyboards (Phase 5), long-form stories, and prompt roleplay. The two-mode entry on the project detail view is the current shape; new entry points will be added as new generation surfaces ship.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
