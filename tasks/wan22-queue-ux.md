# Batch — Queue UX (Phase 1.2b)

Builds on Phase 1.2a's Studio video mode. After this batch, generations no longer lock the form, the user can run multiple jobs in parallel, in-flight work is visible in a queue tray, completion fires a chime + toast + browser notification, and refreshing the page doesn't lose visibility into running jobs.

This batch unlocks the workflow value of video generation. A 14-minute job that locks the form is unusable; the same job in a fire-and-forget queue with completion notifications is a tool you actually want to use.

Re-read CLAUDE.md before starting.

---

## What to build

### 1. Concurrency: unlock the form

Today, submitting a generation locks the Studio form until completion. Replace with: submitting **adds a job to the queue and immediately resets the form for the next submission**. The form is never locked.

Implications:
- The Generate button is always available (modulo client-side validation).
- The user can change all form values immediately after clicking Generate. The submitted job has a snapshot of the params at submit-time.
- Multiple jobs of any combination (image + image, image + video, video + video) can run concurrently. The backend WS singleton already supports this.

Don't impose a soft cap. The user is single-user, single-machine; if they want to queue 10 jobs, let them.

### 2. Active jobs state

Introduce a global state container for active jobs. Match the project's existing state pattern (Context + reducer, Zustand, whatever's in use — read existing code and pick the lowest-friction match).

Per-job state shape:

```ts
type ActiveJob = {
  promptId: string;          // ComfyUI prompt ID, the canonical key
  generationId: string;      // DB row cuid
  mediaType: 'image' | 'video';
  promptSummary: string;     // first ~60 chars of the positive prompt
  startedAt: number;         // ms epoch
  progress: { current: number; total: number } | null;  // null until first event
  status: 'running' | 'completing' | 'done' | 'error';  // 'completing' = sampling done, file fetch in flight
  errorMessage?: string;
};
```

Operations:
- `addJob(job)` — called when a Studio submission succeeds.
- `updateProgress(promptId, progress)` — called on each SSE progress event.
- `completeJob(promptId, generationId)` — called when SSE completes successfully. Fires the notification chain.
- `failJob(promptId, errorMessage)` — called on SSE error. Also fires notification (different chime tone or just toast).
- `removeJob(promptId)` — called when user dismisses a completed/errored job from the tray.

Completed jobs persist in the tray for 30 seconds (auto-dismiss) or until the user dismisses them, whichever comes first. Errored jobs persist until manually dismissed (don't auto-hide errors — the user needs to see them).

### 3. Queue tray

A component in the Studio tab's local header (top-right of the Studio panel, not the global app header — confirmed scope per architect notes). Visible only on the Studio tab.

**Collapsed state:**

A small badge showing the count of active jobs ("3"). If zero jobs, the tray is invisible (no empty-state badge). Click the badge to expand.

**Expanded state:**

A dropdown panel anchored to the badge, showing one row per job. Each row:

- Media-type icon (small image icon or video icon — match existing iconography).
- Prompt summary (60 chars, ellipsis on overflow).
- Progress bar with `${current}/${total}` label, or "Starting…" if progress is null, or "Saving…" when status is `completing`.
- Wall-clock elapsed (`Math.floor((Date.now() - startedAt) / 1000)s`).
- Abort button (× icon).
- For done jobs: a "View" link that navigates to gallery and scrolls to the new item; auto-dismisses after 30s.
- For error jobs: error message in red, dismiss button.

Sort order: most recent first.

The tray closes when the user clicks outside it or presses Escape.

**Mute toggle:**

Small speaker icon in the tray header (next to the badge or inside the expanded panel). Click toggles audio chime on/off. Persists to localStorage. Default: unmuted.

### 4. Notification on completion

Three independent channels, all fire on `completeJob`. Each can be on/off independently of the others (chime is mute-controlled; toast always fires; browser notification depends on permission).

**(a) Audio chime.**

Short (~1s) public-domain notification sound. Easiest implementation: embed a small base64-encoded OGG or WAV in the source so there's no asset dependency. Examples of suitable public-domain sources: Notification sound from Mozilla's notification gallery, freesound.org's CC0 catalog. Pick one tasteful and short — the agent has discretion. Document the source in the PR description.

Play via Web Audio API or `<audio>` element. Volume: 50% of system. Don't autoplay-block: the chime fires after a user-initiated generation, so browser autoplay policy isn't an issue.

If muted: don't play.

**(b) In-app toast.**

A small toast appears in the bottom-right (or wherever the existing toast pattern lives — match it). Reuse the existing toast component if there is one; build a minimal one if not.

Content: "Image generated" or "Video generated", with a "View" link that navigates to gallery.

Auto-dismiss after 5 seconds. Click the toast to navigate; click the × to dismiss.

**(c) Browser Notification API.**

On the **first generation submit**, request notification permission via `Notification.requestPermission()`. If granted, all subsequent completions fire a `new Notification(...)`. If denied, never re-prompt — the user said no, respect it. Store the permission state observation in localStorage so we don't even attempt the API call on later sessions if it was previously denied.

Notification content:
- Title: "Generation complete"
- Body: the prompt summary
- Tag: the generationId (so re-firing for the same job replaces, doesn't stack)
- onclick: focus the tab and navigate to gallery

Don't fire a notification if the tab is in the foreground — the toast covers it. Use `document.hidden` to detect.

### 5. Refresh survivability

When the Studio tab mounts, check whether any jobs are running on the server and reattach to them.

**New endpoint: `GET /api/jobs/active`**

Returns the list of currently-running jobs from the comfyws job manager:

```ts
{
  jobs: Array<{
    promptId: string;
    generationId: string;
    mediaType: 'image' | 'video';
    promptSummary: string;
    startedAt: number;
    progress: { current: number; total: number } | null;
  }>
}
```

Implementation: the comfyws singleton already tracks active jobs in a Map. Expose them via this endpoint. Do not include jobs that are already finalized — only "running" or "completing" status.

`promptSummary` requires storing the prompt text on the job at registration time. Add it to the job-record type if it's not there. ~60 characters, truncated.

**On Studio mount:**

```ts
useEffect(() => {
  fetch('/api/jobs/active').then(r => r.json()).then(({ jobs }) => {
    jobs.forEach(j => addJob(j));  // populate the queue tray
    jobs.forEach(j => startPolling(j.promptId));  // see below
  });
}, []);
```

**Polling for refreshed jobs:**

The original SSE for an in-tab generation is still attached and dispatching to the job state. After a refresh, that SSE is gone. To get progress and completion for already-running jobs, **poll `/api/jobs/active` every 5 seconds** while there are active jobs whose status is `running` or `completing`. Stop polling when no such jobs remain.

Poll detects state transitions:
- Job present in last poll, missing in current poll → completed (or error). To distinguish: also expose `GET /api/jobs/[generationId]` returning `{status: 'done' | 'error', errorMessage?}` from a small in-memory recently-completed cache (last 10 jobs, 5 minutes). On poll-detected disappearance, query this for the outcome and fire `completeJob` or `failJob` accordingly.
- Job present, progress changed → `updateProgress`.

Cleaner alternative if it fits: include recently-completed jobs in `/api/jobs/active`'s response with a `status` field (`'running' | 'completing' | 'done' | 'error'`), and have the client do the state-transition detection. The endpoint becomes "active-or-recently-active jobs" and the recent-cache is bundled in. Pick whichever feels cleaner against the existing comfyws structure.

In-tab generations still use SSE — don't replace SSE with polling. Polling is only the post-refresh recovery path. Both can coexist; if both report progress for the same job, the state-update is idempotent.

### 6. Abort behavior in the tray

The abort button on each job row calls `DELETE /api/jobs/[promptId]` (new endpoint or extend existing — the abort flow already exists for in-tab cancellation; reuse whatever calls comfyws's `removeJob`).

`removeJob` already cleans up the VM file (per PR #13 fixes). The tray entry transitions to `error` status with message "Aborted" and is dismissible.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- The Studio form unlocks immediately after submit. The Generate button can be clicked again right away.
- A queue tray badge is visible in the Studio header when jobs are running. Zero jobs = no badge.
- Expanded tray shows one row per job with prompt summary, progress, elapsed time, abort button.
- Audio chime plays on completion when unmuted, stays silent when muted; mute state persists across sessions.
- In-app toast appears on completion with a working "View" link to gallery.
- Browser Notification fires on completion when permission is granted AND tab is not in foreground.
- Permission is requested only on first generation submit, not on page load. Denial is remembered.
- After page refresh during a running generation: the queue tray populates within ~5 seconds with the in-flight job and shows progress updates. Completion fires the full notification chain.
- `GET /api/jobs/active` endpoint exists and returns the documented shape.

Manual smoke test (deferred to user):

1. Generate an image. Confirm form unlocks immediately. Confirm the badge appears, then disappears (after auto-dismiss). Confirm chime plays + toast appears + notification fires (if granted + tab backgrounded).
2. Generate a video. Confirm same flow but with the much longer wall-clock — abort partway through and verify the abort tile shows correctly.
3. Generate a video. Refresh the page during the generation (within the first few minutes). Confirm the tray repopulates with the in-flight job. Confirm progress continues updating. Confirm completion fires notifications.
4. Submit an image and a video back-to-back. Confirm both appear in the tray. Confirm the image completes first (faster) and is visible in the tray as `done`, while the video is still `running`. Confirm both notifications fire when each completes.
5. Mute the chime. Generate something. Confirm no audio. Toast and notification still fire. Refresh — confirm mute state persists.
6. Deny notification permission. Generate. Confirm chime + toast still fire; notification silently skips. Generate again — confirm permission isn't re-prompted.
7. Tab-switch to Gallery during a generation. Tab back to Studio. Confirm the tray is still there with current state.

---

## Out of scope

- Don't refactor `/api/generate` or `/api/generate-video`'s SSE shape. The in-tab path is unchanged.
- Don't add a separate "Queue" tab. The tray in the Studio header is the only queue UI.
- Don't show the queue tray on Gallery / Models / Admin tabs. Studio-only.
- Don't surface VAE-decode progress separately from sampling. Same scope as PR #13.
- Don't add a "retry" button for failed jobs. Manual re-submit is fine for now.
- Don't add per-job thumbnails to image-mode tray entries. Text-only is sufficient.
- Don't multiplex SSE — per-request streams stay as they are. The polling fallback covers the refresh case.
- Don't expand the comfyws job manager into a true persistent queue (Redis / disk). In-memory only. Server restart kills in-flight visibility, which is acceptable single-user behavior.
- Don't add cross-device sync (different browsers seeing the same queue). Single-machine.
- Don't add notification grouping / batch-by-batch summaries. One notification per completion.
- Don't change the gallery (Phase 1.3 is its own batch).

---

## Documentation

In CLAUDE.md, add a "Queue UX" subsection under the video section:

- Concurrency model: form unlocks at submit; jobs run independently; tray shows in-flight state.
- Notification chain: chime → toast → browser notification (mute affects chime only).
- Refresh survivability: `/api/jobs/active` reattaches the queue tray on mount; polls every 5s for running jobs.
- Permission flow: notifications requested on first submit; denial remembered.

Find the API routes table and add `GET /api/jobs/active` (and `GET /api/jobs/[id]` if the agent went the second route).

Find the source layout and add the queue-tray component, the notification helper, and the global active-jobs state container.

When done, push and create the PR via `gh pr create` per AGENTS.md. Include in the PR description: the source of the chime audio file, a screenshot of the expanded tray with a job in progress, and confirmation that all 7 manual smoke-test steps pass.
