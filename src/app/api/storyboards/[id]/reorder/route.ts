import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/** POST /api/storyboards/[id]/reorder — move this storyboard to a new position among siblings */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { position: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!Number.isInteger(body.position) || body.position < 0) {
    return NextResponse.json({ error: 'position must be a non-negative integer' }, { status: 400 });
  }

  const target = await prisma.storyboard.findUnique({ where: { id }, select: { id: true, projectId: true, position: true } });
  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const siblings = await prisma.storyboard.findMany({
    where: { projectId: target.projectId },
    orderBy: { position: 'asc' },
    select: { id: true, position: true },
  });

  // Reorder: remove current, insert at new position
  const others = siblings.filter((s) => s.id !== id);
  const newPos = Math.min(body.position, others.length);
  others.splice(newPos, 0, { id, position: newPos });

  // Assign sequential positions
  await prisma.$transaction(
    others.map((s, idx) => prisma.storyboard.update({ where: { id: s.id }, data: { position: idx } })),
  );

  return NextResponse.json({ ok: true });
}
