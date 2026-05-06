'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatRecord, MessageRecord, SamplingPresetRecord, SamplingParams } from '@/types';
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

export default function ChatView({ chatId, onBack }: Props) {
  const [chat, setChat] = useState<ChatRecord | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const [composerText, setComposerText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const accumulatorRef = useRef('');
  const [streamingContent, setStreamingContent] = useState('');
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [tokenCount, setTokenCount] = useState(0);
  const [contextLimit, setContextLimit] = useState(64000);
  const tokenDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Settings sheet
  const [showSettings, setShowSettings] = useState(false);
  const [showPresetsManager, setShowPresetsManager] = useState(false);
  const [showAdvancedOverrides, setShowAdvancedOverrides] = useState(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [presets, setPresets] = useState<SamplingPresetRecord[]>([]);

  // Inline chat name editing
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Settings sheet state (mirrors chat fields locally for optimistic UI)
  const [settingsPresetId, setSettingsPresetId] = useState<string | null>(null);
  const [settingsOverrides, setSettingsOverrides] = useState<Partial<SamplingParams>>({});
  const [settingsSystemPrompt, setSettingsSystemPrompt] = useState('');
  const [settingsContextLimit, setSettingsContextLimit] = useState(64000);
  const settingsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load chat
  useEffect(() => {
    setLoading(true);
    fetch(`/api/chats/${chatId}`)
      .then((r) => r.json())
      .then((d: { chat: ChatRecord }) => {
        setChat(d.chat);
        setMessages(d.chat.messages);
        setContextLimit(d.chat.contextLimit);
        setSettingsPresetId(d.chat.samplingPresetId);
        setSettingsOverrides(d.chat.samplingOverridesJson ?? {});
        setSettingsSystemPrompt(d.chat.systemPromptOverride ?? '');
        setSettingsContextLimit(d.chat.contextLimit);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [chatId]);

  // Load presets when settings opens
  useEffect(() => {
    if (!showSettings) return;
    fetch('/api/sampling-presets')
      .then((r) => r.json())
      .then((d: { presets: SamplingPresetRecord[] }) => setPresets(d.presets))
      .catch(() => {});
  }, [showSettings]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingContent, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAutoScroll(atBottom);
  }, []);

  // Flush streaming content to React state
  const flushStreamContent = useCallback(() => {
    setStreamingContent(accumulatorRef.current);
    setAutoScroll(true);
  }, []);

  // Token counter with debounce
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
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !isSending && composerText.trim()) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleSend() {
    if (!composerText.trim() || isSending) return;

    const msgText = composerText.trim();
    const lastMsg = messages[messages.length - 1] ?? null;
    const parentMessageId = lastMsg?.id ?? null;

    setIsSending(true);
    setComposerText('');
    accumulatorRef.current = '';
    setStreamingContent('');

    const controller = new AbortController();
    abortControllerRef.current = controller;

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

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

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
            case 'user_message_saved': {
              const userMsg: MessageRecord = {
                id: data.id as string,
                chatId,
                role: 'user',
                content: msgText,
                parentMessageId,
                branchIndex: 0,
                createdAt: new Date().toISOString(),
              };
              setMessages((prev) => [...prev, userMsg]);
              break;
            }
            case 'assistant_message_started': {
              const assMsgId = data.id as string;
              const assMsg: MessageRecord = {
                id: assMsgId,
                chatId,
                role: 'assistant',
                content: '',
                parentMessageId: null,
                branchIndex: 0,
                createdAt: new Date().toISOString(),
              };
              setMessages((prev) => [...prev, assMsg]);
              setStreamingMsgId(assMsgId);
              setAutoScroll(true);
              break;
            }
            case 'token': {
              accumulatorRef.current += data.text as string;
              // Debounced re-render: flush every 250ms
              if (!renderTimerRef.current) {
                renderTimerRef.current = setTimeout(() => {
                  flushStreamContent();
                  renderTimerRef.current = null;
                }, 250);
              }
              break;
            }
            case 'done': {
              // Final flush
              if (renderTimerRef.current) {
                clearTimeout(renderTimerRef.current);
                renderTimerRef.current = null;
              }
              const finalContent = data.content as string;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === streamingMsgId ? { ...m, content: finalContent } : m,
                ),
              );
              setStreamingMsgId(null);
              setStreamingContent('');
              accumulatorRef.current = '';
              setTokenCount(data.tokenCount as number);
              break;
            }
            case 'error': {
              if (renderTimerRef.current) {
                clearTimeout(renderTimerRef.current);
                renderTimerRef.current = null;
              }
              const partial = accumulatorRef.current;
              if (partial && streamingMsgId) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamingMsgId ? { ...m, content: partial } : m,
                  ),
                );
              }
              setStreamingMsgId(null);
              setStreamingContent('');
              accumulatorRef.current = '';
              break;
            }
          }
        }
      }
    } catch (err) {
      // Client-side abort or network error
      if (renderTimerRef.current) {
        clearTimeout(renderTimerRef.current);
        renderTimerRef.current = null;
      }
      const partial = accumulatorRef.current;
      if (partial && streamingMsgId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamingMsgId ? { ...m, content: partial } : m,
          ),
        );
      }
      setStreamingMsgId(null);
      setStreamingContent('');
      accumulatorRef.current = '';
    } finally {
      setIsSending(false);
      abortControllerRef.current = null;
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

  const activePreset = presets.find((p) => p.id === settingsPresetId) ?? null;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-zinc-500 text-sm">Loading…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="sticky top-14 z-30 bg-zinc-950/90 backdrop-blur border-b border-zinc-800 px-4 py-3 flex items-center gap-3">
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
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 pt-6 pb-4"
      >
        {messages.length === 0 && !isSending && (
          <div className="text-center text-zinc-600 text-sm mt-12">
            <p>Direct the story. The LLM writes the prose.</p>
            <p className="mt-1 text-xs">Type an instruction and tap Send.</p>
          </div>
        )}

        {messages.map((msg) =>
          msg.id === streamingMsgId ? (
            <ChatMessage
              key={msg.id}
              message={msg}
              isStreaming={true}
              streamingContent={streamingContent}
            />
          ) : (
            <ChatMessage key={msg.id} message={msg} />
          ),
        )}

        {/* Stop button anchored near the bottom of the stream */}
        {isSending && streamingMsgId && (
          <div className="flex justify-center mb-4">
            <button
              onClick={handleStop}
              className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm px-5 min-h-10 rounded-full border border-zinc-700 transition-colors"
            >
              <span>■</span>
              <span>Stop</span>
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Composer */}
      <div className="sticky bottom-0 bg-zinc-950/95 backdrop-blur border-t border-zinc-800 px-4 py-3">
        <div className="flex gap-3 items-end">
          <textarea
            value={composerText}
            onChange={handleComposerChange}
            onKeyDown={handleComposerKeyDown}
            disabled={isSending}
            placeholder="What happens next?"
            rows={2}
            className="flex-1 input-base resize-none max-h-48 min-h-[56px] py-3 disabled:opacity-60"
          />
          <button
            onClick={isSending ? handleStop : handleSend}
            disabled={!isSending && !composerText.trim()}
            className={`min-h-12 min-w-12 rounded-xl font-medium text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              isSending
                ? 'bg-red-600 hover:bg-red-500 text-white px-4'
                : 'bg-violet-600 hover:bg-violet-500 text-white px-4'
            }`}
          >
            {isSending ? '■' : 'Send'}
          </button>
        </div>
        <p className="text-xs text-zinc-600 mt-1.5 text-right">Ctrl+Enter to send</p>
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
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-zinc-700" />
            </div>

            {/* Settings header */}
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
              {/* Sampling preset */}
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

              {/* Per-chat overrides */}
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

              {/* System prompt override */}
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

              {/* Context limit */}
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

              {/* Delete chat */}
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

      {/* Presets manager modal */}
      {showPresetsManager && (
        <SamplingPresetsManager
          onClose={() => setShowPresetsManager(false)}
          onPresetSaved={() => {
            // Reload presets
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
