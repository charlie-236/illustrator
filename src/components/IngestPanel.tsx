'use client';

import { useState } from 'react';
import { parseCivitaiUrl } from '@/lib/civitaiUrl';

// ── Types ─────────────────────────────────────────────────────────────────────

type Mode = 'single' | 'batch';
type ItemType = 'checkpoint' | 'lora';

interface PhaseEvent {
  phase: 'metadata' | 'download' | 'validate' | 'register' | 'done' | 'error';
  status?: string;
  friendlyName?: string;
  filename?: string;
  remotePath?: string;
  sizeBytes?: number;
  recordId?: string;
  message?: string;
  orphanPath?: string;
}

interface SingleState {
  type: ItemType;
  urlInput: string;
  parsedIds: { parentUrlId: number; modelId: number } | null;
  parseError: string | null;
  ingesting: boolean;
  events: PhaseEvent[];
  finalState: 'idle' | 'success' | 'error';
}

interface BatchRow {
  clientId: string;
  type: ItemType;
  urlInput: string;
  parsedIds: { parentUrlId: number; modelId: number } | null;
  parseError: string | null;
  events: PhaseEvent[];
  finalState: 'pending' | 'in-flight' | 'success' | 'error';
}

interface BatchState {
  rows: BatchRow[];
  ingesting: boolean;
  summary: { succeeded: number; failed: number; total: number } | null;
}

interface Props {
  onIngestComplete: () => void;
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (data: PhaseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const messages = buffer.split('\n\n');
    buffer = messages.pop() ?? '';
    for (const message of messages) {
      const dataLine = message.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      try {
        onEvent(JSON.parse(dataLine.slice(6)) as PhaseEvent);
      } catch { /* malformed chunk */ }
    }
  }
}

async function readSseStreamWithType(
  body: ReadableStream<Uint8Array>,
  onEvent: (eventType: string, data: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const messages = buffer.split('\n\n');
    buffer = messages.pop() ?? '';
    for (const message of messages) {
      const lines = message.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!eventLine || !dataLine) continue;
      try {
        onEvent(eventLine.slice(7), JSON.parse(dataLine.slice(6)));
      } catch { /* malformed chunk */ }
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function createBlankRow(): BatchRow {
  return {
    clientId: crypto.randomUUID(),
    type: 'lora',
    urlInput: '',
    parsedIds: null,
    parseError: null,
    events: [],
    finalState: 'pending',
  };
}

function countParseableRows(rows: BatchRow[]): number {
  return rows.filter((r) => r.parsedIds !== null).length;
}

function currentlyProcessingIndex(rows: BatchRow[]): number {
  const idx = rows.findIndex((r) => r.finalState === 'in-flight');
  return idx >= 0 ? idx + 1 : 0;
}

function applyUrlParse(value: string): { urlInput: string; parsedIds: { parentUrlId: number; modelId: number } | null; parseError: string | null } {
  if (!value.trim()) return { urlInput: value, parsedIds: null, parseError: null };
  const result = parseCivitaiUrl(value);
  if ('error' in result) return { urlInput: value, parsedIds: null, parseError: result.error };
  // Normalize civitai.red (and any other accepted mirror) to canonical civitai.com URL
  const urlInput = `https://civitai.com/models/${result.parentUrlId}?modelVersionId=${result.modelId}`;
  return { urlInput, parsedIds: result, parseError: null };
}

// ── Phase rendering ───────────────────────────────────────────────────────────

function PhaseIcon({ state }: { state: 'spinning' | 'success' | 'error' | 'pending' }) {
  const base = 'w-4 h-4 mt-0.5 flex-shrink-0';
  if (state === 'spinning') {
    return (
      <svg className={`${base} animate-spin text-zinc-400`} fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
      </svg>
    );
  }
  if (state === 'success') {
    return (
      <svg className={`${base} text-emerald-400`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (state === 'error') {
    return (
      <svg className={`${base} text-red-400`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }
  return <div className={`${base} rounded-full border-2 border-zinc-600`} />;
}

function PhaseLine({ event, freezeSpinner = false }: { event: PhaseEvent; freezeSpinner?: boolean }) {
  const isError = event.phase === 'error';
  const isDone = event.phase === 'done';

  let label = '';
  let icon: 'pending' | 'spinning' | 'success' | 'error' = 'pending';

  if      (event.phase === 'metadata' && event.status === 'fetching')     { label = 'Fetching metadata…'; icon = 'spinning'; }
  else if (event.phase === 'metadata' && event.status === 'ok')           { label = `Metadata: ${event.friendlyName}`; icon = 'success'; }
  else if (event.phase === 'download' && event.status === 'starting')     { label = `Downloading ${event.filename}…`; icon = 'spinning'; }
  else if (event.phase === 'download' && event.status === 'ok')           { label = 'Download complete'; icon = 'success'; }
  else if (event.phase === 'validate' && event.status === 'checking')     { label = 'Validating file…'; icon = 'spinning'; }
  else if (event.phase === 'validate' && event.status === 'ok')           { label = `File valid (${formatBytes(event.sizeBytes!)})`; icon = 'success'; }
  else if (event.phase === 'register' && event.status === 'writing')      { label = 'Saving to database…'; icon = 'spinning'; }
  else if (event.phase === 'register' && event.status === 'ok')           { label = 'Saved'; icon = 'success'; }
  else if (event.phase === 'done')                                        { label = 'Complete'; icon = 'success'; }
  else if (event.phase === 'error')                                       { label = event.message ?? 'Unknown error'; icon = 'error'; }

  // Stop any spinner once the stream has reached a terminal state
  const displayIcon = icon === 'spinning' && freezeSpinner ? 'pending' : icon;

  return (
    <div className={`flex items-start gap-2 text-sm ${isError ? 'text-red-300' : isDone ? 'text-emerald-300' : 'text-zinc-300'}`}>
      <PhaseIcon state={displayIcon} />
      <div className="flex-1 min-w-0">
        <p className="leading-snug">{label}</p>
        {isError && event.orphanPath && (
          <p className="text-xs text-red-400/80 mt-0.5 font-mono break-all">
            Orphan: {event.orphanPath}
          </p>
        )}
      </div>
    </div>
  );
}

function PhaseList({ events }: { events: PhaseEvent[] }) {
  // Keep only the last event per phase so each step shows its final state
  // (e.g. 'fetching' is replaced by 'ok' in place rather than both appearing)
  const dedupedMap = new Map<string, PhaseEvent>();
  for (const event of events) dedupedMap.set(event.phase, event);
  const deduped = [...dedupedMap.values()];

  // Once a terminal event arrives, freeze any step still showing a spinner
  const hasTerminal = deduped.some((e) => e.phase === 'error' || e.phase === 'done');

  return (
    <div className="space-y-1.5 pt-1 border-t border-zinc-800 mt-3">
      {deduped.map((event) => (
        <PhaseLine key={event.phase} event={event} freezeSpinner={hasTerminal} />
      ))}
    </div>
  );
}

// ── Type radio ────────────────────────────────────────────────────────────────

function TypeRadio({
  value,
  onChange,
  disabled,
}: {
  value: ItemType;
  onChange: (v: ItemType) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex gap-2">
      {(['checkpoint', 'lora'] as const).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          disabled={disabled}
          className={`flex-1 min-h-12 rounded-lg text-sm font-medium border transition-colors
            ${value === t
              ? 'bg-violet-600/20 text-violet-200 border-violet-600/50'
              : 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:bg-zinc-700'}
            disabled:opacity-40`}
        >
          {t === 'checkpoint' ? 'Checkpoint' : 'LoRA'}
        </button>
      ))}
    </div>
  );
}

// ── URL input + parse feedback ────────────────────────────────────────────────

function UrlInput({
  value,
  onChange,
  disabled,
  showIds,
  parsedIds,
  parseError,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  showIds: boolean;
  parsedIds: { parentUrlId: number; modelId: number } | null;
  parseError: string | null;
}) {
  return (
    <div className="space-y-1.5">
      <input
        type="text"
        inputMode="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://civitai.com/models/...?modelVersionId=..."
        disabled={disabled}
        className="input-base min-h-12 font-mono text-xs"
        spellCheck={false}
        autoCapitalize="off"
      />
      {parseError && value && (
        <p className="text-xs text-red-400">{parseError}</p>
      )}
      {parsedIds && showIds && (
        <div className="text-xs text-zinc-400 space-y-0.5">
          <p>Model version: <span className="text-zinc-200 tabular-nums">{parsedIds.modelId}</span></p>
          <p>Parent model: <span className="text-zinc-200 tabular-nums">{parsedIds.parentUrlId}</span></p>
        </div>
      )}
    </div>
  );
}

// ── SingleMode ────────────────────────────────────────────────────────────────

function SingleMode({ onIngestComplete }: { onIngestComplete: () => void }) {
  const [state, setState] = useState<SingleState>({
    type: 'lora',
    urlInput: '',
    parsedIds: null,
    parseError: null,
    ingesting: false,
    events: [],
    finalState: 'idle',
  });

  function handleUrlChange(value: string) {
    setState((s) => ({ ...s, ...applyUrlParse(value) }));
  }

  async function handleSubmit() {
    if (!state.parsedIds) return;
    const { type, parsedIds } = state;
    setState((s) => ({ ...s, ingesting: true, events: [], finalState: 'idle' }));

    let succeeded = false;

    try {
      const res = await fetch('/api/models/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          modelId: parsedIds.modelId,
          parentUrlId: parsedIds.parentUrlId,
        }),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => 'Unknown error');
        setState((s) => ({
          ...s,
          ingesting: false,
          finalState: 'error',
          events: [{ phase: 'error', message: `HTTP ${res.status}: ${errText}` }],
        }));
        return;
      }

      await readSseStream(res.body, (event) => {
        setState((s) => ({ ...s, events: [...s.events, event] }));
        if (event.phase === 'done') succeeded = true;
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        events: [...s.events, { phase: 'error', message: `Network error: ${String(err)}` }],
      }));
    }

    setState((s) => ({ ...s, ingesting: false, finalState: succeeded ? 'success' : 'error' }));
    if (succeeded) onIngestComplete();
  }

  return (
    <div className="card space-y-4">
      <TypeRadio
        value={state.type}
        onChange={(t) => setState((s) => ({ ...s, type: t }))}
        disabled={state.ingesting}
      />

      <UrlInput
        value={state.urlInput}
        onChange={handleUrlChange}
        disabled={state.ingesting}
        showIds={state.events.length === 0}
        parsedIds={state.parsedIds}
        parseError={state.parseError}
      />

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!state.parsedIds || state.ingesting}
        className="w-full min-h-12 rounded-lg bg-violet-600 hover:bg-violet-500 active:bg-violet-700
                   text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {state.ingesting ? 'Downloading…' : 'Add Model'}
      </button>

      {state.events.length > 0 && <PhaseList events={state.events} />}
    </div>
  );
}

// ── BatchRowCard ──────────────────────────────────────────────────────────────

interface BatchRowCardProps {
  row: BatchRow;
  rowNumber: number;
  canRemove: boolean;
  onChange: (updates: Partial<BatchRow>) => void;
  onRemove: () => void;
}

function BatchRowCard({ row, rowNumber, canRemove, onChange, onRemove }: BatchRowCardProps) {
  const locked = row.finalState !== 'pending';

  function handleUrlChange(value: string) {
    onChange(applyUrlParse(value));
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">Row {rowNumber}</span>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="min-h-12 min-w-12 flex items-center justify-center rounded-lg
                       text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
            aria-label="Remove row"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <TypeRadio
        value={row.type}
        onChange={(t) => onChange({ type: t })}
        disabled={locked}
      />

      <UrlInput
        value={row.urlInput}
        onChange={handleUrlChange}
        disabled={locked}
        showIds={row.events.length === 0}
        parsedIds={row.parsedIds}
        parseError={row.parseError}
      />

      {row.events.length > 0 && <PhaseList events={row.events} />}
    </div>
  );
}

// ── BatchMode ─────────────────────────────────────────────────────────────────

function BatchMode({ onIngestComplete }: { onIngestComplete: () => void }) {
  const [state, setState] = useState<BatchState>({
    rows: [createBlankRow()],
    ingesting: false,
    summary: null,
  });

  function addRow() {
    setState((s) => ({ ...s, rows: [...s.rows, createBlankRow()] }));
  }

  function removeRow(clientId: string) {
    setState((s) => ({ ...s, rows: s.rows.filter((r) => r.clientId !== clientId) }));
  }

  function updateRow(clientId: string, updates: Partial<BatchRow>) {
    setState((s) => ({
      ...s,
      rows: s.rows.map((r) => (r.clientId === clientId ? { ...r, ...updates } : r)),
    }));
  }

  async function handleBatchSubmit() {
    const submittableRows = state.rows.filter((r) => r.parsedIds !== null);
    if (submittableRows.length === 0) return;

    setState((s) => ({
      ...s,
      ingesting: true,
      summary: null,
      rows: s.rows.map((r) =>
        r.parsedIds !== null ? { ...r, events: [], finalState: 'pending' as const } : r,
      ),
    }));

    // Object ref so TypeScript tracks the value through the async callback
    const summaryRef: { value: BatchState['summary'] } = { value: null };

    try {
      const res = await fetch('/api/models/ingest-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: submittableRows.map((r) => ({
            clientId: r.clientId,
            type: r.type,
            modelId: r.parsedIds!.modelId,
            parentUrlId: r.parsedIds!.parentUrlId,
          })),
        }),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => 'Unknown error');
        setState((s) => ({
          ...s,
          ingesting: false,
          rows: s.rows.map((r) =>
            submittableRows.some((sr) => sr.clientId === r.clientId)
              ? { ...r, finalState: 'error' as const, events: [{ phase: 'error', message: `HTTP ${res.status}: ${errText}` }] }
              : r,
          ),
        }));
        return;
      }

      await readSseStreamWithType(res.body, (eventType, data) => {
        if (eventType === 'item') {
          const itemEvent = data as PhaseEvent & { clientId: string };
          setState((s) => ({
            ...s,
            rows: s.rows.map((r) => {
              if (r.clientId !== itemEvent.clientId) return r;
              const events = [...r.events, itemEvent];
              let finalState: BatchRow['finalState'] = r.finalState;
              if (itemEvent.phase === 'done') finalState = 'success';
              else if (itemEvent.phase === 'error') finalState = 'error';
              else if (finalState === 'pending') finalState = 'in-flight';
              return { ...r, events, finalState };
            }),
          }));
        } else if (eventType === 'summary') {
          summaryRef.value = data as BatchState['summary'];
        } else if (eventType === 'fatal') {
          const fatalData = data as { message: string };
          setState((s) => ({
            ...s,
            rows: s.rows.map((r) =>
              r.finalState === 'in-flight' || r.finalState === 'pending'
                ? {
                    ...r,
                    finalState: 'error' as const,
                    events: [...r.events, { phase: 'error', message: `Batch aborted: ${fatalData.message}` }],
                  }
                : r,
            ),
          }));
        }
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        rows: s.rows.map((r) =>
          r.finalState === 'in-flight' || r.finalState === 'pending'
            ? {
                ...r,
                finalState: 'error' as const,
                events: [...r.events, { phase: 'error', message: `Network error: ${String(err)}` }],
              }
            : r,
        ),
      }));
    }

    setState((s) => ({ ...s, ingesting: false, summary: summaryRef.value }));
    if (summaryRef.value && summaryRef.value.succeeded > 0) onIngestComplete();
  }

  const parseableCount = countParseableRows(state.rows);
  const processingIdx = currentlyProcessingIndex(state.rows);

  return (
    <div className="space-y-3">
      {state.rows.map((row, idx) => (
        <BatchRowCard
          key={row.clientId}
          row={row}
          rowNumber={idx + 1}
          canRemove={state.rows.length > 1 && !state.ingesting}
          onChange={(updates) => updateRow(row.clientId, updates)}
          onRemove={() => removeRow(row.clientId)}
        />
      ))}

      {!state.ingesting && state.rows.length < 20 && (
        <button
          type="button"
          onClick={addRow}
          className="w-full min-h-12 rounded-lg border border-dashed border-zinc-700
                     hover:border-zinc-600 hover:bg-zinc-800/40 text-zinc-400 hover:text-zinc-200
                     text-sm transition-colors"
        >
          + Add another model
        </button>
      )}

      <div className="card space-y-2">
        <button
          type="button"
          onClick={handleBatchSubmit}
          disabled={state.ingesting || parseableCount === 0}
          className="w-full min-h-12 rounded-lg bg-violet-600 hover:bg-violet-500 active:bg-violet-700
                     text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {state.ingesting
            ? `Processing ${processingIdx} of ${parseableCount}…`
            : `Add ${parseableCount} model${parseableCount === 1 ? '' : 's'}`}
        </button>

        {state.summary && (
          <p className={`text-sm text-center ${state.summary.failed > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>
            {state.summary.succeeded} succeeded, {state.summary.failed} failed of {state.summary.total}
          </p>
        )}
      </div>
    </div>
  );
}

// ── IngestPanel ───────────────────────────────────────────────────────────────

export default function IngestPanel({ onIngestComplete }: Props) {
  const [mode, setMode] = useState<Mode>('single');

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex gap-1 p-1 bg-zinc-800/60 rounded-xl">
          {(['single', 'batch'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 min-h-12 rounded-lg text-sm font-medium transition-colors
                ${mode === m ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              {m === 'single' ? 'One Model' : 'Batch'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'single' && <SingleMode onIngestComplete={onIngestComplete} />}
      {mode === 'batch' && <BatchMode onIngestComplete={onIngestComplete} />}
    </div>
  );
}
