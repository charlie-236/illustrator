'use client';

import React, { useState, useEffect, useCallback } from 'react';
import type { ChatSummary } from '@/types';
import ChatView from './ChatView';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function ChatsTab() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadChats = useCallback(() => {
    fetch('/api/chats')
      .then((r) => r.json())
      .then((d: { chats: ChatSummary[] }) => {
        setChats(d.chats);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadChats();
  }, [loadChats]);

  async function handleNewChat() {
    setCreating(true);
    try {
      const res = await fetch('/api/chats', { method: 'POST' });
      if (!res.ok) throw new Error('Failed');
      const d = (await res.json()) as { chat: { id: string } };
      setSelectedChatId(d.chat.id);
      loadChats();
    } catch {
      // Ignore
    } finally {
      setCreating(false);
    }
  }

  function handleBack() {
    setSelectedChatId(null);
    loadChats();
  }

  if (selectedChatId) {
    return <ChatView chatId={selectedChatId} onBack={handleBack} />;
  }

  return (
    <div className="px-4 pt-6 pb-24">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Chats</h1>
        <button
          onClick={handleNewChat}
          disabled={creating}
          className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 min-h-10 rounded-xl transition-colors"
        >
          {creating ? 'Creating…' : '+ New chat'}
        </button>
      </div>

      {loading && (
        <p className="text-zinc-500 text-sm text-center mt-12">Loading…</p>
      )}

      {!loading && chats.length === 0 && (
        <div className="text-center mt-16 space-y-4">
          <p className="text-zinc-400 text-base">Direct an LLM to write stories scene by scene.</p>
          <p className="text-zinc-600 text-sm">
            Tell it what happens; it expands into prose.
          </p>
          <button
            onClick={handleNewChat}
            disabled={creating}
            className="mt-4 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-6 min-h-12 rounded-xl transition-colors"
          >
            {creating ? 'Creating…' : '+ New chat'}
          </button>
        </div>
      )}

      {!loading && chats.length > 0 && (
        <div className="space-y-2">
          {chats.map((chat) => (
            <button
              key={chat.id}
              onClick={() => setSelectedChatId(chat.id)}
              className="w-full text-left bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-xl px-4 py-4 transition-colors min-h-16"
            >
              <p className="text-sm font-medium text-zinc-100 truncate">{chat.name}</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {chat.messageCount === 0
                  ? 'No messages'
                  : `${chat.messageCount} message${chat.messageCount === 1 ? '' : 's'}`}{' '}
                · last active {relativeTime(chat.updatedAt)}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
