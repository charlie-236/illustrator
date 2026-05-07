'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatRecord, MessageRecord, MessageWithBranchInfo, SamplingPresetRecord, SamplingParams, Suggestion } from '@/types';
import { resolveActivePath, decorateWithBranchInfo } from '@/lib/chatBranches';
import ChatMessage from './ChatMessage';
import SamplingPresetsManager from './SamplingPresetsManager';

interface Props {
  chatId: string;
  onBack: () => void;
}

function tokenCountColor(count: number, limit: number): string {
  const ratio = count / limit;
  if (ratio >= 0.95) return 'text-red-400';
  if (ratio >= 0.8) return 'text-amber-400';
  return 'text-zinc-500';
}

function formatTokenCount(count: number, limit: number): string {
  return `${count.toLocaleString()} / ${limit.toLocaleString()}`;
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex justify-between mb-1">
        <label className="label">{label}</label>
        <span className="text-xs text-zinc-400">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-violet-500"
      />
    </div>
  );
}

// ── Shared SSE stream consumer ────────────────────────────────────────────────

interface StreamCallbacks {
  onUserMessageSaved?: (id: string) => void;
  onAssistantMessageStarted: (id: string, parentMessageId: string | null, branchIndex: number) => void;
  onToken: (text: string) => void;
  onDone: (id: string, finalContent: string, tokenCount: number) => void;
  onError: (message: string, reason: string) => void;
}

async function consumeChatStream(
  responseBody: ReadableStream<Uint8Array>,
  callbacks: StreamCallbacks,
): Promise<void> {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assistantMsgId: string | null = null;
  let accumulatedContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const eventLine = part.split('\n').find((l) => l.startsWith('event: '));
      const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
      const eventName = eventLine?.slice(7).trim();
      const dataStr = dataLine?.slice(6).trim();
      if (!eventName || !dataStr) continue;

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(dataStr) as Record<string, unknown>;
      } catch {
        continue;
      }

      switch (eventName) {
        case 'user_message_saved':
          callbacks.onUserMessageSaved?.(data.id as string);
          break;
        case 'assistant_message_started':
          assistantMsgId = data.id as string;
          callbacks.onAssistantMessageStarted(
            assistantMsgId,
            (data.parentMessageId as string | null) ?? null,
            (data.branchIndex as number) ?? 0,
          );
          break;
        case 'token':
          accumulatedContent += data.text as string;
          callbacks.onToken(data.text as string);
          break;
        case 'done':
          callbacks.onDone(
            (data.id as string) ?? assistantMsgId ?? '',
            (data.content as string) ?? accumulatedContent,
            (data.tokenCount as number) ?? 0,
          );
          break;
        case 'error':
          callbacks.onError(data.message as string, data.reason as string);
          break;
      }
    }
  }
}

// ── ChatView ──────────────────────────────────────────────────────────────────

export default function ChatView({ chatId, onBack }: Props) {
  const [chat, setChat] = useState<ChatRecord | null>(null);
  const [allMessages, setAllMessages] = useState<MessageRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const [composerText, setComposerText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isRequestInFlight, setIsRequestInFlight] = useState(false);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const accumulatorRef = useRef('');
  const [streamingContent, setStreamingContent] = useState('');
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [tokenCount, setTokenCount] = useState(0);
  const [contextLimit, setContextLimit] = useState(64000);
  const tokenDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const listRef = useRef<HTMLDivElement>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [showPresetsManager, setShowPresetsManager] = useState(false);
  const [showAdvancedOverrides, setShowAdvancedOverrides] = useState(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [presets, setPresets] = useState<SamplingPresetRecord[]>([]);

  const [suggestionsLoading, setSuggestionsLoading] = useState<Set<string>>(new Set());

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [settingsPresetId, setSettingsPresetId] = useState<string | null>(null);
  const [settingsOverrides, setSettingsOverrides] = useState<Partial<SamplingParams>>({});
  const [settingsSystemPrompt, setSettingsSystemPrompt] = useState('');
  const [settingsContextLimit, setSettingsContextLimit] = useState(64000);
  const [settingsSuggestionsEnabled, setSettingsSuggestionsEnabled] = useState(true);
  const settingsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute active-path messages for display
  const activeBranches = chat?.activeBranchesJson ?? null;
  const activePath: MessageWithBranchInfo[] = decorateWithBranchInfo(
    resolveActivePath(allMessages, activeBranches),
    allMessages,
  );

  // ── Chat load ────────────────────────────────────────────────────────────

  async function loadChat() {
    try {
      const res = await fetch(`/api/chats/${chatId}`);
      if (!res.ok) return;
      const d = (await res.json()) as { chat: ChatRecord };
      setChat(d.chat);
      setAllMessages(d.chat.messages);
      setContextLimit(d.chat.contextLimit);
      setSettingsPresetId(d.chat.samplingPresetId);
      setSettingsOverrides(d.chat.samplingOverridesJson ?? {});
      setSettingsSystemPrompt(d.chat.systemPromptOverride ?? '');
      setSettingsContextLimit(d.chat.contextLimit);
      setSettingsSuggestionsEnabled(d.chat.suggestionsEnabled);
    } catch {
      // Non-fatal
    }
  }

  useEffect(() => {
    setLoading(true);
    loadChat().finally(() => setLoading(false));
  }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!showSettings) return;
    fetch('/api/sampling-presets')
      .then((r) => r.json())
      .then((d: { presets: SamplingPresetRecord[] }) => setPresets(d.presets))
      .catch(() => {});
  }, [showSettings]);

  const flushStreamContent = useCallback(() => {
    setStreamingContent(accumulatorRef.current);
  }, []);

  const updateTokenCount = useCallback(
    (text: string) => {
      if (tokenDebounceRef.current) clearTimeout(tokenDebounceRef.current);
      tokenDebounceRef.current = setTimeout(async () => {
        try {
          const res = await fetch(`/api/chats/${chatId}/tokenize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pendingUserMessage: text }),
          });
          if (res.ok) {
            const d = (await res.json()) as { tokenCount: number; contextLimit: number };
            setTokenCount(d.tokenCount);
            setContextLimit(d.contextLimit);
          }
        } catch {
          // Non-fatal
        }
      }, 500);
    },
    [chatId],
  );

  function handleComposerChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setComposerText(e.target.value);
    updateTokenCount(e.target.value);
  }

  function handleComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !isActive && composerText.trim()) {
      e.preventDefault();
      handleSend();
    }
  }

  // ── Streaming helpers ─────────────────────────────────────────────────────

  const isActive = isSending || isRequestInFlight;

  function beginStream(controller: AbortController) {
    abortControllerRef.current = controller;
    accumulatorRef.current = '';
    setStreamingContent('');
    setIsSending(true);
    setIsRequestInFlight(true);
  }

  function onToken(text: string) {
    accumulatorRef.current += text;
    if (!renderTimerRef.current) {
      renderTimerRef.current = setTimeout(() => {
        flushStreamContent();
        renderTimerRef.current = null;
      }, 250);
    }
  }

  function onStreamDone(msgId: string, finalContent: string, newTokenCount: number) {
    if (renderTimerRef.current) {
      clearTimeout(renderTimerRef.current);
      renderTimerRef.current = null;
    }
    setAllMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, content: finalContent } : m)),
    );
    setStreamingMsgId(null);
    setStreamingContent('');
    accumulatorRef.current = '';
    setTokenCount(newTokenCount);

    // Kick off suggestions in the background
    if (settingsSuggestionsEnabled) {
      void requestSuggestions(msgId);
    }
  }

  async function requestSuggestions(messageId: string) {
    setSuggestionsLoading((prev) => new Set(prev).add(messageId));
    try {
      const res = await fetch(
        `/api/chats/${chatId}/messages/${messageId}/suggestions`,
        { method: 'POST' },
      );
      if (!res.ok) throw new Error('Suggestions request failed');
      const data = (await res.json()) as { suggestions: Suggestion[] | null };

      if (data.suggestions) {
        setAllMessages((prev) =>
          prev.map((m) =>
            m.id === messageId ? { ...m, suggestionsJson: data.suggestions } : m,
          ),
        );
      }
    } catch (err) {
      console.warn('Suggestions request failed:', err);
    } finally {
      setSuggestionsLoading((prev) => {
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      });
    }
  }

  function onStreamError() {
    if (renderTimerRef.current) {
      clearTimeout(renderTimerRef.current);
      renderTimerRef.current = null;
    }
    const partial = accumulatorRef.current;
    if (partial && streamingMsgId) {
      setAllMessages((prev) =>
        prev.map((m) => (m.id === streamingMsgId ? { ...m, content: partial } : m)),
      );
    }
    setStreamingMsgId(null);
    setStreamingContent('');
    accumulatorRef.current = '';
  }

  function endStream() {
    setIsSending(false);
    setIsRequestInFlight(false);
    abortControllerRef.current = null;
  }

  // ── Send new message ──────────────────────────────────────────────────────

  async function handleSend() {
    if (!composerText.trim() || isActive) return;

    const msgText = composerText.trim();
    const lastMsg = activePath[activePath.length - 1] ?? null;
    const parentMessageId = lastMsg?.id ?? null;

    setComposerText('');
    const controller = new AbortController();
    beginStream(controller);

    // One-shot scroll to bottom so the user sees their just-sent message + incoming response
    setTimeout(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    }, 50);

    try {
      const res = await fetch(`/api/chats/${chatId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: msgText, parentMessageId }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errData.error ?? `HTTP ${res.status}`);
      }

      await consumeChatStream(res.body, {
        onUserMessageSaved: (id) => {
          const userMsg: MessageRecord = {
            id,
            chatId,
            role: 'user',
            content: msgText,
            parentMessageId,
            branchIndex: 0,
            suggestionsJson: null,
            createdAt: new Date().toISOString(),
          };
          setAllMessages((prev) => [...prev, userMsg]);
        },
        onAssistantMessageStarted: (id, parentMsgId, branchIndex) => {
          const assMsg: MessageRecord = {
            id,
            chatId,
            role: 'assistant',
            content: '',
            parentMessageId: parentMsgId,
            branchIndex,
            suggestionsJson: null,
            createdAt: new Date().toISOString(),
          };
          setAllMessages((prev) => [...prev, assMsg]);
          setStreamingMsgId(id);
        },
        onToken,
        onDone: onStreamDone,
        onError: onStreamError,
      });
    } catch {
      onStreamError();
    } finally {
      endStream();
      await loadChat();
    }
  }

  // ── Regenerate assistant message ──────────────────────────────────────────

  async function handleRegenerate(messageId: string) {
    if (isActive) return;

    const targetMsg = allMessages.find((m) => m.id === messageId);
    const controller = new AbortController();
    beginStream(controller);

    try {
      const res = await fetch(`/api/chats/${chatId}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      await consumeChatStream(res.body, {
        onAssistantMessageStarted: (id, parentMsgId, branchIndex) => {
          const newMsg: MessageRecord = {
            id,
            chatId,
            role: 'assistant',
            content: '',
            parentMessageId: parentMsgId ?? targetMsg?.parentMessageId ?? null,
            branchIndex,
            suggestionsJson: null,
            createdAt: new Date().toISOString(),
          };
          setAllMessages((prev) => [...prev, newMsg]);
          // Switch active branch to the new one so it appears in the active path
          if (parentMsgId !== null) {
            setChat((c) => {
              if (!c) return c;
              const existing = (c.activeBranchesJson as Record<string, number> | null) ?? {};
              return { ...c, activeBranchesJson: { ...existing, [parentMsgId]: branchIndex } };
            });
          }
          setStreamingMsgId(id);
        },
        onToken,
        onDone: (id, finalContent, newTokenCount) => {
          onStreamDone(id, finalContent, newTokenCount);
        },
        onError: onStreamError,
      });
    } catch {
      onStreamError();
    } finally {
      endStream();
      await loadChat();
    }
  }

  // ── Edit message ──────────────────────────────────────────────────────────

  async function handleEditSave(messageId: string, content: string, andContinue: boolean) {
    if (isActive) return;

    const targetMsg = allMessages.find((m) => m.id === messageId);
    const isUserMessage = targetMsg?.role === 'user';

    if (andContinue || isUserMessage) {
      // For user message edits: optimistically remove descendants + update content
      if (isUserMessage) {
        setAllMessages((prev) => {
          const descendantIds = new Set<string>();
          const queue = [messageId];
          while (queue.length > 0) {
            const curr = queue.shift()!;
            prev.filter((m) => m.parentMessageId === curr).forEach((c) => {
              descendantIds.add(c.id);
              queue.push(c.id);
            });
          }
          return prev
            .filter((m) => !descendantIds.has(m.id))
            .map((m) => (m.id === messageId ? { ...m, content } : m));
        });
      }

      const controller = new AbortController();
      beginStream(controller);

      try {
        const res = await fetch(`/api/chats/${chatId}/messages/${messageId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, ...(andContinue ? { andContinue: true } : {}) }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        await consumeChatStream(res.body, {
          onAssistantMessageStarted: (id, parentMsgId, branchIndex) => {
            const newMsg: MessageRecord = {
              id,
              chatId,
              role: 'assistant',
              content: '',
              parentMessageId: parentMsgId,
              branchIndex,
              suggestionsJson: null,
              createdAt: new Date().toISOString(),
            };
            setAllMessages((prev) => [...prev, newMsg]);
            // For assistant edit-and-continue: switch active branch to the new one
            if (!isUserMessage && parentMsgId !== null) {
              setChat((c) => {
                if (!c) return c;
                const existing = (c.activeBranchesJson as Record<string, number> | null) ?? {};
                return { ...c, activeBranchesJson: { ...existing, [parentMsgId]: branchIndex } };
              });
            }
            setStreamingMsgId(id);
          },
          onToken,
          onDone: onStreamDone,
          onError: onStreamError,
        });
      } catch {
        onStreamError();
      } finally {
        endStream();
        await loadChat();
      }
    } else {
      // JSON response (assistant plain save — no continuation)
      try {
        const res = await fetch(`/api/chats/${chatId}/messages/${messageId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        if (res.ok) {
          await loadChat();
        }
      } catch {
        // Non-fatal
      }
    }
  }

  // ── Delete assistant message ──────────────────────────────────────────────

  async function handleDeleteMessage(messageId: string) {
    if (isActive) return;
    try {
      const res = await fetch(`/api/chats/${chatId}/messages/${messageId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        const d = (await res.json()) as { chat: ChatRecord };
        setChat(d.chat);
        setAllMessages(d.chat.messages);
      }
    } catch {
      // Non-fatal
    }
  }

  // ── Branch switch ─────────────────────────────────────────────────────────

  async function handleBranchSwitch(parentMessageId: string, branchIndex: number) {
    if (isActive) return;
    try {
      const res = await fetch(`/api/chats/${chatId}/branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentMessageId, branchIndex }),
      });
      if (res.ok) {
        const d = (await res.json()) as { chat: ChatRecord };
        setChat(d.chat);
        setAllMessages(d.chat.messages);
      }
    } catch {
      // Non-fatal
    }
  }

  function handleStop() {
    abortControllerRef.current?.abort();
  }

  function startEditName() {
    setNameValue(chat?.name ?? '');
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.select(), 50);
  }

  async function saveName() {
    if (!chat || !nameValue.trim()) {
      setEditingName(false);
      return;
    }
    const trimmed = nameValue.trim();
    if (trimmed === chat.name) {
      setEditingName(false);
      return;
    }
    try {
      const res = await fetch(`/api/chats/${chatId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (res.ok) {
        setChat((c) => (c ? { ...c, name: trimmed } : c));
      }
    } catch {
      // Ignore
    }
    setEditingName(false);
  }

  function scheduleSettingsSave(patch: Record<string, unknown>) {
    if (settingsSaveTimerRef.current) clearTimeout(settingsSaveTimerRef.current);
    settingsSaveTimerRef.current = setTimeout(async () => {
      try {
        await fetch(`/api/chats/${chatId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
      } catch {
        // Non-fatal
      }
    }, 500);
  }

  async function handleDeleteChat() {
    if (!confirm(`Delete this chat? This cannot be undone.`)) return;
    await fetch(`/api/chats/${chatId}`, { method: 'DELETE' });
    onBack();
  }

  async function handlePresetChange(presetId: string | null) {
    setSettingsPresetId(presetId);
    await fetch(`/api/chats/${chatId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ samplingPresetId: presetId }),
    });
  }

  function handleOverrideChange(key: keyof SamplingParams, value: number | undefined) {
    const updated = { ...settingsOverrides, [key]: value };
    if (value === undefined) delete updated[key];
    setSettingsOverrides(updated);
    scheduleSettingsSave({ samplingOverridesJson: updated });
  }

  function handleSystemPromptBlur() {
    scheduleSettingsSave({ systemPromptOverride: settingsSystemPrompt || null });
  }

  function handleContextLimitBlur() {
    const val = settingsContextLimit;
    if (val >= 1024 && val <= 262144) {
      setContextLimit(val);
      scheduleSettingsSave({ contextLimit: val });
    }
  }

  async function handleSuggestionsToggle(enabled: boolean) {
    setSettingsSuggestionsEnabled(enabled);
    setChat((c) => (c ? { ...c, suggestionsEnabled: enabled } : c));
    try {
      await fetch(`/api/chats/${chatId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestionsEnabled: enabled }),
      });
    } catch {
      // Non-fatal
    }
  }

  const activePreset = presets.find((p) => p.id === settingsPresetId) ?? null;

  // Suggestions display logic
  const lastAssistantMsg = [...activePath].reverse().find((m) => m.role === 'assistant') ?? null;
  const showPills =
    settingsSuggestionsEnabled &&
    lastAssistantMsg != null &&
    composerText.trim().length === 0 &&
    !isActive;
  const pillsLoading = lastAssistantMsg != null && suggestionsLoading.has(lastAssistantMsg.id);
  const pillsAvailable = lastAssistantMsg?.suggestionsJson ?? null;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-zinc-500 text-sm">Loading…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-3.5rem)]">
      {/* Header */}
      <div className="flex-shrink-0 bg-zinc-950 border-b border-zinc-800 px-4 py-3 flex items-center gap-3">
        <button
          onClick={onBack}
          className="text-zinc-400 hover:text-zinc-200 min-h-10 min-w-10 flex items-center justify-center rounded-lg hover:bg-zinc-800 transition-colors"
          aria-label="Back to chats"
        >
          ←
        </button>

        <div className="flex-1 min-w-0">
          {editingName ? (
            <input
              ref={nameInputRef}
              className="bg-zinc-800 text-zinc-100 rounded-lg px-3 py-1.5 text-sm w-full min-h-9 focus:outline-none focus:ring-1 focus:ring-violet-500"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveName();
                if (e.key === 'Escape') setEditingName(false);
              }}
            />
          ) : (
            <button
              onClick={startEditName}
              className="flex items-center gap-2 min-h-9 text-left w-full group"
            >
              <span className="text-sm font-medium text-zinc-100 truncate">{chat?.name}</span>
              <span className="text-zinc-600 group-hover:text-zinc-400 text-xs transition-colors">
                ✏️
              </span>
            </button>
          )}
        </div>

        <button
          onClick={() => setShowSettings(true)}
          className={`text-sm min-h-10 px-2 rounded-lg transition-colors ${
            tokenCountColor(tokenCount, contextLimit)
          } hover:bg-zinc-800`}
        >
          {formatTokenCount(tokenCount, contextLimit)}
        </button>

        <button
          onClick={() => setShowSettings(true)}
          className="text-zinc-400 hover:text-zinc-200 min-h-10 min-w-10 flex items-center justify-center rounded-lg hover:bg-zinc-800 transition-colors"
          aria-label="Chat settings"
        >
          ⚙️
        </button>
      </div>

      {/* Message list */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto pt-6 pb-4"
      >
        <div className="chat-message-list px-4">
          {activePath.length === 0 && !isActive && (
            <div className="text-center text-zinc-600 text-sm mt-12">
              <p>Direct the story. The LLM writes the prose.</p>
              <p className="mt-1 text-xs">Type an instruction and tap Send.</p>
            </div>
          )}

          {activePath.map((msg) => (
            <ChatMessage
              key={`${msg.id}-${msg.branchIndex}`}
              message={msg}
              isStreaming={msg.id === streamingMsgId}
              streamingContent={msg.id === streamingMsgId ? streamingContent : undefined}
              chatId={chatId}
              onBranchSwitch={handleBranchSwitch}
              onRegenerate={handleRegenerate}
              onEditSave={handleEditSave}
              onDelete={handleDeleteMessage}
              isActionDisabled={isActive}
            />
          ))}

        </div>
      </div>

      {/* Composer */}
      <div className="flex-shrink-0 bg-zinc-950 border-t border-zinc-800 pt-2 pb-3">
        <div className="chat-message-list px-4">
          {/* Suggested next prompts */}
          {showPills && (
            <div className="suggestions-row">
              {pillsLoading ? (
                <>
                  <div className="suggestion-skeleton" />
                  <div className="suggestion-skeleton" />
                  <div className="suggestion-skeleton" />
                </>
              ) : pillsAvailable && pillsAvailable.length > 0 ? (
                pillsAvailable.map((s, i) => (
                  <button
                    key={i}
                    className="suggestion-pill"
                    onClick={() => {
                      setComposerText(s.prompt);
                      updateTokenCount(s.prompt);
                    }}
                  >
                    {s.label}
                  </button>
                ))
              ) : null}
            </div>
          )}

          <div className="flex gap-3 items-end">
            <textarea
              value={composerText}
              onChange={handleComposerChange}
              onKeyDown={handleComposerKeyDown}
              disabled={isActive}
              placeholder="What happens next?"
              rows={2}
              className="flex-1 input-base resize-none max-h-48 min-h-[56px] py-3 disabled:opacity-60"
            />
            <button
              onClick={isActive ? handleStop : handleSend}
              disabled={!isActive && !composerText.trim()}
              className={`min-h-12 min-w-12 rounded-xl font-medium text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                isActive
                  ? 'bg-red-600 hover:bg-red-500 text-white px-4'
                  : 'bg-violet-600 hover:bg-violet-500 text-white px-4'
              }`}
            >
              {isActive ? '■' : 'Send'}
            </button>
          </div>
          <p className="text-xs text-zinc-600 mt-1.5 text-right">Ctrl+Enter to send</p>
        </div>
      </div>

      {/* Settings sheet */}
      {showSettings && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end"
          onClick={() => setShowSettings(false)}
        >
          <div
            className="w-full bg-zinc-900 border-t border-zinc-800 rounded-t-2xl max-h-[88vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-zinc-700" />
            </div>

            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
              <h2 className="text-base font-semibold text-zinc-100">Chat Settings</h2>
              <button
                onClick={() => setShowSettings(false)}
                className="text-zinc-400 hover:text-zinc-200 min-h-10 min-w-10 flex items-center justify-center"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              <div>
                <label className="label mb-2">Sampling Preset</label>
                <select
                  className="input-base"
                  value={settingsPresetId ?? ''}
                  onChange={(e) => handlePresetChange(e.target.value || null)}
                >
                  <option value="">— None (use defaults) —</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.isBuiltIn ? ' (built-in)' : ''}
                    </option>
                  ))}
                </select>
                {activePreset && (
                  <p className="text-xs text-zinc-500 mt-1.5">
                    temp {activePreset.paramsJson.temperature} · min_p{' '}
                    {activePreset.paramsJson.min_p} ·{' '}
                    {(activePreset.paramsJson.dry_multiplier ?? 0) > 0 ? 'DRY on' : 'DRY off'} ·
                    max {activePreset.paramsJson.max_tokens}
                  </p>
                )}
                <div className="flex gap-3 mt-3">
                  <button
                    onClick={() => setShowPresetsManager(true)}
                    className="text-xs text-violet-400 hover:text-violet-300 min-h-8 px-2"
                  >
                    Manage presets
                  </button>
                </div>
              </div>

              <div className="border border-zinc-800 rounded-xl">
                <button
                  onClick={() => setShowAdvancedOverrides((v) => !v)}
                  className="w-full flex items-center justify-between px-4 min-h-12 text-sm text-zinc-300"
                >
                  <span>Per-chat overrides</span>
                  <span className="text-zinc-500">{showAdvancedOverrides ? '▲' : '▼'}</span>
                </button>
                {showAdvancedOverrides && (
                  <div className="px-4 pb-4 space-y-4 border-t border-zinc-800 pt-4">
                    <SliderRow
                      label="Temperature"
                      value={settingsOverrides.temperature ?? (activePreset?.paramsJson.temperature ?? 1.1)}
                      min={0}
                      max={2}
                      step={0.05}
                      onChange={(v) => handleOverrideChange('temperature', v)}
                    />
                    <SliderRow
                      label="min_p"
                      value={settingsOverrides.min_p ?? (activePreset?.paramsJson.min_p ?? 0.05)}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(v) => handleOverrideChange('min_p', v)}
                    />
                    <SliderRow
                      label="Max tokens"
                      value={settingsOverrides.max_tokens ?? (activePreset?.paramsJson.max_tokens ?? 1500)}
                      min={100}
                      max={8000}
                      step={100}
                      onChange={(v) => handleOverrideChange('max_tokens', v)}
                    />
                    <div>
                      <label className="label mb-1.5">DRY multiplier (0 = off)</label>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        max="2"
                        className="input-base"
                        value={settingsOverrides.dry_multiplier ?? (activePreset?.paramsJson.dry_multiplier ?? 0.8)}
                        onChange={(e) =>
                          handleOverrideChange('dry_multiplier', parseFloat(e.target.value))
                        }
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="border border-zinc-800 rounded-xl">
                <button
                  onClick={() => setShowSystemPrompt((v) => !v)}
                  className="w-full flex items-center justify-between px-4 min-h-12 text-sm text-zinc-300"
                >
                  <span>System prompt</span>
                  <span className="text-zinc-500">{showSystemPrompt ? '▲' : '▼'}</span>
                </button>
                {showSystemPrompt && (
                  <div className="px-4 pb-4 border-t border-zinc-800 pt-4">
                    <p className="text-xs text-zinc-500 mb-2">
                      Leave empty to use the canonical director-mode prompt.
                    </p>
                    <textarea
                      rows={8}
                      className="input-base font-mono text-xs resize-none"
                      value={settingsSystemPrompt}
                      onChange={(e) => setSettingsSystemPrompt(e.target.value)}
                      onBlur={handleSystemPromptBlur}
                      placeholder="Paste custom system prompt here, or leave empty for director mode…"
                    />
                  </div>
                )}
              </div>

              <div>
                <label className="label mb-1.5">Context limit (tokens)</label>
                <input
                  type="number"
                  min={1024}
                  max={262144}
                  className="input-base"
                  value={settingsContextLimit}
                  onChange={(e) => setSettingsContextLimit(parseInt(e.target.value, 10))}
                  onBlur={handleContextLimitBlur}
                />
                <p className="text-xs text-zinc-600 mt-1">
                  Token counter turns amber at 80%, red at 95%.
                </p>
              </div>

              <div className="border border-zinc-800 rounded-xl p-4">
                <div className="flex items-center justify-between min-h-12">
                  <div>
                    <p className="text-sm text-zinc-200">Suggested next prompts</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      Three suggestions appear above the composer after each response.
                    </p>
                  </div>
                  <button
                    onClick={() => handleSuggestionsToggle(!settingsSuggestionsEnabled)}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 min-w-[44px] ${
                      settingsSuggestionsEnabled ? 'bg-violet-600' : 'bg-zinc-700'
                    }`}
                    role="switch"
                    aria-checked={settingsSuggestionsEnabled}
                  >
                    <span
                      className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
                        settingsSuggestionsEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>

              <div className="pt-2 border-t border-zinc-800">
                <button
                  onClick={handleDeleteChat}
                  className="w-full min-h-12 rounded-xl text-red-400 border border-red-900/40 hover:bg-red-900/20 text-sm transition-colors"
                >
                  Delete chat
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showPresetsManager && (
        <SamplingPresetsManager
          onClose={() => setShowPresetsManager(false)}
          onPresetSaved={() => {
            fetch('/api/sampling-presets')
              .then((r) => r.json())
              .then((d: { presets: SamplingPresetRecord[] }) => setPresets(d.presets))
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
}
