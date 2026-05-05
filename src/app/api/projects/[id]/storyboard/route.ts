import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { Storyboard, StoryboardScene } from '@/types';

export const dynamic = 'force-dynamic';

function parseStoryboardFromDb(json: unknown): Storyboard | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.scenes)) return null;
  return obj as unknown as Storyboard;
}

function serializeProject(project: {
  id: string;
  name: string;
  description: string | null;
  styleNote: string | null;
  defaultFrames: number | null;
  defaultSteps: number | null;
  defaultCfg: number | null;
  defaultWidth: number | null;
  defaultHeight: number | null;
  defaultLightning: boolean | null;
  defaultVideoLoras: string | null;
  storyboardJson: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    styleNote: project.styleNote,
    defaultFrames: project.defaultFrames,
    defaultSteps: project.defaultSteps,
    defaultCfg: project.defaultCfg,
    defaultWidth: project.defaultWidth,
    defaultHeight: project.defaultHeight,
    defaultLightning: project.defaultLightning,
    defaultVideoLoras: project.defaultVideoLoras
      ? (() => { try { return JSON.parse(project.defaultVideoLoras!); } catch { return null; } })()
      : null,
    storyboard: parseStoryboardFromDb(project.storyboardJson),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function validateStoryboard(storyboard: unknown): string | null {
  if (!storyboard || typeof storyboard !== 'object') return 'storyboard must be an object';
  const sb = storyboard as Record<string, unknown>;
  if (!Array.isArray(sb.scenes)) return 'storyboard.scenes must be an array';
  if (sb.scenes.length < 1 || sb.scenes.length > 20) return 'storyboard must have 1-20 scenes';
  for (let i = 0; i < sb.scenes.length; i++) {
    const scene = sb.scenes[i] as StoryboardScene;
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
    // Optional 5b fields: notes (string | null) and canonicalClipId (string | null)
    if ('notes' in scene && scene.notes !== null && scene.notes !== undefined && typeof scene.notes !== 'string') {
      return `scene[${i}].notes must be a string or null`;
    }
    if ('canonicalClipId' in scene && scene.canonicalClipId !== null && scene.canonicalClipId !== undefined && typeof scene.canonicalClipId !== 'string') {
      return `scene[${i}].canonicalClipId must be a string or null`;
    }
  }
  // Optional Phase 5c field on the storyboard object itself
  if ('quickGenerate' in sb && sb.quickGenerate !== null && sb.quickGenerate !== undefined && typeof sb.quickGenerate !== 'boolean') {
    return 'storyboard.quickGenerate must be a boolean or undefined';
  }
  return null;
}

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

  const validationError = validateStoryboard(body.storyboard);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  try {
    const project = await prisma.project.update({
      where: { id },
      data: { storyboardJson: body.storyboard as object },
    });
    return NextResponse.json({ project: serializeProject(project) });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'P2025') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    console.error('[PUT /api/projects/[id]/storyboard]', err);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const project = await prisma.project.update({
      where: { id },
      data: { storyboardJson: Prisma.JsonNull },
    });
    return NextResponse.json({ project: serializeProject(project) });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'P2025') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    console.error('[DELETE /api/projects/[id]/storyboard]', err);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
}
