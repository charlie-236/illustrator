import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { SamplingParams } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let body: { name?: string; paramsJson?: SamplingParams };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const preset = await prisma.samplingPreset.findUnique({ where: { id: params.id } });
  if (!preset) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let validatedName: string | undefined;
  if (body.name !== undefined) {
    validatedName = body.name.trim();
    if (!validatedName || validatedName.length > 60) {
      return NextResponse.json({ error: 'name must be 1–60 characters' }, { status: 400 });
    }
  }

  try {
    const updated = await prisma.samplingPreset.update({
      where: { id: params.id },
      data: {
        ...(validatedName !== undefined ? { name: validatedName } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(body.paramsJson !== undefined ? { paramsJson: body.paramsJson as any } : {}),
      },
    });
    return NextResponse.json({ preset: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Unique constraint')) {
      return NextResponse.json({ error: 'A preset with that name already exists' }, { status: 409 });
    }
    console.error('[sampling-presets PATCH]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const preset = await prisma.samplingPreset.findUnique({ where: { id: params.id } });
  if (!preset) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (preset.isBuiltIn) {
    return NextResponse.json({ error: 'Built-in presets cannot be deleted' }, { status: 400 });
  }

  await prisma.samplingPreset.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
