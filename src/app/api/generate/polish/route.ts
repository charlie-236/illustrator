import { NextRequest, NextResponse } from "next/server";
import {
  POLISH_SYSTEM_PROMPT,
  POLISH_SAMPLING,
  POLISH_TIMEOUT_MS,
  STATIC_NEGATIVE,
} from "./prompt";
import { validatePreservation } from "./validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Frontend sends positivePrompt (not "prompt") — field name preserved from
// the existing Studio.tsx handlePolish payload.
interface PolishRequest {
  positivePrompt: string;
  negativeAdditions?: string;
}

interface PolishResponse {
  positive: string;
  negative: string;
  polished: boolean;
  reason?: "weight_drift" | "llm_error" | "timeout" | "parse_error";
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string } }>;
}

async function callLLM(userPrompt: string): Promise<string> {
  const endpoint = process.env.POLISH_LLM_ENDPOINT;
  const model = process.env.POLISH_LLM_MODEL;
  if (!endpoint || !model) {
    throw new Error("POLISH_LLM_ENDPOINT or POLISH_LLM_MODEL not set");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLISH_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: POLISH_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        ...POLISH_SAMPLING,
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`LLM HTTP ${res.status}`);
    }
    const data = (await res.json()) as ChatCompletion;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("LLM returned empty content");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse the LLM's [POSITIVE] / [NEGATIVE] block format.
 * Returns the positive section (without the [POSITIVE] header).
 * Negative is always replaced with STATIC_NEGATIVE downstream regardless
 * of what the LLM emitted, per RULE 3.
 */
function extractPositive(raw: string): string | null {
  const posMatch = raw.match(/\[POSITIVE\]\s*([\s\S]*?)(?=\n\[NEGATIVE\]|$)/);
  if (!posMatch) return null;
  const positive = posMatch[1].trim();
  return positive.length > 0 ? positive : null;
}

function fallback(
  userPrompt: string,
  negative: string,
  reason: PolishResponse["reason"],
): NextResponse<PolishResponse> {
  return NextResponse.json({
    positive: userPrompt,
    negative,
    polished: false,
    reason,
  });
}

export async function POST(req: NextRequest) {
  let body: PolishRequest;
  try {
    body = (await req.json()) as PolishRequest;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const userPrompt = body.positivePrompt?.trim();
  if (!userPrompt) {
    return NextResponse.json(
      { error: "Missing 'positivePrompt' field" },
      { status: 400 },
    );
  }

  const trimmedAdditions = body.negativeAdditions?.trim() ?? "";
  if (trimmedAdditions.length > 500) {
    return NextResponse.json(
      { error: "negativeAdditions exceeds 500 character limit" },
      { status: 400 },
    );
  }
  const negative = trimmedAdditions
    ? `${STATIC_NEGATIVE}, ${trimmedAdditions}`
    : STATIC_NEGATIVE;

  // First attempt.
  let raw: string;
  try {
    raw = await callLLM(userPrompt);
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    console.warn("[polish] LLM call failed:", err);
    return fallback(userPrompt, negative, isAbort ? "timeout" : "llm_error");
  }

  let positive = extractPositive(raw);
  if (positive) {
    const check = validatePreservation(userPrompt, positive);
    if (check.ok) {
      return NextResponse.json({ positive, negative, polished: true });
    }
    console.warn("[polish] weight drift on attempt 1:", check.missing);
  } else {
    console.warn("[polish] could not parse [POSITIVE] block on attempt 1");
  }

  // One retry.
  try {
    raw = await callLLM(userPrompt);
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    console.warn("[polish] LLM retry failed:", err);
    return fallback(userPrompt, negative, isAbort ? "timeout" : "llm_error");
  }

  positive = extractPositive(raw);
  if (!positive) {
    console.warn("[polish] could not parse [POSITIVE] block on retry");
    return fallback(userPrompt, negative, "parse_error");
  }

  const recheck = validatePreservation(userPrompt, positive);
  if (!recheck.ok) {
    console.warn("[polish] weight drift on retry, falling back:", recheck.missing);
    return fallback(userPrompt, negative, "weight_drift");
  }

  return NextResponse.json({ positive, negative, polished: true });
}
