# Batch — Gallery video support (Phase 1.3)

Last batch in Phase 1. After this lands, videos generated in Studio appear in the Gallery alongside images, play in the modal, and can be remixed back into Studio video mode.

Re-read CLAUDE.md before starting.

---

## What to build

### 1. Tile rendering for videos

The Gallery's tile grid currently renders `<img>` elements per generation. Add a parallel video case keyed off `generation.mediaType === 'video'`:

```tsx
{gen.mediaType === 'video' ? (
  <video
    src={gen.localPath}
    preload="metadata"
    muted
    playsInline
    className="..."  // same dimensions as image tiles
  />
) : (
  <img src={gen.localPath} ... />
)}
```

`preload="metadata"` causes browsers to fetch enough to show the first frame as a poster. No separate thumbnail asset needed — the first frame *is* the thumbnail.

**Duration badge.** Bottom-right corner of every video tile, small dark pill: `${(frames / fps).toFixed(1)}s`. Use Tailwind classes consistent with existing tile overlays (favorite icon, etc.). Render only on video tiles.

**Don't autoplay on hover.** With 14-minute generations producing potentially multi-MB webms, hover-autoplay is bandwidth-expensive and disruptive. Tile is static (first frame); playback happens in the modal.

The existing infinite-scroll cursor pagination doesn't change — `mediaType` is just another field on the row.

### 2. Modal video playback

The existing full-screen modal uses `<img>`. Same conditional pattern as the tile:

```tsx
{gen.mediaType === 'video' ? (
  <video
    src={gen.localPath}
    controls
    autoPlay
    loop
    playsInline
    className="..."  // same fit/sizing as the image
  />
) : (
  <img src={gen.localPath} ... />
)}
```

- `controls` — native HTML5 controls (play/pause/scrub/fullscreen).
- `autoPlay` — Wan 2.2 generates no audio, so autoplay-without-mute is allowed by every browser. No mute attribute needed.
- `loop` — videos are 1–7 seconds; looping makes the modal feel alive instead of dead-after-first-play.

The sidebar (prompt, params, remix/delete/favorite buttons) renders the same way for video and image. Add two extra rows for video: **Frames** and **FPS**. Hide them for image generations (or render `—`, whichever the existing param-display pattern uses).

The modal's previous/next navigation works across mixed media — natural ordering by `createdAt` regardless of type. Don't filter the modal navigation by media type unless the gallery list itself is filtered (see #3).

### 3. Media-type filter

Add a tri-state filter alongside the existing favorites filter: **All** / **Images** / **Videos**.

UI pattern: pill toggle group, same component the favorites filter uses (or extend it). Default: All.

The filter passes a `mediaType` query parameter to the gallery list endpoint (or whatever the existing fetch shape is — probably `/api/generations/list`). Backend filter:

```ts
if (mediaType === 'image') where.mediaType = 'image';
if (mediaType === 'video') where.mediaType = 'video';
// 'all' or omitted → no filter
```

Combines with the favorites filter the obvious way (AND).

The filter is independent of the favorites filter — both can be active. Examples:
- All + favorites only → favorited images and videos
- Videos + favorites off → all videos including non-favorited
- Images + favorites only → favorited images only

### 4. Remix-into-Studio for videos

The existing remix button on the modal loads an image generation's params into the Studio image form. For videos:

1. Switch Studio's mode toggle to **Video** (the toggle introduced in Phase 1.2a).
2. Populate the video form: prompt, width, height, frames, steps, cfg, seed.
3. Do **not** restore the starting frame for i2v generations. Even if the video was i2v, the starting frame would have to be re-picked from the gallery. Easier to leave the starting-frame toggle off and let the user re-enable + re-pick if desired.
4. Negative prompt is not surfaced in the video UI (Phase 1.2a decision), so don't try to populate it.
5. Navigate to the Studio tab.

If a user remixes a video while in image mode, the mode-switch happens automatically. If they remix an image while in video mode, the existing image-mode remix logic fires and switches the toggle back. Both directions should "just work" because the toggle state is part of Studio form state, and remix sets the mode field as part of populating the form.

### 5. Delete and favorite

Both should work for videos with no new code, because the existing endpoints are filename-based and the DB schema is uniform across media types. **Verify before claiming victory:**

- `DELETE /api/generations/[id]` — deletes the DB row and the local file. Verify the file-deletion path uses the row's `localPath` and doesn't assume `.png`/`.jpg`. If it hardcodes an image extension, generalize it.
- Favorite toggle — pure DB write, no media-type concern.
- Two-tap delete confirmation pattern in the gallery — should render identically for video tiles.

If any of these need code changes to support video, do it. Don't paper over a hardcoded extension by special-casing video.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- Video tiles render in the gallery with the first frame as the thumbnail and a duration badge in the corner.
- Clicking a video tile opens the modal with autoplay + native controls + loop.
- The All/Images/Videos filter is visible alongside the favorites filter and combines correctly.
- The modal's previous/next navigation works across mixed media, respecting any active filter.
- Remix on a video tile switches Studio to Video mode and populates the form's video fields.
- Delete and favorite both work on video tiles.
- Tile click areas, hover states, and confirmation flows match the image tile patterns exactly.

Manual smoke test (deferred to user):

1. Generate a video. Open the gallery. Confirm the new tile shows the first frame and a duration badge like "3.6s".
2. Click the tile. Confirm the modal opens, video autoplays, loops, and native controls work. Confirm Frames + FPS rows appear in the sidebar.
3. Click previous/next in the modal across a mix of images and videos. Confirm navigation works in both directions.
4. Switch the filter to Videos. Confirm only videos show. Switch to Images. Confirm only images show. Switch to All. Confirm both.
5. Combine Videos + favorites-only. Favorite one video. Confirm only the favorited video shows.
6. Remix a video. Confirm Studio switches to Video mode and the form populates with the video's prompt and params.
7. Delete a video. Confirm two-tap confirmation works, the tile disappears, and the local webm file is gone from disk.
8. Generate a 768×768 (square) video and a 704×1280 (portrait) video. Confirm both render correctly in the tile grid (whatever object-fit the existing grid uses for non-default-aspect images should apply here too).

---

## Out of scope

- Hover-autoplay on tiles. Bandwidth-expensive given typical webm sizes, deferred indefinitely.
- Separate poster image generation. `<video preload="metadata">` does this natively.
- Video-specific filter modes (e.g. duration filters, t2v vs. i2v filters). Not enough volume to justify yet.
- Video editing in the modal (trim, crop, re-export). Out of scope for Phase 1; Phase 3 (FFmpeg stitching) territory.
- Restoring the starting frame on remix of an i2v generation. The starting frame is in the gallery — re-pick.
- Audio playback affordances (mute button beyond native controls). No audio in Wan 2.2 outputs.
- Download button. Right-click "Save As" works on `<video>`. If a dedicated download UX is wanted, separate batch.
- Sharing / export to social media. Way out of scope.
- Don't touch the image path's tile/modal/remix/delete logic except where the conditional split requires it.

---

## Documentation

In CLAUDE.md, find the "Video generation (Phase 1)" section. Add a "Gallery" subsection:

- Video tiles render the first frame as the thumbnail (`<video preload="metadata">`) with a duration badge.
- Modal playback uses native HTML5 controls with autoplay + loop.
- The All/Images/Videos filter is independent of the favorites filter.
- Remix from a video sets Studio to Video mode and populates prompt + params; the starting frame is not restored.

Find the API routes section. If `/api/generations/list` (or whatever the endpoint is) was extended to accept `mediaType`, document the new query parameter.

When done, push and create the PR via `gh pr create` per AGENTS.md. Include in the PR description: a screenshot of the gallery showing both image and video tiles, a screenshot of the modal with a video playing, and confirmation that all 8 manual smoke-test steps pass.
