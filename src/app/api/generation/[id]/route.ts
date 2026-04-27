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
    const g = await prisma.generation.findUnique({ where: { id } });
    if (!g) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ...g, seed: g.seed.toString(), createdAt: g.createdAt.toISOString() });
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
  try {
    const g = await prisma.generation.findUnique({ where: { id } });
    if (!g) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Extract filename — handle both /api/images/<filename> and legacy /generations/<filename>
    const filename = g.filePath
      .replace('/api/images/', '')
      .replace('/generations/', '');
    if (filename && !filename.includes('..') && !filename.includes('/')) {
      const filePath = path.join(process.cwd(), 'public', 'generations', filename);
      await unlink(filePath).catch(() => { /* file already gone — that's fine */ });
    }

    await prisma.generation.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
