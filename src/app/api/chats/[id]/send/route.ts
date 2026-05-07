import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { DIRECTOR_MODE_SYSTEM_PROMPT } from '@/lib/writerSystemPrompt';
import { resolveSamplingParams, samplingParamsForAphrodite } from '@/lib/writerSampling';
import { parseAphroditeStream } from '@/lib/aphroditeStream';
import { stripStopTokens } from '@/lib/stripStopTokens';
import type { SamplingParams } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ChatSendRequest {
  userMessage: string;
  parentMessageId: string | null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let body: ChatSendRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const trimmedMessage = body.userMessage?.trim();
  if (!trimmedMessage || trimmedMessage.length === 0) {
    return new Response(JSON.stringify({ error: 'Message is empty' }), { status: 400 });
  }
  if (trimmedMessage.length > 50000) {
    return new Response(JSON.stringify({ error: 'Message too long' }), { status: 400 });
  }

  const chatId = params.id;

  let aphroditeAbort: AbortController | null = null;
  let accumulated = '';
  let assistantMsgId = '';
  let cancelled = false;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: object) => {
        if (cancelled) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          cancelled = true;
        }
      };

      try {
        // Fetch chat with messages and preset
        const chat = await prisma.chat.findUnique({
          where: { id: chatId },
          include: {
            samplingPreset: true,
            messages: { orderBy: [{ createdAt: 'asc' }, { branchIndex: 'asc' }] },
          },
        });

        if (!chat) {
          send('error', { message: 'Chat not found', reason: 'not_found' });
          controller.close();
          return;
        }

        // Resolve sampling params
        const sampling = resolveSamplingParams(
          chat.samplingPreset?.paramsJson as SamplingParams | null ?? null,
          chat.samplingOverridesJson as Partial<SamplingParams> | null ?? null,
        );

        // Build message history for LLM
        const systemPrompt = chat.systemPromptOverride ?? DIRECTOR_MODE_SYSTEM_PROMPT;
        const history = [
          { role: 'system', content: systemPrompt },
          ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content: trimmedMessage },
        ];

        // Persist user message immediately
        const userMsg = await prisma.message.create({
          data: {
            chatId,
            role: 'user',
            content: trimmedMessage,
            parentMessageId: body.parentMessageId ?? null,
            branchIndex: 0,
          },
        });
        send('user_message_saved', { id: userMsg.id });

        // Create empty assistant message (gets filled in as tokens arrive)
        const assistantMsg = await prisma.message.create({
          data: {
            chatId,
            role: 'assistant',
            content: '',
            parentMessageId: userMsg.id,
            branchIndex: 0,
          },
        });
        assistantMsgId = assistantMsg.id;
        send('assistant_message_started', { id: assistantMsg.id, parentMessageId: userMsg.id, branchIndex: 0 });

        const endpoint = process.env.WRITER_LLM_ENDPOINT;
        const model = process.env.WRITER_LLM_MODEL;

        if (!endpoint || !model) {
          send('error', { message: 'Writer LLM not configured', reason: 'llm_error' });
          await prisma.message.update({
            where: { id: assistantMsgId },
            data: { content: '' },
          }).catch(() => {});
          controller.close();
          return;
        }

        const timeoutMs = parseInt(process.env.WRITER_TIMEOUT_MS ?? '300000', 10);
        aphroditeAbort = new AbortController();

        // Propagate client disconnect to Aphrodite
        const onAbort = () => {
          cancelled = true;
          aphroditeAbort?.abort();
        };
        req.signal.addEventListener('abort', onAbort);

        const timeoutId = setTimeout(() => aphroditeAbort?.abort(), timeoutMs);

        try {
          const aphroditeRes = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: aphroditeAbort.signal,
            body: JSON.stringify({
              model,
              messages: history,
              stream: true,
              ...samplingParamsForAphrodite(sampling),
            }),
          });

          if (!aphroditeRes.ok) {
            throw new Error(`Aphrodite HTTP ${aphroditeRes.status}`);
          }

          for await (const delta of parseAphroditeStream(aphroditeRes.body!)) {
            if (cancelled) break;
            accumulated += delta;
            send('token', { text: delta });
          }
        } finally {
          clearTimeout(timeoutId);
          req.signal.removeEventListener('abort', onAbort);
        }

        // Strip stop tokens and persist final content
        accumulated = stripStopTokens(accumulated);
        await prisma.message.update({
          where: { id: assistantMsgId },
          data: { content: accumulated },
        });

        // Bump chat updatedAt
        await prisma.chat.update({
          where: { id: chatId },
          data: { updatedAt: new Date() },
        });

        if (!cancelled) {
          // Get token count (best-effort)
          let tokenCount = 0;
          try {
            const tokenizeEndpoint = process.env.WRITER_LLM_TOKENIZE_ENDPOINT;
            if (tokenizeEndpoint) {
              const tokenRes = await fetch(tokenizeEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  model,
                  messages: [...history, { role: 'assistant', content: accumulated }],
                }),
                signal: AbortSignal.timeout(5000),
              });
              if (tokenRes.ok) {
                const tokenData = (await tokenRes.json()) as { count?: number; tokens?: unknown[] };
                tokenCount = tokenData.count ?? tokenData.tokens?.length ?? 0;
              }
            }
          } catch {
            // Non-fatal
          }

          send('done', { id: assistantMsgId, content: accumulated, tokenCount });
        }
      } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';

        // Save partial content (strip stop tokens defensively)
        if (assistantMsgId) {
          await prisma.message
            .update({ where: { id: assistantMsgId }, data: { content: stripStopTokens(accumulated) } })
            .catch(() => {});
        }

        if (!cancelled) {
          send('error', {
            message: isAbort ? 'Aborted' : 'Generation failed',
            reason: isAbort ? 'aborted' : 'llm_error',
          });
        }
      } finally {
        if (!cancelled) {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
      }
    },

    cancel() {
      cancelled = true;
      aphroditeAbort?.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
