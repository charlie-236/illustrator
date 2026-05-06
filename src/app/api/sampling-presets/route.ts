import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { SamplingParams } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUILT_IN_PRESETS: Array<{ name: string; paramsJson: SamplingParams }> = [
  {
    name: 'Balanced',
    paramsJson: {
      temperature: 1.1,
      min_p: 0.05,
      dry_multiplier: 0.8,
      dry_base: 1.75,
      dry_allowed_length: 2,
      max_tokens: 1500,
    },
  },
  {
    name: 'Wild',
    paramsJson: {
      temperature: 1.3,
      min_p: 0.03,
      dry_multiplier: 0.8,
      dry_base: 1.75,
      dry_allowed_length: 2,
      xtc_threshold: 0.1,
      xtc_probability: 0.5,
      max_tokens: 1500,
    },
  },
  {
    name: 'Coherent',
    paramsJson: {
      temperature: 0.9,
      min_p: 0.08,
      dry_multiplier: 0.8,
      dry_base: 1.75,
      dry_allowed_length: 2,
      max_tokens: 1500,
    },
  },
];

async function seedBuiltIns() {
  for (const preset of BUILT_IN_PRESETS) {
    const exists = await prisma.samplingPreset.findUnique({ where: { name: preset.name } });
    if (!exists) {
      await prisma.samplingPreset.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { ...preset, paramsJson: preset.paramsJson as any, isBuiltIn: true },
      });
    }
  }
}

export async function GET() {
  await seedBuiltIns();
  const presets = await prisma.samplingPreset.findMany({
    orderBy: [{ isBuiltIn: 'desc' }, { createdAt: 'asc' }],
  });
  return NextResponse.json({ presets });
}

export async function POST(req: NextRequest) {
  let body: { name: string; paramsJson: SamplingParams };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name || name.length === 0 || name.length > 60) {
    return NextResponse.json({ error: 'name must be 1–60 characters' }, { status: 400 });
  }

  try {
    const preset = await prisma.samplingPreset.create({
      data: {
        name,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        paramsJson: (body.paramsJson ?? {}) as any,
        isBuiltIn: false,
      },
    });
    return NextResponse.json({ preset }, { status: 201 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Unique constraint')) {
      return NextResponse.json({ error: 'A preset with that name already exists' }, { status: 409 });
    }
    console.error('[sampling-presets POST]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
