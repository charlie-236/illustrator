import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { projectId?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!('projectId' in body)) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  const newProjectId = (body.projectId as string | null | undefined) ?? null;

  const generation = await prisma.generation.findUnique({ where: { id } });
  if (!generation) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (newProjectId !== null) {
    const project = await prisma.project.findUnique({ where: { id: newProjectId } });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 400 });
    }
  }

  let newPosition: number | null = null;
  if (newProjectId !== null) {
    const agg = await prisma.generation.aggregate({
      where: { projectId: newProjectId, position: { not: null } },
      _max: { position: true },
    });
    newPosition = (agg._max.position ?? 0) + 1;
  }

  await prisma.generation.update({
    where: { id },
    data: { projectId: newProjectId, position: newPosition },
  });

  return NextResponse.json({ ok: true });
}
