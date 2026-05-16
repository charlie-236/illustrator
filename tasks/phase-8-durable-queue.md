# Batch — Phase 8: Durable app-side queue (spot-resilience)

Loom runs against a remote ComfyUI on an Azure spot VM. Spot instances can be preempted at any time. Today, when the VM is preempted mid-batch:

- ComfyUI's in-memory queue evaporates. All queued prompts are lost.
- The currently-running prompt also dies.
- When the VM comes back, `flushJobsOnReconnect` polls `/history/{promptId}` for each pending job. Since ComfyUI restarted, history is empty → all return as "completed but image lost, please retry" errors.
- A 10-job storyboard keyframe batch loses 7 jobs on a single preemption. User has to manually re-trigger them.

Phase 8 moves the queue from ComfyUI (in-memory, not durable) to Postgres (durable, app-controlled). Loom holds N pending jobs in the database; only one job is submitted to ComfyUI at a time. When ComfyUI finishes a job, the queue runner submits the next. When the VM dies, queued jobs stay in the DB; only the running job is lost. Auto-retry-once handles the running-job case for VM-loss specifically.

Bonus benefits beyond durability: per-job cancel without affecting others (cancel queued = soft delete; cancel running = ComfyUI interrupt). Reorder/pause/edit are out of scope for this batch but the foundation supports them.

Re-read CLAUDE.md before starting. The disk-avoidance contract is **load-bearing throughout this batch** — the queue runner does not touch workflow JSON, does not change SaveImageWebsocket / ETN_LoadImageBase64 usage, does not change WS finalize. It only changes WHEN ComfyUI receives the workflow, not WHAT.

---

## Critical: what this batch does not change

The forbidden-class-type guards stay. The WS hijack stays. Single-prompt-at-a-time on ComfyUI means we never have a queue inside ComfyUI — but each prompt's workflow shape is unchanged. Disk-avoidance is preserved.

Tablet UX: the queue tray surface gains queued-state visibility (already a state per CLAUDE.md), but no significant new UI in this batch beyond per-job cancel for queued items. Reorder/pause UI is deferred.

---

## Required changes

### Part 1 — Schema

`prisma/schema.prisma`:

```prisma
model QueuedJob {
  id              String    @id @default(cuid())
  
  // What media type and full payload — enough to re-submit to ComfyUI
  mediaType       String    // 'image' | 'video' | 'stitch'
  payloadJson     Json      // GenerationParams | VideoParams | StitchParams (full request)
  
  // Lineage — tie back to whatever surface created this
  generationId    String?   // for image/video, the planned Generation row id
  projectId       String?   // for project-context jobs
  sceneId         String?   // for storyboard scenes
  storyboardId    String?   // for storyboard batches
  
  // Lifecycle state machine
  status          String    @default("pending")
                            // 'pending' — in DB, not yet submitted
                            // 'submitted' — POSTed to ComfyUI, awaiting prompt_id ack
                            // 'running' — ComfyUI accepted, executing or queued internally
                            // 'complete' — finalized successfully
                            // 'failed' — terminal failure
                            // 'cancelled' — user-cancelled (pre or during)
  
  promptId        String?   // ComfyUI prompt_id, populated after submission
  
  // Retry tracking (auto-retry on VM loss only)
  retryCount      Int       @default(0)
  lastFailReason  String?   // 'vm_lost' | 'llm_error' | 'aborted' | 'workflow_error'
  
  // Ordering (FIFO by createdAt; reorder later writes new positions)
  position        Int       @default(0)
  
  // Timestamps
  createdAt       DateTime  @default(now())
  submittedAt     DateTime?
  startedAt       DateTime?  // when ComfyUI's executing event arrived
  finishedAt     DateTime?
  
  @@index([status, position])
  @@index([promptId])
}
```

Apply via `npx prisma db push`. Existing in-flight jobs (none after restart) don't need migration.

The `payloadJson` is the FULL submission body — every parameter needed to rebuild the workflow. For images: the `GenerationParams` shape. For videos: the `VideoGenerationParams` shape (including loras, lightning state, base/last frame data). For stitch: the project clipIds + project metadata. The runner re-builds the workflow at submission time from this payload.

`generationId` is a soft pointer (no FK). The Generation row may or may not exist yet — for some flows we create the Generation row when the job is submitted, for others when it's accepted. Either is OK; the QueuedJob is the queue's source of truth, the Generation row is the result's source of truth.

### Part 2 — Types

`src/types/index.ts`:

```ts
export type QueuedJobStatus = 
  | 'pending' | 'submitted' | 'running' 
  | 'complete' | 'failed' | 'cancelled';

export interface QueuedJobRecord {
  id: string;
  mediaType: 'image' | 'video' | 'stitch';
  payloadJson: GenerationParams | VideoGenerationParams | StitchParams;
  generationId: string | null;
  projectId: string | null;
  sceneId: string | null;
  storyboardId: string | null;
  status: QueuedJobStatus;
  promptId: string | null;
  retryCount: number;
  lastFailReason: string | null;
  position: number;
  createdAt: string;
  submittedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
```

### Part 3 — The queue runner

New file `src/lib/queueRunner.ts`. This is the core of Phase 8.

```ts
import { prisma } from './prisma';
import { ComfyWSManager } from './comfyws';

const RUNNER_TICK_MS = 5_000;
const MAX_RETRIES_FOR_VM_LOSS = 1;

let runnerInterval: NodeJS.Timeout | null = null;
let runnerBusy = false;

/**
 * Starts the queue runner. Called once at app startup (e.g., from instrumentation.ts
 * or a global initialization spot). Idempotent — safe to call multiple times.
 */
export function startQueueRunner(): void {
  if (runnerInterval) return;
  
  runnerInterval = setInterval(() => {
    if (runnerBusy) return;
    runnerBusy = true;
    void runnerTick().finally(() => { runnerBusy = false; });
  }, RUNNER_TICK_MS);
  
  // Run once immediately at startup to recover from any VM-loss state
  void runnerTick();
}

async function runnerTick(): Promise<void> {
  // Step 1: Check if ComfyUI WS is connected. If not, do nothing (VM might be dead).
  const manager = ComfyWSManager.getInstance();
  if (!manager.isConnected()) return;
  
  // Step 2: Reconciliation — for any 'submitted' or 'running' job, verify it's
  // actually still alive on ComfyUI. If WS just reconnected, jobs may be ghosts.
  await reconcileGhostJobs(manager);
  
  // Step 3: Check if ComfyUI is busy. If yes, do nothing — wait for the running
  // job to finish before submitting the next.
  const activeJobs = manager.getActiveJobs();
  const anyRunning = activeJobs.some(
    (j) => j.status === 'running' || j.status === 'submitted',
  );
  if (anyRunning) return;
  
  // Step 4: Find the oldest pending job (FIFO by position, then createdAt).
  const next = await prisma.queuedJob.findFirst({
    where: { status: 'pending' },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  if (!next) return;
  
  // Step 5: Submit it.
  await submitToComfy(next);
}

/**
 * On WS reconnect, jobs marked 'submitted' or 'running' in the DB may be ghosts —
 * ComfyUI restarted and lost them. Detect and mark as failed (or auto-retry).
 */
async function reconcileGhostJobs(manager: ComfyWSManager): Promise<void> {
  const inFlight = await prisma.queuedJob.findMany({
    where: { status: { in: ['submitted', 'running'] } },
  });
  
  if (inFlight.length === 0) return;
  
  const liveActive = manager.getActiveJobs();
  const livePromptIds = new Set(liveActive.map((j) => j.promptId));
  
  for (const job of inFlight) {
    if (job.promptId && livePromptIds.has(job.promptId)) continue; // still alive
    
    // Ghost — ComfyUI doesn't know about this prompt. Likely VM-loss.
    if (job.retryCount < MAX_RETRIES_FOR_VM_LOSS) {
      // Auto-retry: reset to pending, increment retryCount, clear runtime fields.
      await prisma.queuedJob.update({
        where: { id: job.id },
        data: {
          status: 'pending',
          promptId: null,
          submittedAt: null,
          startedAt: null,
          retryCount: { increment: 1 },
          lastFailReason: 'vm_lost',
        },
      });
      console.log(`[queue] auto-retry on VM loss: ${job.id} (retry ${job.retryCount + 1})`);
    } else {
      // Already retried once; mark as terminal failure.
      await prisma.queuedJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          lastFailReason: 'vm_lost',
          finishedAt: new Date(),
        },
      });
      console.log(`[queue] terminal failure (vm_lost, exhausted retries): ${job.id}`);
    }
  }
}

async function submitToComfy(job: QueuedJob): Promise<void> {
  // Update to 'submitted' status before actually submitting — prevents
  // double-submission if the runner ticks during the submit.
  await prisma.queuedJob.update({
    where: { id: job.id },
    data: { status: 'submitted', submittedAt: new Date() },
  });
  
  try {
    // Dispatch to the appropriate submission helper based on mediaType.
    // These helpers do the actual work that today's API routes do — build the
    // workflow, POST to ComfyUI, register with the manager. Refactored from
    // the routes to be callable internally.
    let promptId: string;
    switch (job.mediaType) {
      case 'image':
        promptId = await submitImageJob(job);
        break;
      case 'video':
        promptId = await submitVideoJob(job);
        break;
      case 'stitch':
        promptId = await submitStitchJob(job);
        break;
      default:
        throw new Error(`Unknown mediaType: ${job.mediaType}`);
    }
    
    // Update with the ComfyUI prompt_id; manager will transition to 'running'
    // when the executing event arrives.
    await prisma.queuedJob.update({
      where: { id: job.id },
      data: { promptId, status: 'running' },
    });
  } catch (err) {
    console.error(`[queue] submit failed for ${job.id}:`, err);
    await prisma.queuedJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        lastFailReason: 'workflow_error',
        finishedAt: new Date(),
      },
    });
  }
}
```

Helper functions `submitImageJob`, `submitVideoJob`, `submitStitchJob` are extracted from the existing routes. Each:

1. Reads `payloadJson` and reconstructs the original parameters
2. Builds the workflow (calling existing `buildWorkflow` / `buildVideoWorkflow` / etc.)
3. POSTs to ComfyUI's `/prompt` endpoint
4. Registers the job with `ComfyWSManager` (using existing `registerJob` / `registerVideoJob` / `registerStitchJob`)
5. Returns the `prompt_id`

### Part 4 — Wire up the runner at startup

Next.js doesn't have a clean "start me on app boot" hook in app-router land. Options:

- **`instrumentation.ts`** (Next.js 13+ standard): export a `register()` function that runs once at server startup. This is the right place. Add or modify `instrumentation.ts` at project root:

```ts
// instrumentation.ts (project root)
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startQueueRunner } = await import('./src/lib/queueRunner');
    startQueueRunner();
    console.log('[startup] Queue runner started');
  }
}
```

The `NEXT_RUNTIME` check ensures it only runs in Node.js, not edge runtime.

In `next.config.mjs`, ensure instrumentation is enabled (newer Next versions enable it by default; older versions need `experimental: { instrumentationHook: true }`). Check the project's current Next.js version and config; add the flag only if needed.

### Part 5 — Refactor existing submission routes

This is the meaty part. Each of `/api/generate`, `/api/generate-video`, `/api/projects/[id]/stitch` currently:

1. Validates input
2. Builds workflow
3. POSTs to ComfyUI directly
4. Streams SSE to the client with progress

After Phase 8, they:

1. Validate input
2. **Create a QueuedJob row with the payload** (status: pending)
3. Return 202 Accepted with `{ queuedJobId, status: 'pending' }`
4. (No more direct ComfyUI submission; runner handles that)
5. (No more SSE stream from this route; client subscribes to a separate stream — see Part 6)

The key extraction:

```ts
// src/app/api/generate/route.ts (image)
export async function POST(req: NextRequest): Promise<Response> {
  const params = await validateImageRequest(req);
  if ('error' in params) return Response.json(params, { status: 400 });
  
  // Create QueuedJob row
  const queued = await prisma.queuedJob.create({
    data: {
      mediaType: 'image',
      payloadJson: params as unknown as Prisma.InputJsonValue,
      projectId: params.projectId ?? null,
      // generationId — will be created later by submitImageJob
    },
  });
  
  return Response.json({ queuedJobId: queued.id, status: 'pending' }, { status: 202 });
}
```

The actual workflow-build + ComfyUI-submit logic moves to `submitImageJob(queuedJob)` in `queueRunner.ts` (or a sibling helper file). It's the same code, just relocated and called from the runner instead of the route.

For video and stitch, the same pattern.

### Part 6 — SSE for queue progress

The client today subscribes to per-generation SSE streams from `/api/generate` etc. After Phase 8, those routes return immediately. The client needs a different SSE source.

Option A: The QueueContext polls `/api/queue/active` at 5s intervals (extension of today's pattern). Works for completion, but progress updates lag up to 5s.

Option B: A new `/api/queue/events` SSE endpoint that streams all queue state changes. Single connection, real-time.

**Go with Option A for first cut.** Today's `/api/jobs/active` polling is the documented refresh-survivability pattern. Extending it to also track queued jobs is consistent. The 5s lag for progress is acceptable for video gen (3-min jobs); for image gen (30-second jobs), it's a bit choppy but tolerable. Real-time SSE events are a follow-up if needed.

Update `/api/jobs/active` (or rename to `/api/queue/active`) to return:

```ts
{
  jobs: Array<{
    queuedJobId: string;          // QueuedJob.id
    promptId: string | null;      // ComfyUI prompt_id (null while pending)
    mediaType: 'image' | 'video' | 'stitch';
    status: QueuedJobStatus;       // pending/submitted/running/complete/failed/cancelled
    progress: { current: number; total: number } | null;
    promptSummary: string;
    createdAt: string;
    submittedAt: string | null;
    startedAt: string | null;
    runningSince: string | null;   // for elapsed timer
    queuePosition: number | null;  // 1-indexed display: "1 of 5 queued"; null if not pending
    retryCount: number;
    lastFailReason: string | null;
  }>;
}
```

The `queuePosition` is computed at endpoint call time:

```ts
const pendingJobs = jobs.filter(j => j.status === 'pending').sort((a, b) => 
  a.position - b.position || a.createdAt - b.createdAt);
pendingJobs.forEach((j, i) => { j.queuePosition = i + 1; });
```

The endpoint merges QueuedJob rows with manager.getActiveJobs() output (for progress on the running job).

### Part 7 — Cancel endpoint

`DELETE /api/queue/[queuedJobId]`:

```ts
export async function DELETE(req, { params }) {
  const { queuedJobId } = await params;
  const job = await prisma.queuedJob.findUnique({ where: { id: queuedJobId } });
  if (!job) return Response.json({ error: 'Not found' }, { status: 404 });
  
  if (job.status === 'pending' || job.status === 'submitted') {
    // Soft cancel — never reaches GPU, or in transit
    await prisma.queuedJob.update({
      where: { id: queuedJobId },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    
    // If submitted, also try to remove from ComfyUI's queue (best-effort)
    if (job.promptId) {
      void fetch(`${COMFYUI_URL}/queue`, {
        method: 'POST',
        body: JSON.stringify({ delete: [job.promptId] }),
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => { /* fine if it's already running */ });
    }
  } else if (job.status === 'running') {
    // Hard cancel — interrupt ComfyUI
    if (job.promptId) {
      ComfyWSManager.getInstance().abortJob(job.promptId);
    }
    await prisma.queuedJob.update({
      where: { id: queuedJobId },
      data: { status: 'cancelled', finishedAt: new Date(), lastFailReason: 'aborted' },
    });
  }
  // For complete/failed/cancelled: no-op, return success
  
  return Response.json({ ok: true });
}
```

The existing per-prompt abort (used by the queue tray's × button) keeps working — but now it should call this endpoint instead of `/api/jobs/[promptId]/abort` directly. Update QueueTray's cancel handler.

### Part 8 — Storyboard auto-retry composition

The storyboard "Generate keyframes (N needed)" already loops over scenes and submits N image jobs. After Phase 8, each submission becomes a QueuedJob row. The runner processes them one at a time.

For the user this means:
- Click "Generate keyframes (10 needed)" → 10 QueuedJob rows created, all pending.
- Runner ticks → submits #1 → ComfyUI runs it → runner ticks → submits #2 → ...
- Mid-batch: VM dies. ComfyUI restarts. Reconcile: #6 was running, marked as pending+retry-once. #7-#10 still pending. Runner resumes from #6.
- One job lost (only the running one), nine continue normally.

No changes needed to the storyboard generation code beyond updating the submission helpers — they already submit per-scene; the queue runner serializes naturally.

Same for "Regenerate all keyframes" — submits N QueuedJobs; queue runs them serially; resilient to VM loss.

### Part 9 — Cleanup contract: VM startup hook (out of scope but worth flagging)

When a spot VM is preempted and restarted, Azure may preserve or wipe the disk depending on configuration. If preserved, there can be orphan files at `/models/ComfyUI/output/` from the running prompt that died.

This is **out of scope for this batch**. Out-of-scope notes will mention it. The existing disk-avoidance contract handles all normal failure paths; a VM startup `rm -f /models/ComfyUI/output/*` is operator hygiene, not app code.

If the user wants automatic VM-startup cleanup, add it via the `runonce.service` or equivalent on the VM image. Document the recommendation.

### Part 10 — UI changes

**Queue tray (`src/components/QueueTray.tsx`):**

Add visual distinction between pending and running jobs:
- Pending: small "Queued (1 of 5)" pill at top of the row, no progress bar yet, no elapsed timer
- Submitted: same pill changes to "Starting..." 
- Running: existing progress bar + elapsed timer
- Auto-retry indicator: small badge "(retry 1/1)" when `retryCount > 0` so user knows it's an automatically-retried job, not a fresh one

The cancel × button works for any non-terminal status (pending, submitted, running), not just running.

**Studio submit handlers (`src/components/Studio.tsx`):**

After submitting, the response is now `{ queuedJobId, status: 'pending' }`. The Studio submit handler:
1. Receives the queuedJobId
2. Adds a job entry to QueueContext with status='pending'
3. Polling effect picks it up from `/api/queue/active`, follows transitions

No more SSE consumer logic in Studio's submit handlers — the polling handles it.

**Storyboard submit handlers (`src/components/ProjectDetail.tsx`):**

Same pattern. Each scene's "Generate keyframe" submits, gets a queuedJobId, registers with QueueContext, polling picks it up.

### Part 11 — Auto-cleanup of completed QueuedJob rows

QueuedJob rows accumulate. Most stay relevant for ~60 seconds (so the queue tray can show recently-completed). Beyond that, they're DB clutter.

Add a cleanup job to the runner tick:

```ts
async function runnerTick() {
  // ... existing logic ...
  
  // Once per tick, also cleanup terminal jobs older than 5 minutes
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  await prisma.queuedJob.deleteMany({
    where: {
      status: { in: ['complete', 'failed', 'cancelled'] },
      finishedAt: { lt: cutoff },
    },
  });
}
```

Per-tick cleanup is cheap (5s) and bounds the table size. The 5-minute window matches the existing `RECENT_COMPLETED_TTL_MS` env var pattern; consider reusing that env var for symmetry.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `npx prisma db push` applies cleanly. New `QueuedJob` table exists with all listed fields.
- `instrumentation.ts` exists at project root and starts the queue runner on app boot.
- `src/lib/queueRunner.ts` exists with `startQueueRunner()`, runner tick logic, and submit helpers per media type.
- `/api/generate`, `/api/generate-video`, `/api/projects/[id]/stitch` return 202 with `{ queuedJobId }` on success — no more direct SSE streams.
- `/api/queue/active` (or renamed `/api/jobs/active`) returns the merged QueuedJob + manager active state per the documented shape.
- `DELETE /api/queue/[queuedJobId]` exists with the documented soft/hard cancel logic.
- Queue tray shows status differences for pending vs running (queue position pill for pending, progress bar for running, retry badge when retryCount > 0).
- Auto-cleanup of terminal QueuedJob rows > 5 minutes old runs each runner tick.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet + spot scenario):

1. **Schema migration.** `npx prisma db push`. Confirm `QueuedJob` table in DB.

2. **Single image happy path.** Submit one image generation. Tray shows "Queued (1 of 1)" briefly, transitions to running, completes. Generation appears in gallery.

3. **Batch image path.** Submit batch=4 images. Tray shows "Queued (1 of 4)", "Queued (2 of 4)", etc. Jobs run serially (one at a time on ComfyUI). All 4 complete.

4. **Mixed batch.** Generate 2 images, then immediately 2 videos. 4 QueuedJobs created. Runner processes them in order. All complete.

5. **Cancel pending.** Submit batch=4. While #1 is running, cancel #4 from tray. Confirm: #4 marked cancelled, runner skips it when its turn comes. #2 and #3 still run.

6. **Cancel running.** Submit one job. While running, cancel from tray. Confirm: ComfyUI receives interrupt, job marked cancelled, runner picks up next pending (none) and idles.

7. **Storyboard keyframes batch.** In a project with a 10-scene storyboard, click "Generate keyframes (10 needed)". 10 QueuedJobs created. Runner processes them one at a time. Storyboard cards update as each keyframe lands. All 10 complete in sequence.

8. **VM-loss simulation (the load-bearing test).** Start a 10-scene keyframe batch. While job #4 is running (verify via tray), kill the SSH tunnel or stop ComfyUI on the VM (`ssh <vm> sudo systemctl stop comfyui`). Wait 30 seconds. Restart it (`ssh <vm> sudo systemctl start comfyui`). Confirm:
   - WS reconnects within ~5s
   - Reconcile detects job #4 was running → not in active jobs → marks pending with retry=1
   - Runner picks up #4 again, submits to ComfyUI
   - #4 runs from scratch, completes
   - #5-#10 process normally afterward
   - Final result: 10 keyframes generated, 1 was retried

9. **VM-loss with retry exhausted.** After step 8 completes, manually update DB to set retryCount=1 on a pending QueuedJob. Then trigger another VM-loss while it's running. Confirm: this time it's marked failed (not retry), runner skips and moves on.

10. **Page reload during pending queue.** Submit batch=4. Reload page while #2 is running. Tray repopulates from `/api/queue/active`. Pending #3 and #4 still show. #2 resumes its progress display.

11. **Reload after VM loss.** Submit batch=4. Trigger VM loss. Reload page DURING the VM-down window (before reconnect). Tray shows the in-flight job as "submitted" or stale state. After reconnect + reconcile, tray updates. No stuck jobs.

12. **Queue cleanup.** Submit and complete several jobs. Wait 5 minutes. Query `SELECT COUNT(*) FROM "QueuedJob"`. Confirm terminal-state rows older than 5 min are cleaned up.

13. **Disk-avoidance regression.** After all the testing, `ssh <vm> ls /models/ComfyUI/output/` returns "no such file." Especially important after VM-loss tests — confirm the cleanup contract didn't drop anything.

---

## Out of scope

- **Reorder pending jobs.** Position field exists but no UI to reorder. Future polish.
- **Pause/resume the queue.** Not in this batch.
- **Edit a queued job before it runs.** Not in this batch.
- **Retry policy beyond 1 retry on vm_lost.** Other failure modes (workflow_error, llm_error, aborted) never auto-retry. This is intentional — non-VM failures are usually deterministic and would loop.
- **Real-time SSE for queue events.** Polling at 5s is the recovery mechanism; same lag as today's reattach. Real-time SSE is a follow-up if needed.
- **VM startup cleanup hook (rm -f /models/ComfyUI/output/* on boot).** Operator hygiene, not app code.
- **Multi-VM support / load balancing across multiple ComfyUI instances.** Single ComfyUI instance assumption stays.
- **A queue-history view in Admin.** Cleanup deletes rows after 5 min; if you want a permanent log, that's a separate logging table.
- **Configurable retry counts via env var.** Hardcoded `MAX_RETRIES_FOR_VM_LOSS = 1`. If different is needed later, env-var it.
- **Custom ordering rules** (priority, user-pinned, etc.). Pure FIFO by position+createdAt.
- **Concurrent ComfyUI prompts.** Today ComfyUI handles one at a time; the runner enforces one-at-a-time at the app level. If ComfyUI ever supported concurrency, the runner could submit N at once, but for now: one.
- **Detailed audit logs** of state transitions. Console logs only.

---

## Documentation

In CLAUDE.md, add a Phase 8 section after the existing Phase 7 sections:

> ## Phase 8 — Durable app-side queue (spot-resilience)
>
> Loom holds the generation queue in Postgres (`QueuedJob` table) instead of ComfyUI's in-memory queue. Only one job is submitted to ComfyUI at a time; the rest wait in the DB. When the GPU VM dies (Azure spot preemption or other outage), queued jobs survive — only the running job is lost, and is auto-retried once.
>
> **Architecture.** A queue runner (`src/lib/queueRunner.ts`) ticks every 5s. Per tick:
> 1. Check WS connectivity. If down, do nothing.
> 2. Reconcile: for any 'submitted'/'running' QueuedJob whose promptId isn't in manager's active jobs, mark as auto-retry (if retryCount < 1) or terminal failure.
> 3. If ComfyUI is idle, submit the oldest pending QueuedJob.
> 4. Cleanup terminal QueuedJob rows older than 5 minutes.
>
> **Routes refactored.** `/api/generate`, `/api/generate-video`, `/api/projects/[id]/stitch` now create a QueuedJob row and return 202 immediately. No more direct SSE from these routes; client polls `/api/queue/active` for status.
>
> **Submission helpers.** `submitImageJob`, `submitVideoJob`, `submitStitchJob` (in `queueRunner.ts`) extracted from the old route bodies. The runner calls these; the routes don't.
>
> **Cancel.** `DELETE /api/queue/[queuedJobId]` handles both soft cancel (pending/submitted) and hard cancel (running, via ComfyUI interrupt).
>
> **Auto-retry.** Only `lastFailReason: 'vm_lost'` triggers auto-retry, capped at 1 retry. Other failure modes (workflow_error, llm_error, aborted) are terminal.
>
> **Startup.** `instrumentation.ts` calls `startQueueRunner()` on Node.js app boot (idempotent — safe across hot-reloads).

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
