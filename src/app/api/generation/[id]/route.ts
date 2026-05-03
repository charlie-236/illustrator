import { NextRequest, NextResponse } from 'next/server';
import { unlink } from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/prisma';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const g = await prisma.generation.findUnique({
      where: { id },
      include: {
        project: { select: { name: true } },
        parentProject: { select: { name: true } },
      },
    });
    if (!g) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { project, parentProject, ...rest } = g;
    return NextResponse.json({
      ...rest,
      seed: rest.seed.toString(),
      createdAt: rest.createdAt.toISOString(),
      projectName: project?.name ?? null,
      parentProjectName: parentProject?.name ?? null,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { isFavorite?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof body.isFavorite !== 'boolean') {
    return NextResponse.json({ error: 'isFavorite must be a boolean' }, { status: 400 });
  }
  try {
    const g = await prisma.generation.update({
      where: { id },
      data: { isFavorite: body.isFavorite },
    });
    return NextResponse.json({ ...g, seed: g.seed.toString(), createdAt: g.createdAt.toISOString() });
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const IMAGE_OUTPUT_DIR = process.env.IMAGE_OUTPUT_DIR;
  if (!IMAGE_OUTPUT_DIR) {
    return NextResponse.json(
      { error: 'IMAGE_OUTPUT_DIR not configured' },
      { status: 500 },
    );
  }

  try {
    const g = await prisma.generation.findUnique({ where: { id } });
    if (!g) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const filename = g.filePath
      .replace('/api/images/', '')
      .replace('/generations/', '');
    if (filename && !filename.includes('..') && !filename.includes('/')) {
      const filePath = path.join(IMAGE_OUTPUT_DIR, filename);
      try {
        await unlink(filePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          console.error(`[generation/delete] unlink failed for ${filePath}:`, err);
        }
      }
    }

    await prisma.generation.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
