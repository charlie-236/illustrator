'use client';

import { useEffect } from 'react';
import type { GenerationRecord } from '@/types';

interface Props {
  record: GenerationRecord;
  onClose: () => void;
}

export default function ImageModal({ record, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const date = new Date(record.createdAt).toLocaleString();

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm p-0 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800 sticky top-0 bg-zinc-900 z-10">
          <span className="text-sm font-medium text-zinc-300">Generation Details</span>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Image */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={record.filePath.startsWith('/generations/')
            ? `/api/images/${record.filePath.slice('/generations/'.length)}`
            : record.filePath}
          alt="Generated"
          className="w-full object-contain"
        />

        {/* Metadata */}
        <div className="p-4 space-y-3">
          <MetaRow label="Positive" value={record.promptPos} mono={false} />
          {record.promptNeg && <MetaRow label="Negative" value={record.promptNeg} mono={false} />}
          <div className="grid grid-cols-2 gap-2">
            <MetaRow label="Model" value={record.model} small />
            {record.lora && <MetaRow label="LoRA" value={record.lora} small />}
            <MetaRow label="Seed" value={record.seed} small />
            <MetaRow label="Steps" value={String(record.steps)} small />
            <MetaRow label="CFG" value={String(record.cfg)} small />
            <MetaRow label="Size" value={`${record.width}×${record.height}`} small />
            <MetaRow label="Sampler" value={record.sampler} small />
            <MetaRow label="Scheduler" value={record.scheduler} small />
          </div>
          <p className="text-xs text-zinc-600 text-right">{date}</p>
        </div>
      </div>
    </div>
  );
}

function MetaRow({ label, value, mono = true, small = false }: { label: string; value: string; mono?: boolean; small?: boolean }) {
  return (
    <div className={small ? '' : 'col-span-2'}>
      <dt className="text-xs text-zinc-500 mb-0.5">{label}</dt>
      <dd className={`text-sm text-zinc-200 break-words ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
