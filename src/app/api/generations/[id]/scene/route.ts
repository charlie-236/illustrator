import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/** PATCH /api/generations/[id]/scene — set or clear the sceneId on a generation */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { sceneId: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!('sceneId' in body)) {
    return NextResponse.json({ error: 'sceneId is required' }, { status: 400 });
  }

  const sceneId = (body.sceneId as string | null | undefined) ?? null;
  if (sceneId !== null && typeof sceneId !== 'string') {
    return NextResponse.json({ error: 'sceneId must be a string or null' }, { status: 400 });
  }

  const generation = await prisma.generation.findUnique({ where: { id }, select: { id: true } });
  if (!generation) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  await prisma.generation.update({ where: { id }, data: { sceneId } });
  return NextResponse.json({ ok: true });
}
