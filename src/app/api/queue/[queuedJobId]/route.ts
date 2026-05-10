import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getComfyWSManager } from '@/lib/comfyws';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ queuedJobId: string }> },
) {
  const { queuedJobId } = await params;

  const job = await prisma.queuedJob.findUnique({ where: { id: queuedJobId } });
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  if (job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') {
    return NextResponse.json({ ok: true, note: 'Already terminal' });
  }

  const manager = getComfyWSManager();

  if (job.status === 'pending') {
    // Not yet submitted — just mark cancelled in DB; nothing to abort in ComfyUI
    await prisma.queuedJob.update({
      where: { id: queuedJobId },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  }

  // Job has a promptId — abort via manager (triggers ComfyUI /interrupt or /queue delete)
  if (job.promptId) {
    manager.abortJob(job.promptId);
  }

  // Mark cancelled in DB
  await prisma.queuedJob.update({
    where: { id: queuedJobId },
    data: { status: 'cancelled', finishedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
