import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { SAMPLERS, SCHEDULERS } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const name = new URL(req.url).searchParams.get('name');

  // No name = return all configs (used by dropdowns to populate friendly names)
  if (!name) {
    try {
      const configs = await prisma.checkpointConfig.findMany();
      return NextResponse.json(configs);
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  try {
    const config = await prisma.checkpointConfig.findUnique({
      where: { checkpointName: name },
    });
    if (!config) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  let body: {
    checkpointName: string;
    friendlyName: string;
    baseModel?: string;
    defaultWidth: number;
    defaultHeight: number;
    defaultPositivePrompt: string;
    defaultNegativePrompt: string;
    description?: string;
    defaultSteps?: number | null;
    defaultCfg?: number | null;
    defaultSampler?: string | null;
    defaultScheduler?: string | null;
    defaultHrf?: boolean | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const {
    checkpointName, friendlyName, baseModel,
    defaultWidth, defaultHeight, defaultPositivePrompt, defaultNegativePrompt, description,
    defaultSteps, defaultCfg, defaultSampler, defaultScheduler, defaultHrf,
  } = body;

  if (!checkpointName) return NextResponse.json({ error: 'checkpointName required' }, { status: 400 });

  // Validate generation defaults
  if (defaultSteps != null) {
    if (!Number.isInteger(defaultSteps) || defaultSteps < 1 || defaultSteps > 80) {
      return NextResponse.json({ error: 'defaultSteps must be 1–80' }, { status: 400 });
    }
  }
  if (defaultCfg != null) {
    if (typeof defaultCfg !== 'number' || !Number.isFinite(defaultCfg) || defaultCfg < 1.0 || defaultCfg > 20.0) {
      return NextResponse.json({ error: 'defaultCfg must be 1.0–20.0' }, { status: 400 });
    }
  }
  if (defaultSampler != null && defaultSampler !== '') {
    if (!(SAMPLERS as readonly string[]).includes(defaultSampler)) {
      return NextResponse.json({ error: `defaultSampler must be one of: ${SAMPLERS.join(', ')}` }, { status: 400 });
    }
  }
  if (defaultScheduler != null && defaultScheduler !== '') {
    if (!(SCHEDULERS as readonly string[]).includes(defaultScheduler)) {
      return NextResponse.json({ error: `defaultScheduler must be one of: ${SCHEDULERS.join(', ')}` }, { status: 400 });
    }
  }

  const data = {
    friendlyName: friendlyName ?? '',
    baseModel: baseModel ?? '',
    defaultWidth,
    defaultHeight,
    defaultPositivePrompt,
    defaultNegativePrompt,
    description: description?.trim() || null,
    defaultSteps: defaultSteps ?? null,
    defaultCfg: defaultCfg ?? null,
    defaultSampler: defaultSampler || null,
    defaultScheduler: defaultScheduler || null,
    defaultHrf: defaultHrf ?? null,
  };
  try {
    const config = await prisma.checkpointConfig.upsert({
      where: { checkpointName },
      create: { checkpointName, ...data },
      update: data,
    });
    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
