'use client';

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { MessageWithBranchInfo } from '@/types';

interface Props {
  message: MessageWithBranchInfo;
  isStreaming?: boolean;
  streamingContent?: string;
  chatId: string;
  // Callbacks from ChatView
  onBranchSwitch: (parentMessageId: string, branchIndex: number) => void;
  onRegenerate: (messageId: string) => void;
  onEditSave: (messageId: string, content: string, andContinue: boolean) => void;
  isActionDisabled?: boolean; // true while streaming — disables regenerate/edit
}

function colorDialogueText(text: string): React.ReactNode {
  const parts = text.split(/([""][^"""]*[""])/g);
  if (parts.length === 1) return text;
  return (
    <>
      {parts.map((part, i) => {
        const isDialogue =
          (part.startsWith('"') || part.startsWith('“') || part.startsWith('”')) &&
          part.length > 2;
        return isDialogue ? (
          <span key={i} className="text-violet-300">
            {part}
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        );
      })}
    </>
  );
}

function applyDialogueToChildren(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') return colorDialogueText(child);
    return child;
  });
}

const MARKDOWN_COMPONENTS = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-4 last:mb-0 leading-relaxed">{applyDialogueToChildren(children)}</p>
  ),
  em: ({ children }: { children?: React.ReactNode }) => (
    <em className="italic">{applyDialogueToChildren(children)}</em>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold">{applyDialogueToChildren(children)}</strong>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-xl font-semibold mb-3 mt-4">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-lg font-semibold mb-2 mt-4">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-base font-semibold mb-2 mt-3">{children}</h3>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc pl-5 mb-3 space-y-1">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal pl-5 mb-3 space-y-1">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="leading-relaxed">{applyDialogueToChildren(children)}</li>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-zinc-600 pl-4 my-3 text-zinc-400 italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-zinc-700 my-4" />,
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = className?.startsWith('language-');
    return isBlock ? (
      <pre className="bg-zinc-800 rounded-lg p-3 my-3 overflow-x-auto text-sm font-mono">
        <code>{children}</code>
      </pre>
    ) : (
      <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>
    );
  },
};

function extractThinkBlocks(content: string): { prose: string; thinks: string[] } {
  const thinks: string[] = [];
  const prose = content
    .replace(/<think>([\s\S]*?)<\/think>/g, (_, capture) => {
      thinks.push(capture as string);
      return '';
    })
    .trim();
  return { prose, thinks };
}

function ThinkBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-400 transition-colors min-h-8 px-2 py-1 rounded-md hover:bg-zinc-800"
      >
        <span>💭</span>
        <span>{expanded ? 'Thinking (tap to collapse)' : 'Thinking… (tap to expand)'}</span>
        <span className="ml-1">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="mt-1 px-3 py-2 bg-zinc-800/60 rounded-lg border border-zinc-700/50">
          <pre className="text-xs font-mono text-zinc-400 whitespace-pre-wrap leading-relaxed">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Branch navigation chevrons — shown when branchCount > 1 */
function BranchNav({
  message,
  onSwitch,
  disabled,
}: {
  message: MessageWithBranchInfo;
  onSwitch: (parentMessageId: string, branchIndex: number) => void;
  disabled?: boolean;
}) {
  if (message.branchCount <= 1) return null;

  const atFirst = message.branchIndex === 0;
  const atLast = message.branchPosition === message.branchCount;

  return (
    <div className="flex items-center gap-1 mb-2">
      <button
        onClick={() => !disabled && !atFirst && onSwitch(message.parentMessageId!, message.branchIndex - 1)}
        disabled={disabled || atFirst}
        aria-label="Previous branch"
        className="min-h-10 min-w-10 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        ‹
      </button>
      <span className="text-xs text-zinc-500 px-1 select-none">
        {message.branchPosition}/{message.branchCount}
      </span>
      <button
        onClick={() => !disabled && !atLast && onSwitch(message.parentMessageId!, message.branchIndex + 1)}
        disabled={disabled || atLast}
        aria-label="Next branch"
        className="min-h-10 min-w-10 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        ›
      </button>
    </div>
  );
}

export default function ChatMessage({
  message,
  isStreaming,
  streamingContent,
  chatId,
  onBranchSwitch,
  onRegenerate,
  onEditSave,
  isActionDisabled,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [confirmingUserEdit, setConfirmingUserEdit] = useState(false);

  const content = isStreaming ? (streamingContent ?? '') : message.content;
  const isUser = message.role === 'user';

  function startEdit() {
    setEditValue(message.content);
    setEditing(true);
    setConfirmingUserEdit(false);
  }

  function cancelEdit() {
    setEditing(false);
    setConfirmingUserEdit(false);
  }

  function handleUserSave() {
    if (!editValue.trim()) return;
    if (!confirmingUserEdit) {
      setConfirmingUserEdit(true);
      return;
    }
    setEditing(false);
    setConfirmingUserEdit(false);
    onEditSave(message.id, editValue.trim(), false);
  }

  function handleAssistantSave(andContinue: boolean) {
    if (!editValue.trim()) return;
    setEditing(false);
    onEditSave(message.id, editValue.trim(), andContinue);
  }

  // ── User message ──────────────────────────────────────────────────────────
  if (isUser) {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[70%]">
          <BranchNav message={message} onSwitch={onBranchSwitch} disabled={isActionDisabled} />

          {editing ? (
            <div className="bg-zinc-800/60 rounded-2xl px-4 py-3">
              <textarea
                className="input-base resize-none text-sm text-zinc-200 w-full min-h-[80px] max-h-48"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                autoFocus
              />
              {confirmingUserEdit && (
                <p className="text-xs text-amber-400 mt-2 mb-1">
                  Edit this message? Everything after it will be removed.
                </p>
              )}
              <div className="flex gap-2 mt-2 justify-end">
                <button
                  onClick={cancelEdit}
                  className="text-xs text-zinc-400 hover:text-zinc-200 min-h-9 px-3 rounded-lg hover:bg-zinc-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUserSave}
                  className={`text-xs min-h-9 px-3 rounded-lg font-medium transition-colors ${
                    confirmingUserEdit
                      ? 'bg-red-600 hover:bg-red-500 text-white'
                      : 'bg-violet-600 hover:bg-violet-500 text-white'
                  }`}
                >
                  {confirmingUserEdit ? 'Confirm edit' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-zinc-800/60 rounded-2xl px-4 py-3">
              <p className="text-sm text-zinc-400 italic leading-relaxed">{message.content}</p>
              {!isStreaming && !isActionDisabled && (
                <div className="flex justify-end mt-2">
                  <button
                    onClick={startEdit}
                    aria-label="Edit message"
                    className="text-xs text-zinc-600 hover:text-zinc-400 min-h-9 min-w-9 flex items-center justify-center rounded-lg hover:bg-zinc-700 transition-colors px-2"
                  >
                    ✏
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Assistant message ─────────────────────────────────────────────────────
  const { prose, thinks } = extractThinkBlocks(content);

  return (
    <div className="mb-6">
      <BranchNav message={message} onSwitch={onBranchSwitch} disabled={isActionDisabled} />

      {thinks.map((think, i) => (
        <ThinkBlock key={i} content={think} />
      ))}

      {editing ? (
        <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4">
          <textarea
            className="input-base resize-none text-sm text-zinc-100 w-full min-h-[120px] max-h-96 font-mono leading-relaxed"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            autoFocus
          />
          <div className="flex gap-2 mt-3 flex-wrap">
            <button
              onClick={cancelEdit}
              className="text-xs text-zinc-400 hover:text-zinc-200 min-h-9 px-3 rounded-lg hover:bg-zinc-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => handleAssistantSave(false)}
              className="text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-100 min-h-9 px-3 rounded-lg font-medium transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => handleAssistantSave(true)}
              className="text-xs bg-violet-600 hover:bg-violet-500 text-white min-h-9 px-4 rounded-lg font-medium transition-colors"
            >
              Save &amp; continue
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="prose-content text-zinc-100 text-[15px]">
            <ReactMarkdown components={MARKDOWN_COMPONENTS as Record<string, React.ElementType>}>
              {prose || (isStreaming ? '▊' : '')}
            </ReactMarkdown>
            {isStreaming && prose && <span className="animate-pulse">▊</span>}
          </div>

          {!isStreaming && !isActionDisabled && (
            <div className="flex gap-1 mt-2">
              <button
                onClick={startEdit}
                aria-label="Edit message"
                title="Edit"
                className="text-xs text-zinc-600 hover:text-zinc-400 min-h-9 min-w-9 flex items-center justify-center rounded-lg hover:bg-zinc-800 transition-colors px-2"
              >
                ✏
              </button>
              <button
                onClick={() => onRegenerate(message.id)}
                aria-label="Regenerate"
                title="Regenerate"
                className="text-xs text-zinc-600 hover:text-zinc-400 min-h-9 min-w-9 flex items-center justify-center rounded-lg hover:bg-zinc-800 transition-colors px-2"
              >
                ↺
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
