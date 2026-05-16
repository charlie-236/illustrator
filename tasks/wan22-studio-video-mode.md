# Batch — Studio video mode (Phase 1.2a)

UI work to make the video backend usable from Studio. Adds an Image/Video mode toggle, video-specific controls, and a gallery picker for the starting frame. **Single-job UX** — same locking behavior as image generation today. Concurrency, queue tray, notifications, and the audio chime all land in Phase 1.2b as a separate batch.

Backend already exists at `POST /api/generate-video` from PR #13. SSE shape mirrors `/api/generate`. Filename obfuscation lands separately as `wan22-video-filename-obfuscation` — no UI dependency on it.

Re-read CLAUDE.md and `tasks/video-report.md` before starting.

---

## What to build

### Mode toggle

A pill toggle at the top of the Studio main column: **Image** / **Video**. Default Image. Persists per-session (sessionStorage is fine; don't push to backend, don't push to URL).

When the user switches modes:
- Prompt and seed values **carry across**.
- Mode-specific values reset to that mode's defaults. (Switching Image→Video doesn't try to reuse the image's resolution; switching back doesn't try to reuse the video's frame count.)
- Polish button hidden in video mode (per existing decision — polisher is SD-tag-tuned, Wan wants prose).

### Video controls

When mode is Video, render these and hide the image-only ones:

**Hide in video mode:**
- LoRA stack (deferred to a Wan-LoRA batch)
- ReferencePanel entirely (img2img base, inpaint mask, FaceID refs — none apply to Wan)
- Checkpoint selector (Wan 2.2 hardcoded for Phase 1)
- Base-model selector
- Hi-Res Fix toggle
- Sampler/scheduler selectors (euler/simple hardcoded for Wan)
- Batch size (always 1 for video)
- Polish button

**Show in video mode:**

| Control | Type | Default | Bounds | Notes |
|---|---|---|---|---|
| Positive prompt | textarea | "" | required, non-empty | Same component as image mode |
| Negative prompt | hidden | — | — | See "Negative prompt UX" below |
| Width | number | 1280 | 256–1280, multiple of 32 | |
| Height | number | 704 | 256–1280, multiple of 32 | |
| Resolution presets | button row | — | — | Quick-pick buttons; see below |
| Frames | slider | 57 | 17–121, step 8 | Display duration alongside: `${frames} frames (${(frames/16).toFixed(1)}s)` |
| Steps | slider | 20 | 4–40, step 2 (even-only) | |
| CFG | slider | 3.5 | 1.0–10.0, step 0.1 | |
| Seed | number + dice | — | — | Same component as image mode |
| Starting frame | optional picker | none | — | See "Starting frame picker" below |

**Resolution presets.** Three buttons that set width+height in one click:

- `1280×704` — landscape, default, matches smoke test
- `768×768` — square
- `704×1280` — portrait

These are not the only allowed values — the inputs accept anything in [256, 1280] step 32 — but most users want one of three common shapes and shouldn't have to type.

**Frame slider valid values are non-contiguous.** The constraint is `(frames - 1) % 8 === 0`, so valid stops are: 17, 25, 33, 41, 49, 57, 65, 73, 81, 89, 97, 105, 113, 121. The slider component should snap to these — easiest by setting `min=17 max=121 step=8` (HTML range works, since 17 is the minimum and the difference between adjacent valid values is exactly 8).

### Negative prompt UX

Hide the negative prompt input in video mode. Below the (hidden) input area, render a small muted hint: "Default Wan 2.2 negative prompt applied." That's it — no override UI in this batch. The route already applies the Chinese default when the body omits `negativePrompt`. Power-user override is a follow-up if anyone ever asks for it.

The hint exists so the user knows the negative isn't just missing.

### Starting frame picker

A toggle labeled **"Use starting frame"** (default off). When off → mode is `t2v`. When on → mode is `i2v` and a picker appears.

**Picker UI (when toggle is on):**

- If no image selected: a button "Pick from gallery" with a placeholder area (similar to the empty state of ReferencePanel's base-image slot).
- If image selected: a thumbnail preview (~120px square) with the picked image, plus a small × button to clear selection (re-shows the placeholder; mode flips back to `t2v` only if the toggle is also turned off — clearing the image alone keeps the toggle on so the picker stays visible).
- Click the thumbnail OR the placeholder OR a "Change" button to reopen the gallery picker.

**Gallery picker modal:**

A modal that opens when the user clicks "Pick from gallery". Shows the existing gallery grid in a constrained-height scrollable container with a search/filter bar at the top.

- Reuse the existing Gallery component if it cleanly accepts a "selection mode" prop. If not, factor a `<GalleryPicker>` component that shares the grid-render logic but disables the favorites/delete/remix actions and replaces the click handler with "select this image".
- Image-only filter (don't show videos as starting-frame candidates — once Phase 1.3 ships, the Gallery may contain both).
- Click an image → modal closes → thumbnail preview populates → form state updates with the image's local path.

**Sending the starting frame to the backend.** The route expects `startImageB64` as a base64-encoded image. When the user submits with a starting frame:

1. Resolve the local file path of the selected gallery image.
2. Read the file (mint-pc local FS), base64-encode it.
3. Strip any data-URI prefix (the route validates against this, but make sure it's clean).
4. POST to `/api/generate-video` with `mode: 'i2v', startImageB64: ...`.

If the source is large (>4MB encoded), the POST body will be too. That's fine — same VM tunnel, no rate limit at the app level. Don't pre-resize. Wan's WanImageToVideo node handles resizing to the requested width/height server-side.

### Generate button

Label: "Generate Video" when in video mode, "Generate" when in image mode.

Wire it to `POST /api/generate-video` (mode video) or the existing image endpoint (mode image). Form state determines which.

**Single-job UX**: while a generation is in flight, the form locks (matches existing image-mode behavior — verify by reading `Studio.tsx` and matching whatever's there). Progress component shows below the form. The generation can be aborted via the existing abort affordance (whatever the image path uses — re-use it).

Note in the PR description: video generations take ~14 minutes (per Charlie's smoke test). The form will be locked the whole time. This is acceptable for 1.2a; the queue UX in 1.2b unlocks concurrency.

### Progress component

Reuse the existing image-generation SSE progress component. The video route emits events with the same shape (`{type: 'progress', value, max}` and a final `{type: 'complete', generationId}`). If the existing progress component renders a step counter or % bar, it will work as-is. Verify by reading the component.

If the existing progress component does anything image-specific (e.g. shows a preview thumbnail of the in-progress sample), wrap that in a mode check so it doesn't try to render a video preview that doesn't exist. Wan generates 5+ minutes before producing decoded frames — there's no useful intermediate preview to show.

### Form validation

Client-side, matching server-side rules:

- Width and Height: integer, multiple of 32, 256–1280
- Frames: integer, 8N+1, 17–121
- Steps: integer, even, 4–40
- CFG: number, 1.0–10.0
- Prompt: non-empty after trim

Inline error messages below the relevant input. Disable the Generate button if any validation fails. Match the existing image-mode validation pattern (whatever component it uses for form errors).

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- A mode toggle is visible at the top of Studio. Clicking switches between image and video controls.
- In video mode: prompt, width, height, frames, steps, cfg, seed, and starting-frame toggle are visible. LoRA stack, ReferencePanel, checkpoint/base-model selectors, hi-res fix, sampler/scheduler, batch, and Polish are not.
- The frame slider snaps to 8N+1 values. Adjacent slider stops are 8 apart.
- The duration label updates as the slider moves: `${frames} frames (${(frames/16).toFixed(1)}s)`.
- Resolution presets `1280×704`, `768×768`, `704×1280` set width and height in one click.
- The starting frame toggle, when enabled with no image picked, shows a "Pick from gallery" button. Clicking it opens a modal showing only images (not videos, once those exist).
- Picking an image in the modal: closes the modal, populates the thumbnail preview, and sets the form's mode to `i2v`. Clearing the image (× button) keeps the toggle on but removes the selection. Toggling off goes back to `t2v`.
- Submitting in video mode POSTs to `/api/generate-video` with the right mode and (if i2v) a base64-encoded starting frame.
- Submitting in image mode POSTs to the existing image endpoint. No regression.
- Form locks during generation. Existing abort UX works for video generations too.
- Negative prompt input is hidden in video mode; a hint "Default Wan 2.2 negative prompt applied" is shown.

Manual smoke test (deferred to user):

1. Open Studio. Default to Image mode. Generate a regular image. Verify no regression.
2. Switch to Video mode. Confirm controls swap correctly. Type a prompt, click Generate. Confirm the request goes to `/api/generate-video`, progress streams, completes after ~14 minutes, the resulting webm appears in the gallery directory on disk.
3. In Video mode, enable starting frame, pick an image from the gallery picker. Confirm preview shows. Click Generate. Confirm the request includes `startImageB64` and the resulting video reflects the chosen starting frame.
4. Move the frame slider through several positions. Confirm it snaps to 17, 25, 33, …, 121. Confirm the duration label updates correctly (17 frames = 1.0s, 57 = 3.6s, 121 = 7.6s).
5. Try entering invalid values (width 1281, frames 50). Confirm inline errors appear and Generate is disabled.
6. Switch Image→Video→Image. Confirm prompt and seed carry across. Confirm video controls don't bleed into image mode.
7. Generate a video, abort mid-generation. Confirm the abort works (file cleanup is the backend's concern; the UI just needs to recover form-lock state).

---

## Out of scope

- Concurrency. Form locks during video generation, same as image. Phase 1.2b unlocks this.
- Queue tray, notifications, audio chime. All Phase 1.2b.
- Gallery video playback. Phase 1.3.
- Wan LoRA support. Separate Phase 1.4 batch.
- First+last frame conditioning. Out of scope for Phase 1 entirely.
- Polish button for video mode. Confirmed out of scope.
- Negative prompt override UI. Confirmed out of scope.
- Sampler/scheduler/FPS exposure. All hardcoded for Phase 1.
- Manual image upload as starting frame (camera roll path). Phase 2+.
- Saving form state to localStorage across page reloads beyond what already exists. Match existing behavior.
- Don't change the image-mode behavior except where extracting shared components requires it.

---

## Documentation

In CLAUDE.md, find the "Video generation (Phase 1)" section added by PR #13. Add a subsection "Studio UI" with:

- The mode toggle and what it controls.
- The video controls and their bounds (link to the validation rules already documented).
- The starting-frame picker and that it sources from the gallery.
- The note that single-job UX is the Phase 1.2a state; concurrency lands in 1.2b.

Find the source layout. Add the new component(s) — `GalleryPicker.tsx` if it ends up factored out, or whatever shape the implementation takes.

When done, push and create the PR via `gh pr create` per AGENTS.md. Include in the PR description: a screenshot of Studio in video mode (mid-form, before Generate), a screenshot of the gallery picker open, and the wall-clock for one t2v and one i2v generation as smoke-test confirmation.
