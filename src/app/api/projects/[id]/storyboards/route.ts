import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { Storyboard } from '@/types';

export const dynamic = 'force-dynamic';

function serializeStoryboard(sb: {
  id: string;
  projectId: string;
  name: string;
  scenesJson: unknown;
  storyIdea: string;
  generatedAt: Date;
  quickGenerate: boolean;
  position: number;
}): Storyboard {
  return {
    id: sb.id,
    projectId: sb.projectId,
    name: sb.name,
    scenes: (sb.scenesJson as Storyboard['scenes']) ?? [],
    storyIdea: sb.storyIdea,
    generatedAt: sb.generatedAt.toISOString(),
    quickGenerate: sb.quickGenerate,
    position: sb.position,
  };
}

/** POST /api/projects/[id]/storyboards — create a new empty storyboard */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { name?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }

  // Verify project exists
  const project = await prisma.project.findUnique({ where: { id }, select: { id: true } });
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Compute next position
  const maxPos = await prisma.storyboard.aggregate({
    where: { projectId: id },
    _max: { position: true },
  });
  const nextPosition = (maxPos._max.position ?? -1) + 1;

  // Count existing storyboards for default name
  const count = await prisma.storyboard.count({ where: { projectId: id } });
  const defaultName = count === 0 ? 'Storyboard' : `Storyboard ${count + 1}`;
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : defaultName;

  try {
    const sb = await prisma.storyboard.create({
      data: {
        projectId: id,
        name,
        scenesJson: [],
        storyIdea: '',
        generatedAt: new Date(),
        quickGenerate: false,
        position: nextPosition,
      },
    });
    return NextResponse.json({ storyboard: serializeStoryboard(sb) }, { status: 201 });
  } catch (err) {
    console.error('[POST /api/projects/[id]/storyboards]', err);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
}
