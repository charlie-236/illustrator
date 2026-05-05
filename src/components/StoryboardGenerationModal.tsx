'use client';

import { useState, useRef } from 'react';
import type { Storyboard } from '@/types';

interface Props {
  projectId: string;
  initialStoryIdea?: string;
  /**
   * null = create a new storyboard row.
   * non-null = replace scenes on the existing storyboard with this id.
   */
  targetStoryboardId: string | null;
  /** The existing storyboard (for name/position when updating) */
  targetStoryboard?: Storyboard;
  onClose: () => void;
  onSaved: (storyboard: Storyboard) => void;
}

type Status = 'idle' | 'loading' | 'error';
type ErrorReason = 'timeout' | 'llm_error' | 'parse_error' | 'no_scenes' | 'project_not_found' | 'invalid_input';

interface GenerateError {
  reason: ErrorReason;
  rawOutput?: string;
}

/** Shape returned by the LLM generate route */
interface LLMStoryboard {
  scenes: Storyboard['scenes'];
  storyIdea: string;
  generatedAt: string;
}

export default function StoryboardGenerationModal({
  projectId,
  initialStoryIdea = '',
  targetStoryboardId,
  targetStoryboard,
  onClose,
  onSaved,
}: Props) {
  const [storyIdea, setStoryIdea] = useState(initialStoryIdea);
  const [sceneCount, setSceneCount] = useState(5);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<GenerateError | null>(null);
  const [showRawOutput, setShowRawOutput] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const canGenerate = storyIdea.trim().length >= 10;

  async function handleGenerate() {
    setStatus('loading');
    setError(null);
    setShowRawOutput(false);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      // Step 1: LLM storyboard generation (stateless)
      const genRes = await fetch('/api/storyboard/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, storyIdea: storyIdea.trim(), sceneCount }),
        signal: ac.signal,
      });

      const genData = await genRes.json() as { ok: boolean; storyboard?: LLMStoryboard; reason?: ErrorReason; rawOutput?: string };

      if (!genData.ok || !genData.storyboard) {
        setError({ reason: genData.reason ?? 'llm_error', rawOutput: genData.rawOutput });
        setStatus('error');
        return;
      }

      let savedStoryboard: Storyboard;

      if (targetStoryboardId && targetStoryboard) {
        // Update existing storyboard
        const updatedSb: Storyboard = {
          ...targetStoryboard,
          scenes: genData.storyboard.scenes,
          storyIdea: genData.storyboard.storyIdea,
          generatedAt: genData.storyboard.generatedAt,
        };
        const saveRes = await fetch(`/api/storyboards/${targetStoryboardId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storyboard: updatedSb }),
          signal: ac.signal,
        });
        if (!saveRes.ok) {
          setError({ reason: 'llm_error' });
          setStatus('error');
          return;
        }
        const saveData = await saveRes.json() as { storyboard: Storyboard };
        savedStoryboard = saveData.storyboard;
      } else {
        // Create new storyboard row, then populate it
        const createRes = await fetch(`/api/projects/${projectId}/storyboards`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Storyboard' }),
          signal: ac.signal,
        });
        if (!createRes.ok) {
          setError({ reason: 'llm_error' });
          setStatus('error');
          return;
        }
        const createData = await createRes.json() as { storyboard: Storyboard };
        const newSb = createData.storyboard;

        const populatedSb: Storyboard = {
          ...newSb,
          scenes: genData.storyboard.scenes,
          storyIdea: genData.storyboard.storyIdea,
          generatedAt: genData.storyboard.generatedAt,
        };
        const saveRes = await fetch(`/api/storyboards/${newSb.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storyboard: populatedSb }),
          signal: ac.signal,
        });
        if (!saveRes.ok) {
          setError({ reason: 'llm_error' });
          setStatus('error');
          return;
        }
        const saveData = await saveRes.json() as { storyboard: Storyboard };
        savedStoryboard = saveData.storyboard;
      }

      onSaved(savedStoryboard);
      onClose();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setStatus('idle');
        return;
      }
      setError({ reason: 'llm_error' });
      setStatus('error');
    }
  }

  function handleAbort() {
    abortRef.current?.abort();
    setStatus('idle');
  }

  function handleRetry() {
    setError(null);
    setStatus('idle');
  }

  function getErrorMessage(reason: ErrorReason): string {
    switch (reason) {
      case 'timeout':
        return 'The LLM took too long to respond. Try again or check that the LLM service is running.';
      case 'llm_error':
        return "Couldn't reach the LLM service. Check that it's running and try again.";
      case 'no_scenes':
        return "The LLM didn't produce any scenes. Try rephrasing your story idea.";
      case 'parse_error':
        return "The LLM returned output we couldn't parse.";
      case 'project_not_found':
        return 'Project not found.';
      case 'invalid_input':
        return 'Invalid input. Make sure your story idea is between 10 and 4000 characters.';
      default:
        return 'Something went wrong. Please try again.';
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={status === 'idle' ? onClose : undefined}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">
            {targetStoryboardId ? 'Regenerate storyboard' : 'Plan with AI'}
          </h2>
          {status !== 'loading' && (
            <button
              onClick={onClose}
              className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          {status === 'loading' && (
            <div className="min-h-12 min-w-12 flex items-center justify-center" />
          )}
        </div>

        <div className="px-5 py-4">
          {/* ── Idle state ── */}
          {status === 'idle' && (
            <div className="space-y-4">
              <p className="text-sm text-zinc-400">
                Describe your project&apos;s story idea. The LLM will break it into scenes you can use to guide clip generation.
              </p>

              <div>
                <textarea
                  className="input-base resize-none w-full"
                  rows={7}
                  value={storyIdea}
                  onChange={(e) => setStoryIdea(e.target.value)}
                  placeholder="A young girl finds a magical book in her grandmother's attic. She opens it and gets transported to a fantasy world..."
                  autoFocus
                />
              </div>

              {/* Scene count stepper */}
              <div className="flex items-center gap-3">
                <span className="text-sm text-zinc-400 flex-1">Number of scenes:</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSceneCount((n) => Math.max(3, n - 1))}
                    disabled={sceneCount <= 3}
                    className="min-h-12 min-w-12 flex items-center justify-center rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-lg font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none"
                    aria-label="Decrease scene count"
                  >
                    −
                  </button>
                  <span className="text-zinc-100 font-semibold text-lg w-8 text-center tabular-nums">
                    {sceneCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSceneCount((n) => Math.min(10, n + 1))}
                    disabled={sceneCount >= 10}
                    className="min-h-12 min-w-12 flex items-center justify-center rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-lg font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none"
                    aria-label="Increase scene count"
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleGenerate()}
                  disabled={!canGenerate}
                  className="flex-1 min-h-12 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:pointer-events-none"
                >
                  Generate
                </button>
              </div>
            </div>
          )}

          {/* ── Loading state ── */}
          {status === 'loading' && (
            <div className="space-y-5 py-4 text-center">
              <div className="flex justify-center">
                <svg className="w-10 h-10 text-violet-400 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-200">Generating storyboard…</p>
                <p className="text-xs text-zinc-500 mt-1">This usually takes 30–60 seconds.</p>
              </div>
              <button
                type="button"
                onClick={handleAbort}
                className="w-full min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
              >
                Abort
              </button>
            </div>
          )}

          {/* ── Error state ── */}
          {status === 'error' && error && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-red-400">{getErrorMessage(error.reason)}</p>

              {error.reason === 'parse_error' && error.rawOutput && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowRawOutput((v) => !v)}
                    className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors min-h-8"
                  >
                    {showRawOutput ? 'Hide raw output' : 'Show raw output'}
                  </button>
                  {showRawOutput && (
                    <pre className="mt-2 p-3 rounded-lg bg-zinc-800 text-xs text-zinc-400 overflow-x-auto whitespace-pre-wrap break-words max-h-48">
                      {error.rawOutput}
                    </pre>
                  )}
                </div>
              )}

              <div className="bg-zinc-800/60 rounded-lg p-3">
                <p className="text-xs text-zinc-500 mb-1">Your story idea (preserved):</p>
                <p className="text-sm text-zinc-300 line-clamp-3">{storyIdea}</p>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleRetry}
                  className="flex-1 min-h-12 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold transition-colors"
                >
                  Retry
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
