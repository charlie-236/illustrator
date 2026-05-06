import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { DIRECTOR_MODE_SYSTEM_PROMPT } from '@/lib/writerSystemPrompt';
import { resolveSamplingParams, samplingParamsForAphrodite } from '@/lib/writerSampling';
import { parseAphroditeStream } from '@/lib/aphroditeStream';
import { resolveActivePath } from '@/lib/chatBranches';
import type { SamplingParams, MessageRecord } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface EditRequest {
  content: string;
  andContinue?: boolean;
}

/**
 * Collect all descendant message IDs (BFS) from a given starting message.
 */
function collectDescendantIds(startId: string, allMessages: { id: string; parentMessageId: string | null }[]): string[] {
  const ids: string[] = [];
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = allMessages.filter((m) => m.parentMessageId === current);
    for (const child of children) {
      ids.push(child.id);
      queue.push(child.id);
    }
  }
  return ids;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; msgId: string } },
) {
  let body: EditRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const trimmedContent = body.content?.trim();
  if (!trimmedContent) {
    return new Response(JSON.stringify({ error: 'Content is required' }), { status: 400 });
  }

  const { id: chatId, msgId } = params;

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      samplingPreset: true,
      messages: { orderBy: [{ createdAt: 'asc' }, { branchIndex: 'asc' }] },
    },
  });

  if (!chat) {
    return new Response(JSON.stringify({ error: 'Chat not found' }), { status: 404 });
  }

  const target = chat.messages.find((m) => m.id === msgId);
  if (!target) {
    return new Response(JSON.stringify({ error: 'Message not found' }), { status: 404 });
  }

  // ── User message edit: hard truncate descendants ──────────────────────────
  if (target.role === 'user') {
    const descendantIds = collectDescendantIds(msgId, chat.messages);

    await prisma.$transaction(async (tx) => {
      if (descendantIds.length > 0) {
        await tx.message.deleteMany({ where: { id: { in: descendantIds } } });
      }
      await tx.message.update({
        where: { id: msgId },
        data: { content: trimmedContent },
      });
      // Clean up activeBranchesJson entries for now-deleted parents
      const existingBranches = (chat.activeBranchesJson as Record<string, number> | null) ?? {};
      const deadIds = new Set(descendantIds);
      const cleanedBranches = Object.fromEntries(
        Object.entries(existingBranches).filter(([k]) => !deadIds.has(k)),
      );
      await tx.chat.update({
        where: { id: chatId },
        data: { updatedAt: new Date(), activeBranchesJson: cleanedBranches },
      });
    });

    // Return updated chat
    const updatedChat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        samplingPreset: true,
        messages: { orderBy: [{ createdAt: 'asc' }, { branchIndex: 'asc' }] },
      },
    });
    return Response.json({ ok: true, chat: updatedChat });
  }

  // ── Assistant message edit: create new branch (optionally stream continuation) ──
  if (target.role !== 'assistant') {
    return new Response(JSON.stringify({ error: 'Cannot edit system messages' }), { status: 400 });
  }

  const siblings = chat.messages.filter((m) => m.parentMessageId === target.parentMessageId);
  const newBranchIndex = siblings.reduce((max, m) => Math.max(max, m.branchIndex), -1) + 1;
  const parentId = target.parentMessageId;
  const activeBranches = (chat.activeBranchesJson as Record<string, number> | null) ?? {};

  // Create the new branch message with the edited content
  const newMsg = await prisma.message.create({
    data: {
      chatId,
      role: 'assistant',
      content: trimmedContent,
      parentMessageId: parentId,
      branchIndex: newBranchIndex,
    },
  });

  const updatedBranches = {
    ...activeBranches,
    ...(parentId ? { [parentId]: newBranchIndex } : {}),
  };
  await prisma.chat.update({
    where: { id: chatId },
    data: { activeBranchesJson: updatedBranches, updatedAt: new Date() },
  });

  // Plain edit — return JSON immediately
  if (!body.andContinue) {
    const updatedChat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        samplingPreset: true,
        messages: { orderBy: [{ createdAt: 'asc' }, { branchIndex: 'asc' }] },
      },
    });
    return Response.json({ ok: true, newMessage: newMsg, chat: updatedChat });
  }

  // Edit-and-continue: stream a continuation from the edited prefix
  let aphroditeAbort: AbortController | null = null;
  let accumulated = trimmedContent; // starts with the edited content
  let cancelled = false;
  const encoder = new TextEncoder();
  const newAssistantMsgId = newMsg.id;

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
        send('assistant_message_started', { id: newAssistantMsgId });

        // Build context: active path from root up to the parent, then the new branch as last message
        const dbMessages: MessageRecord[] = chat.messages.map((m) => ({
          id: m.id,
          chatId: m.chatId,
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content,
          parentMessageId: m.parentMessageId,
          branchIndex: m.branchIndex,
          createdAt: m.createdAt.toISOString(),
        }));

        const activePath = resolveActivePath(dbMessages, activeBranches);
        const parentIndex = parentId ? activePath.findIndex((m) => m.id === parentId) : -1;
        const historyPath = parentId ? activePath.slice(0, parentIndex + 1) : [];

        const sampling = resolveSamplingParams(
          chat.samplingPreset?.paramsJson as SamplingParams | null ?? null,
          chat.samplingOverridesJson as Partial<SamplingParams> | null ?? null,
        );
        const systemPrompt = chat.systemPromptOverride ?? DIRECTOR_MODE_SYSTEM_PROMPT;

        // History ends with the assistant message (edited prefix) — Aphrodite continues from it
        const history = [
          { role: 'system', content: systemPrompt },
          ...historyPath.map((m) => ({ role: m.role, content: m.content })),
          { role: 'assistant', content: trimmedContent },
        ];

        const endpoint = process.env.WRITER_LLM_ENDPOINT;
        const model = process.env.WRITER_LLM_MODEL;

        if (!endpoint || !model) {
          send('error', { message: 'Writer LLM not configured', reason: 'llm_error' });
          controller.close();
          return;
        }

        const timeoutMs = parseInt(process.env.WRITER_TIMEOUT_MS ?? '300000', 10);
        aphroditeAbort = new AbortController();

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

        await prisma.message.update({
          where: { id: newAssistantMsgId },
          data: { content: accumulated },
        });
        await prisma.chat.update({
          where: { id: chatId },
          data: { updatedAt: new Date() },
        });

        if (!cancelled) {
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
          send('done', { id: newAssistantMsgId, content: accumulated, tokenCount });
        }
      } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        await prisma.message
          .update({ where: { id: newAssistantMsgId }, data: { content: accumulated } })
          .catch(() => {});
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
