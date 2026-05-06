'use client';

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { MessageRecord } from '@/types';

interface Props {
  message: MessageRecord;
  isStreaming?: boolean;
  streamingContent?: string;
}

function colorDialogueText(text: string): React.ReactNode {
  // Match straight double quotes or curly double quotes
  const parts = text.split(/(["“][^"“”]*["”])/g);
  if (parts.length === 1) return text;
  return (
    <>
      {parts.map((part, i) => {
        const isDialogue =
          (part.startsWith('"') || part.startsWith('“') || part.startsWith('“')) &&
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

export default function ChatMessage({ message, isStreaming, streamingContent }: Props) {
  const content = isStreaming ? (streamingContent ?? '') : message.content;
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[70%] bg-zinc-800/60 rounded-2xl px-4 py-3">
          <p className="text-sm text-zinc-400 italic leading-relaxed">{message.content}</p>
        </div>
      </div>
    );
  }

  const { prose, thinks } = extractThinkBlocks(content);

  return (
    <div className="mb-6">
      {thinks.map((think, i) => (
        <ThinkBlock key={i} content={think} />
      ))}
      <div className="prose-content text-zinc-100 text-[15px]">
        <ReactMarkdown components={MARKDOWN_COMPONENTS as Record<string, React.ElementType>}>
          {prose || (isStreaming ? '▊' : '')}
        </ReactMarkdown>
        {isStreaming && prose && <span className="animate-pulse">▊</span>}
      </div>
    </div>
  );
}
