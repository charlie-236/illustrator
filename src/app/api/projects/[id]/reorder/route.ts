import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { clipOrder?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { clipOrder } = body;
  if (!Array.isArray(clipOrder) || clipOrder.some((x) => typeof x !== 'string')) {
    return NextResponse.json({ error: 'clipOrder must be an array of generation ID strings' }, { status: 400 });
  }

  // Validate all IDs belong to this project
  const existing = await prisma.generation.findMany({
    where: { projectId: id },
    select: { id: true },
  });

  const existingIds = new Set(existing.map((g) => g.id));

  if (clipOrder.length !== existing.length) {
    return NextResponse.json({ error: `clipOrder length ${clipOrder.length} does not match project clip count ${existing.length}` }, { status: 400 });
  }

  for (const clipId of clipOrder) {
    if (!existingIds.has(clipId)) {
      return NextResponse.json({ error: `Clip ${clipId} does not belong to this project` }, { status: 400 });
    }
  }

  // Update positions in a single transaction
  await prisma.$transaction(
    (clipOrder as string[]).map((clipId, index) =>
      prisma.generation.update({
        where: { id: clipId },
        data: { position: index },
      }),
    ),
  );

  return NextResponse.json({ ok: true });
}
