import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLISH_URL = 'http://127.0.0.1:21434/v1/chat/completions';
const SYSTEM_PROMPT =
  "You are an expert Stable Diffusion prompt engineer. Take the user's short concept and expand it into a highly detailed, comma-separated image generation prompt. Include vivid environmental details, dynamic lighting, camera angles, and quality tags. Do not use conversational filler. Return ONLY the final comma-separated prompt string.";

export async function POST(req: NextRequest) {
  let body: { prompt: string };
  try {
    body = await req.json() as { prompt: string };
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return Response.json({ error: 'prompt is required' }, { status: 400 });
  }

  const signal = AbortSignal.timeout(90_000);

  try {
    const llmRes = await fetch(POLISH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.POLISH_LLM_MODEL ?? 'midnight-miqu',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: body.prompt.trim() },
        ],
        max_tokens: 400,
        temperature: 0.75,
        stream: false,
      }),
      signal,
    });

    if (!llmRes.ok) {
      const errText = await llmRes.text().catch(() => '');
      return Response.json(
        { error: `LLM returned ${llmRes.status}: ${errText.slice(0, 200)}` },
        { status: 502 },
      );
    }

    const data = await llmRes.json() as {
      choices?: { message?: { content?: string } }[];
    };

    const result = data.choices?.[0]?.message?.content?.trim();
    if (!result) {
      return Response.json({ error: 'LLM returned empty response' }, { status: 502 });
    }

    return Response.json({ result });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    return Response.json(
      { error: isTimeout ? 'LLM timed out after 90 s — try again' : `LLM request failed: ${String(err)}` },
      { status: isTimeout ? 504 : 502 },
    );
  }
}
