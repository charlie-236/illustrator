'use client';

import { useEffect, useRef, useState } from 'react';

export type DeleteResourceType = 'project' | 'clip' | 'checkpoint' | 'lora' | 'embedding';

interface CascadeInfo {
  itemCount: number;
  stitchCount: number;
}

interface Props {
  open: boolean;
  resourceType: DeleteResourceType;
  resourceName: string;
  onConfirm: (cascade: boolean) => void;
  onCancel: () => void;
  warningMessage?: string;
  /** When provided, shows radio choice between keep-items and cascade delete. */
  cascadeInfo?: CascadeInfo;
}

export default function DeleteConfirmDialog({ open, resourceType, resourceName, onConfirm, onCancel, warningMessage, cascadeInfo }: Props) {
  const [inputValue, setInputValue] = useState('');
  const [cascade, setCascade] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const matched = inputValue === resourceName;

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setInputValue('');
      setCascade(false);
      // Focus input after the dialog animates in
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Keyboard handling
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      if (e.key === 'Enter' && matched) { e.preventDefault(); onConfirm(cascade); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, matched, cascade, onConfirm, onCancel]);

  if (!open) return null;

  const label = resourceType.charAt(0).toUpperCase() + resourceType.slice(1);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
      onClick={onCancel}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-sm shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-zinc-800 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-red-950/60 border border-red-800/50 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </div>
          <h2 className="text-base font-semibold text-zinc-100">Delete {label.toLowerCase()}?</h2>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Cascade radio — only for project deletes with cascadeInfo */}
          {cascadeInfo ? (
            <div className="space-y-2">
              <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium">What happens to this project&apos;s items?</p>
              <label className="flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors border-zinc-700 hover:border-zinc-600">
                <input
                  type="radio"
                  name="cascade-choice"
                  checked={!cascade}
                  onChange={() => setCascade(false)}
                  className="mt-0.5 accent-violet-500 flex-shrink-0"
                />
                <div>
                  <p className="text-sm font-medium text-zinc-200">Keep items</p>
                  <p className="text-xs text-zinc-500 mt-0.5">They&apos;ll remain in the gallery without project association</p>
                </div>
              </label>
              <label className="flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors border-zinc-700 hover:border-zinc-600">
                <input
                  type="radio"
                  name="cascade-choice"
                  checked={cascade}
                  onChange={() => setCascade(true)}
                  className="mt-0.5 accent-red-500 flex-shrink-0"
                />
                <div>
                  <p className="text-sm font-medium text-zinc-200">Delete everything</p>
                  <p className="text-xs text-zinc-500 mt-0.5">Items, stitched exports, and in-flight jobs all removed</p>
                </div>
              </label>

              {cascade ? (
                <div className="rounded-xl border border-red-800/50 bg-red-950/20 px-4 py-3 text-sm text-red-300 space-y-1">
                  <p className="font-medium text-red-200">This will permanently delete:</p>
                  <ul className="space-y-0.5 text-red-300/90 list-none">
                    <li>· The project <strong className="text-red-200 break-all">{resourceName}</strong></li>
                    {cascadeInfo.itemCount > 0 && (
                      <li>· <strong className="text-red-200">{cascadeInfo.itemCount}</strong> {cascadeInfo.itemCount === 1 ? 'item' : 'items'} (videos, images)</li>
                    )}
                    {cascadeInfo.stitchCount > 0 && (
                      <li>· <strong className="text-red-200">{cascadeInfo.stitchCount}</strong> stitched {cascadeInfo.stitchCount === 1 ? 'export' : 'exports'} made from this project</li>
                    )}
                    <li>· Any in-flight jobs related to this project will be aborted</li>
                  </ul>
                  <p className="text-red-400/80 text-xs mt-1">This cannot be undone.</p>
                </div>
              ) : (
                <p className="text-sm text-zinc-400 leading-relaxed">
                  The project <strong className="text-zinc-200 break-all">{resourceName}</strong> will be deleted.{' '}
                  {cascadeInfo.itemCount > 0 && (
                    <span>{cascadeInfo.itemCount} {cascadeInfo.itemCount === 1 ? 'item' : 'items'} will remain in the gallery without project association.</span>
                  )}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-zinc-300 leading-relaxed">
              This will permanently delete{' '}
              <strong className="text-zinc-100 break-all">{resourceName}</strong>.
              {warningMessage && (
                <>{' '}<span className="text-zinc-400">{warningMessage}</span></>
              )}
            </p>
          )}

          <div>
            <label className="label block mb-1.5">
              Type the {resourceType} name to confirm
            </label>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={resourceName}
              className="input-base text-sm"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 min-h-12 rounded-xl border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onConfirm(cascade)}
              disabled={!matched}
              className="flex-1 min-h-12 rounded-xl bg-red-700 hover:bg-red-600 active:scale-[0.98] text-white text-sm font-semibold transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:active:scale-100"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
