import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const g = await prisma.generation.findUnique({ where: { id: params.id } });
    if (!g) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ...g, seed: g.seed.toString(), createdAt: g.createdAt.toISOString() });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
