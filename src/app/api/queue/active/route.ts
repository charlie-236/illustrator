import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getComfyWSManager } from '@/lib/comfyws';
import type { ActiveQueueJobInfo, QueuedJobStatus } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RECENT_COMPLETED_TTL_MS = Number(process.env.RECENT_COMPLETED_TTL_MS) || 5 * 60 * 1000;

function derivePromptSummary(mediaType: string, payload: Record<string, unknown>): string {
  if (mediaType === 'image') {
    const p = typeof payload.positivePrompt === 'string' ? payload.positivePrompt : '';
    return p.slice(0, 60).trim() || 'Image generation';
  }
  if (mediaType === 'video') {
    const p = typeof payload.prompt === 'string' ? payload.prompt : '';
    return p.slice(0, 60).trim() || 'Video generation';
  }
  if (mediaType === 'stitch') {
    return 'Video stitch';
  }
  return 'Generation';
}

export async function GET() {
  const manager = getComfyWSManager();
  const liveJobs = manager.getActiveJobs();

  // Build lookup map: promptId → live manager info
  const liveByPromptId = new Map(
    liveJobs.filter((j) => j.promptId).map((j) => [j.promptId, j]),
  );

  const cutoff = new Date(Date.now() - RECENT_COMPLETED_TTL_MS);

  // Fetch: pending/submitted/running + recently-terminal rows
  const dbJobs = await prisma.queuedJob.findMany({
    where: {
      OR: [
        { status: { in: ['pending', 'submitted', 'running'] } },
        {
          status: { in: ['complete', 'failed', 'cancelled'] },
          finishedAt: { gte: cutoff },
        },
      ],
    },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });

  // Compute queue positions for pending jobs
  const pendingJobs = dbJobs.filter((j) => j.status === 'pending');

  const result: ActiveQueueJobInfo[] = dbJobs.map((job) => {
    const payload = job.payloadJson as Record<string, unknown>;
    const liveInfo = job.promptId ? liveByPromptId.get(job.promptId) : undefined;

    // Derive status: prefer live manager info for running jobs
    let status: QueuedJobStatus | 'completing';
    if (liveInfo) {
      // Manager knows 'queued' | 'running' | 'done' | 'error'
      // Map to our status union; the 'completing' signal comes from QueuedJob.status 'complete'
      // when manager still shows it as recently-completed
      const s = liveInfo.status;
      if (s === 'queued') status = 'running'; // from manager's perspective queued = submitted to ComfyUI
      else if (s === 'done') status = 'complete';
      else if (s === 'error') status = 'failed';
      else status = s as QueuedJobStatus;
    } else {
      status = job.status as QueuedJobStatus;
    }

    // Queue position among pending jobs (1-indexed); null if not pending
    const queuePosition = job.status === 'pending'
      ? pendingJobs.findIndex((p) => p.id === job.id) + 1
      : null;

    // Live progress + runningSince from manager (null if not live)
    const progress = liveInfo?.progress ?? null;
    const runningSince = liveInfo?.runningSince != null
      ? new Date(liveInfo.runningSince).toISOString()
      : null;

    // promptSummary: prefer manager's (already computed from assembled prompt)
    const promptSummary = liveInfo?.promptSummary ?? derivePromptSummary(job.mediaType, payload);

    return {
      queuedJobId: job.id,
      promptId: job.promptId,
      mediaType: job.mediaType as 'image' | 'video' | 'stitch',
      status,
      progress,
      promptSummary,
      createdAt: job.createdAt.toISOString(),
      submittedAt: job.submittedAt?.toISOString() ?? null,
      startedAt: job.startedAt?.toISOString() ?? null,
      runningSince,
      queuePosition,
      retryCount: job.retryCount,
      lastFailReason: job.lastFailReason,
      generationId: job.generationId ?? '',
    };
  });

  return NextResponse.json({ jobs: result });
}
