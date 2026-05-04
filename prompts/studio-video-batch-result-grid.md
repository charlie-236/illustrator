# Batch — Studio video batch result-grid (mirror image-mode)

When the user generates a video batch (1–4 takes), Studio's result card currently shows only the *most recently completed* take. Earlier takes get overwritten as later takes finalize — the user sees take 1, then 2 replaces it, then 3, then 4. They never see the full batch in the result card. Image-mode handles this correctly: `lastImageRecords` accumulates per-take records into a thumbnail grid that's tappable into the modal.

Mirror the image-mode pattern for video. Each completed take pushes onto an array; the result card renders a grid of video thumbnail tiles; tapping a tile opens the existing `ImageModal` (which already handles videos correctly per Phase 1.3).

**Sequencing: this batch must merge after `sse-complete-event-parity`** — the implementation reads `records: GenerationRecord[]` from the SSE complete event, which the prior batch establishes.

Re-read CLAUDE.md before starting.

---

## Required changes

### `src/components/Studio.tsx` — replace `videoResult` with `lastVideoResults`

Currently:

```ts
const [videoResult, setVideoResult] = useState<VideoResult | null>(null);
```

Replace with an array, mirroring the image-side `lastImageRecords`:

```ts
const [lastVideoResults, setLastVideoResults] = useState<GenerationRecord[]>([]);
```

The video batch loop's per-take SSE consumer pushes onto the array on `complete`:

```ts
sse.addEventListener('complete', (e) => {
  const d = JSON.parse(e.data) as { records: GenerationRecord[] };
  setLastVideoResults((prev) => [...prev, ...d.records]);
  completeJob(capturedPromptId, d.records[0]?.id ?? '');
  sse.close();
  onGenerated();
});
```

Match image-mode's accumulation pattern exactly. Same naming convention, same timing.

### Reset `lastVideoResults` to `[]`

Mirror image-side timing — wherever `lastImageRecords` resets to `[]`, do the same for `lastVideoResults`:

- Mode switch (image ↔ video) — match whatever image-side does. Read the existing image reset behavior; if image clears `lastImageRecords` on mode switch, video clears `lastVideoResults` too. If image preserves them, preserve too.
- New batch submission start — clear before the first take's SSE opens, so the previous batch's grid is gone the moment Generate is tapped.
- Video remix application — clear (`videoRemixParams` consumer effect already resets various state; add `lastVideoResults` to that reset list).
- Project context trigger — clear (the `projectContextTrigger` consumer effect resets `videoResult` today; replace that with `setLastVideoResults([])`).

Read each of these reset points by searching for the existing `setVideoResult(null)` calls; replace each with `setLastVideoResults([])`.

### Result card rendering

Image-mode's result card is a 3-column grid of `<img>` tiles. Mirror it for video using `<video>` tiles with `preload="metadata"` (browsers fetch enough to show the first frame as a poster — same trick the gallery uses for video tiles):

```tsx
{lastVideoResults.length > 0 && (
  <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
    {lastVideoResults.map((record, idx) => (
      <button
        key={record.id}
        onClick={() => setResultModalIdx(idx)}
        className="relative aspect-square rounded-lg overflow-hidden border border-zinc-800 hover:border-zinc-600 transition-colors"
      >
        <video
          src={imgSrc(record.filePath)}
          preload="metadata"
          muted
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
        />
        {/* Duration badge — mirror Gallery's pattern */}
        {record.frames && record.fps && (
          <span className="absolute bottom-1 right-1 px-1.5 py-0.5 bg-black/70 rounded text-[10px] text-white tabular-nums">
            {(record.frames / record.fps).toFixed(1)}s
          </span>
        )}
      </button>
    ))}
  </div>
)}
```

Mirror the styling and structure of the image-mode result grid exactly. If the image-mode result tile uses any visual element (favorite indicator, hover effects, etc.), include the same on the video tile.

### Seed display

Image-side shows `lastResolvedSeed` only when batch size was 1 (per the existing code). Mirror that for video — if the user generated batch=1, show the seed of that single take; if batch>1, hide the seed line (each take has its own seed visible in the gallery / modal).

Read image-mode's seed-display logic and replicate. Don't add per-tile seed badges in this batch — keep parity with image-mode.

### Modal opening from result tiles

Tap → existing `ImageModal` with `lastVideoResults` as the `items` array and the tapped index. The modal already handles videos correctly (Phase 1.3) and supports prev/next navigation across mixed media.

Wire this through whatever pattern image-mode uses. If image-mode has a separate `resultModalIdx` state for opening the modal from the result card (vs the gallery), replicate. If it routes through the gallery's modal directly, replicate.

### Type cleanup — remove `VideoResult` if dead

After this batch, `VideoResult` should have no consumers. The previous batch (`sse-complete-event-parity`) may have already deleted it or aliased it to `GenerationRecord`. Confirm with `grep -rn "VideoResult" src/`.

If anything still references it: either inline-replace with `GenerationRecord` or keep the alias. Lean toward deletion — fewer named types is better.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "lastVideoResults" src/components/Studio.tsx` shows the new state declaration and accumulation.
- `grep -n "videoResult\b" src/components/Studio.tsx` returns nothing (the old singleton state is gone — note the word boundary to avoid matching `videoResults`).
- `grep -rn "VideoResult\b" src/` ideally returns nothing, or only a type alias.
- After a video batch=4 generation, the result card shows 4 thumbnail tiles. Each is independently tappable; the modal opens to the correct video.
- After a video batch=1 generation, the result card shows 1 thumbnail tile, behavior matches image batch=1.
- Mode switch from video to image (and back) follows the same reset pattern image-side uses for `lastImageRecords`.
- Project context trigger clears `lastVideoResults` (no stale grid persists across project entries).
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. Generate a video batch=4. Watch all 4 takes complete. Confirm 4 thumbnails appear in the result grid (none disappear or get overwritten).
2. Tap each thumbnail. Confirm the modal opens to the correct video. Prev/next navigation works across the 4 takes.
3. Generate a video batch=1. Confirm 1 thumbnail; tap to open modal. Confirm seed is displayed below the grid (matching image batch=1 behavior).
4. After step 1, switch to image mode. Confirm the video result grid behaves the same as image-mode would (clears or persists per the image-mode pattern). Switch back to video — same behavior.
5. Generate an image batch=4 (regression check). Confirm the image grid still works the same.
6. Trigger a project context entry from the Projects tab. Confirm previous video results clear.
7. Trigger a video remix from the gallery. Confirm previous video results clear.

---

## Out of scope

- Auto-playing video tiles on hover. Same restraint as the gallery (bandwidth, distraction).
- A "show me only the latest take" view. The grid is the only view.
- Reordering tiles by completion order vs queue order. Use accumulation order (which is completion order — ComfyUI's queue).
- Cross-batch persistence. Result card resets when the batch is over; old results live in the gallery.
- Showing aborted takes as placeholders. If a take aborts, it doesn't push onto the array. Match image-side.
- Per-tile seed badges. Out of scope; keep parity with image-mode's seed display.
- Changes to the SSE event shape — that's the prior batch's domain.

---

## Documentation

In CLAUDE.md, find the Studio video mode section. Find any line that describes the result card showing "the most recent video" or similar. Replace with:

> Video batch result card mirrors image-mode: per-take `GenerationRecord` accumulates into a 3-column thumbnail grid (`<video preload="metadata">` tiles with duration badge). Tapping a tile opens the existing `ImageModal` at that record's index. The grid resets on mode switch, new batch submission, video remix, or project context trigger — same lifecycle as image-mode's `lastImageRecords`.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
