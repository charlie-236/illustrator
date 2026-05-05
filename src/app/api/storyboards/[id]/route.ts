import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { Storyboard, StoryboardScene } from '@/types';

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

function validateScenes(scenes: unknown): string | null {
  if (!Array.isArray(scenes)) return 'scenes must be an array';
  if (scenes.length > 50) return 'storyboard cannot have more than 50 scenes';
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i] as StoryboardScene;
    if (!scene || typeof scene !== 'object') return `scene[${i}] must be an object`;
    if (typeof scene.description !== 'string' || scene.description.trim() === '') {
      return `scene[${i}].description must be a non-empty string`;
    }
    if (typeof scene.positivePrompt !== 'string' || scene.positivePrompt.trim() === '') {
      return `scene[${i}].positivePrompt must be a non-empty string`;
    }
    if (!Number.isInteger(scene.durationSeconds) || scene.durationSeconds < 1 || scene.durationSeconds > 10) {
      return `scene[${i}].durationSeconds must be an integer 1-10`;
    }
    if ('notes' in scene && scene.notes !== null && scene.notes !== undefined && typeof scene.notes !== 'string') {
      return `scene[${i}].notes must be a string or null`;
    }
    if ('canonicalClipId' in scene && scene.canonicalClipId !== null && scene.canonicalClipId !== undefined && typeof scene.canonicalClipId !== 'string') {
      return `scene[${i}].canonicalClipId must be a string or null`;
    }
  }
  return null;
}

/** PUT /api/storyboards/[id] — atomically replace all storyboard fields */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { storyboard: Storyboard };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { storyboard } = body;
  if (!storyboard || typeof storyboard !== 'object') {
    return NextResponse.json({ error: 'storyboard must be an object' }, { status: 400 });
  }

  // Validate name
  if (typeof storyboard.name !== 'string' || storyboard.name.trim().length === 0 || storyboard.name.trim().length > 100) {
    return NextResponse.json({ error: 'name must be 1-100 characters' }, { status: 400 });
  }

  // Validate scenes
  const scenesError = validateScenes(storyboard.scenes);
  if (scenesError) return NextResponse.json({ error: scenesError }, { status: 400 });

  if (typeof storyboard.quickGenerate !== 'boolean') {
    return NextResponse.json({ error: 'quickGenerate must be a boolean' }, { status: 400 });
  }

  try {
    const updated = await prisma.storyboard.update({
      where: { id },
      data: {
        name: storyboard.name.trim(),
        scenesJson: storyboard.scenes as object[],
        storyIdea: storyboard.storyIdea ?? '',
        generatedAt: storyboard.generatedAt ? new Date(storyboard.generatedAt) : new Date(),
        quickGenerate: storyboard.quickGenerate,
      },
    });
    return NextResponse.json({ storyboard: serializeStoryboard(updated) });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'P2025') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    console.error('[PUT /api/storyboards/[id]]', err);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
}

/** DELETE /api/storyboards/[id] — delete a storyboard (clips with matching sceneId become orphans) */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await prisma.storyboard.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'P2025') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    console.error('[DELETE /api/storyboards/[id]]', err);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
}
