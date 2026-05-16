# Batch — Video settings popout (Studio UX consistency)

Image mode in Studio hides advanced settings (steps, cfg, sampler, dimensions, hi-res fix, etc.) behind a filter/settings button — only prompts are visible by default. Video mode (shipped in Phase 1.2a) shows all settings inline. The asymmetry creates a denser, busier video form and breaks the visual consistency between modes.

Fix: move video mode's settings (frames, steps, cfg, dimensions, resolution presets) into the same popout panel image mode uses.

Re-read CLAUDE.md before starting.

---

## What stays inline (always visible) in video mode

- Mode toggle (Image / Video pill)
- Positive prompt (textarea)
- Negative-prompt-default hint ("Default Wan 2.2 negative prompt applied")
- Starting frame toggle + picker (when toggled on)
- "Use last frame of previous clip" checkbox (when in a project context with prior clips — Phase 2.2)
- Project context badge in header (when in project context)
- Generate button
- Settings/filter button (the same button that exists in image mode)

## What moves into the popout

- Width / Height inputs
- Resolution preset buttons (`1280×704`, `768×768`, `704×1280`)
- Frames slider with duration label
- Steps slider
- CFG slider
- Seed input + dice button

## Implementation

Find the existing settings popout component used by image mode. It's likely a panel or drawer that toggles open from the filter button. Read its structure and the trigger button's component.

Two paths depending on what's there:

**(a) The popout is mode-agnostic** (just a generic container). Add the video controls as a parallel block, conditionally rendered based on mode. Image-mode controls render in image mode; video-mode controls render in video mode. Same shell, different content.

**(b) The popout is image-specific** (hardcoded image controls). Generalize: split the popout's content into `<ImageSettings>` and `<VideoSettings>` components, with the popout's body switching on mode.

The agent picks based on the existing structure. The user-visible result must be identical: clicking the filter button in either mode opens the same popout shell with mode-appropriate controls inside.

**State preservation:** opening and closing the popout must not reset any form values. Same persistence behavior as image mode today. Verify this — it's the kind of thing that breaks silently if the popout component re-mounts its children on toggle.

**Validation messages:** Inline validation errors (e.g. "frames must be 8N+1") should still surface — either inside the popout next to their fields, or as a single summary near the Generate button when the popout is closed. Whatever pattern image mode uses for validation when its popout is closed, match it. Disabling Generate on validation failure is the existing pattern; keep that.

**The Generate button stays outside the popout**, in its current location. The popout is for tweaking; Generate is the primary action and should always be reachable without opening anything.

## Mode switch behavior unchanged

Switching Image ↔ Video doesn't open or close the popout. If the popout is open when the user switches modes, it stays open and shows the new mode's controls. If closed, it stays closed.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- In video mode with the popout closed, only the always-visible items above are rendered. The width/height/frames/steps/cfg/seed controls are not visible.
- Clicking the settings button opens the popout with the video controls inside.
- The popout uses the same component (or generalized version of) image mode's popout.
- Switching modes while popout is open shows the new mode's controls in the same popout.
- Closing and reopening the popout preserves all entered values.
- Inline validation errors and Generate-button disabling still work the same way as before.

Manual smoke test (deferred to user):

1. Open Studio in image mode. Confirm prompts visible, advanced settings hidden behind filter button.
2. Switch to video mode. Confirm prompts + starting-frame controls visible, the rest hidden behind the same filter button.
3. Click the filter button in video mode. Confirm the popout opens with frames/steps/cfg/dimensions/seed.
4. Adjust frames to 81. Close the popout. Reopen. Confirm 81 is still there.
5. Switch to image mode while popout is open. Confirm popout shows image controls (steps/cfg/sampler/scheduler/dimensions/HRF).
6. Switch back to video mode while popout still open. Confirm video controls return.
7. Generate a video. Confirm form lock + queue tray + completion behavior unchanged from Phase 1.2a/1.2b.
8. Type an invalid value (frames = 50). Confirm validation message appears and Generate is disabled — same pattern as image mode validates with popout closed.

---

## Out of scope

- Don't add or remove any video controls. Same fields, just relocated.
- Don't change the popout's open/close animation, position, or styling.
- Don't change anything in image mode beyond what's required to share the popout shell.
- Don't change the order in which settings appear (frames/steps/cfg/dimensions/seed) unless the existing image popout's ordering implies a parallel.
- Don't touch the queue tray, the gallery, or any non-Studio component.
- Don't lift state from the form components into the popout shell. Form state stays where it is; the popout is a render concern.

---

## Documentation

In CLAUDE.md's Studio section, find the description of the video form. Update to note that video settings live in the same popout as image settings, opened via the same filter button. Remove any language describing video controls as inline.

When done, push and create the PR via `gh pr create` per AGENTS.md.
