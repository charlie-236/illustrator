import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';
import { STORYBOARD_SYSTEM_PROMPT, buildUserMessage } from './prompt';
import { parseStoryboard } from './parse';
import type { Storyboard } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StoryboardGenerateRequest {
  projectId: string;
  storyIdea: string;
  sceneCount?: number;
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string } }>;
}

async function callLLM(userPrompt: string): Promise<string> {
  const endpoint = process.env.LLM_ENDPOINT;
  const model = process.env.STORYBOARD_LLM_MODEL;
  if (!endpoint || !model) {
    throw new Error('LLM_ENDPOINT or STORYBOARD_LLM_MODEL not set');
  }

  const timeoutMs = parseInt(process.env.STORYBOARD_TIMEOUT_MS ?? '60000', 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: STORYBOARD_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: parseFloat(process.env.STORYBOARD_TEMPERATURE ?? '0.7'),
        top_p: parseFloat(process.env.STORYBOARD_TOP_P ?? '0.9'),
        max_tokens: parseInt(process.env.STORYBOARD_MAX_TOKENS ?? '3000', 10),
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = (await res.json()) as ChatCompletion;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('LLM returned empty content');
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: NextRequest) {
  let body: StoryboardGenerateRequest;
  try {
    body = (await req.json()) as StoryboardGenerateRequest;
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid_input', message: 'Invalid JSON body' });
  }

  // Validate storyIdea
  const storyIdea = body.storyIdea?.trim();
  if (!storyIdea || storyIdea.length === 0) {
    return NextResponse.json(
      { ok: false, reason: 'invalid_input', message: 'storyIdea is required' },
      { status: 400 },
    );
  }
  if (storyIdea.length > 4000) {
    return NextResponse.json(
      { ok: false, reason: 'invalid_input', message: 'storyIdea exceeds 4000 character limit' },
      { status: 400 },
    );
  }

  // Validate projectId
  if (!body.projectId) {
    return NextResponse.json(
      { ok: false, reason: 'invalid_input', message: 'projectId is required' },
      { status: 400 },
    );
  }

  // Validate sceneCount — clamp silently if outside 3-10
  const sceneCount = Math.max(3, Math.min(10, Math.round(body.sceneCount ?? 5)));

  // Check project exists, fetch styleNote for LLM context
  let styleNote: string | null = null;
  try {
    const project = await prisma.project.findUnique({
      where: { id: body.projectId },
      select: { id: true, styleNote: true },
    });
    if (!project) {
      return NextResponse.json(
        { ok: false, reason: 'project_not_found' },
        { status: 400 },
      );
    }
    styleNote = project.styleNote;
  } catch (err) {
    console.error('[storyboard/generate] DB lookup failed:', err);
    return NextResponse.json({ ok: false, reason: 'llm_error' });
  }

  // Build and call LLM
  const userMessage = buildUserMessage(storyIdea, styleNote, sceneCount);
  let raw: string;
  try {
    raw = await callLLM(userMessage);
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    console.warn('[storyboard/generate] LLM call failed:', err);
    return NextResponse.json({ ok: false, reason: isAbort ? 'timeout' : 'llm_error' });
  }

  // Parse the structured output
  const partialScenes = parseStoryboard(raw);
  if (!partialScenes) {
    console.warn('[storyboard/generate] parse failed. Raw output length:', raw.length);
    return NextResponse.json({ ok: false, reason: 'parse_error', rawOutput: raw });
  }
  if (partialScenes.length === 0) {
    return NextResponse.json({ ok: false, reason: 'no_scenes' });
  }

  // Build full storyboard (assign ids and positions — don't persist yet)
  const storyboard: Storyboard = {
    scenes: partialScenes.map((s, i) => ({
      id: randomBytes(8).toString('hex'),
      position: i,
      description: s.description,
      positivePrompt: s.positivePrompt,
      durationSeconds: s.durationSeconds,
    })),
    generatedAt: new Date().toISOString(),
    storyIdea,
  };

  return NextResponse.json({ ok: true, storyboard });
}
