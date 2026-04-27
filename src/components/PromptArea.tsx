'use client';

import { useRef, useState, useEffect } from 'react';

interface Sel { start: number; end: number }

interface WeightedExpr {
  outerStart: number; // position of '('
  outerEnd: number;   // position after ')'
  inner: string;      // content before ':weight'
  weight: number;
}

// Matches a SELECTED string that is itself a complete weight expression, e.g. (dog:1.05)
const WEIGHT_RE = /^\((.+):(\d+(?:\.\d+)?)\)$/;

/**
 * Walk outward from [start, end] in `text` to find the innermost enclosing
 * weight expression of the form (content:weight).
 *
 * Algorithm:
 *  1. Scan backward from start-1 for the nearest unmatched '(' (depth-tracking
 *     skips any nested sub-expressions we pass through).
 *  2. From that '(' walk forward to find its balanced ')'.
 *  3. Check whether the content between those parens ends with ':\d+(.?\d+)?'.
 *  4. Verify the original selection falls within the *inner* (pre-colon) region.
 */
function findEnclosingWeight(text: string, start: number, end: number): WeightedExpr | null {
  // Step 1 — find innermost unmatched '(' before selection
  let depth = 0;
  let parenStart = -1;
  for (let i = start - 1; i >= 0; i--) {
    if (text[i] === ')') { depth++; }
    else if (text[i] === '(') {
      if (depth === 0) { parenStart = i; break; }
      depth--;
    }
  }
  if (parenStart === -1) return null;

  // Step 2 — find the matching balanced ')'
  depth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < text.length; i++) {
    if (text[i] === '(') { depth++; }
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) { parenEnd = i; break; }
    }
  }
  if (parenEnd === -1) return null;

  // Step 3 — content must end with ':weight'
  const content = text.slice(parenStart + 1, parenEnd);
  const weightMatch = content.match(/:(\d+(?:\.\d+)?)$/);
  if (!weightMatch) return null;

  const inner = content.slice(0, content.length - weightMatch[0].length);
  const innerStart = parenStart + 1;
  const innerEnd = innerStart + inner.length;

  // Step 4 — selection must sit entirely within the inner (text) region,
  // not spilling into the ':weight' tail
  if (start >= innerStart && end <= innerEnd) {
    return {
      outerStart: parenStart,
      outerEnd: parenEnd + 1,
      inner,
      weight: parseFloat(weightMatch[1]),
    };
  }
  return null;
}

function applyWeight(
  text: string,
  sel: Sel,
  delta: number | null,
): { newValue: string; newSel: Sel } {
  const { start, end } = sel;
  if (start === end) return { newValue: text, newSel: sel };

  const selected = text.slice(start, end);

  // Resolve the weight expression to operate on.
  // Priority 1: the selected text itself is a complete "(inner:weight)" expression.
  // Priority 2: the selection is nested inside an enclosing weight wrapper.
  let expr: WeightedExpr | null = null;
  const directMatch = selected.match(WEIGHT_RE);
  if (directMatch) {
    expr = {
      outerStart: start,
      outerEnd: end,
      inner: directMatch[1],
      weight: parseFloat(directMatch[2]),
    };
  } else {
    expr = findEnclosingWeight(text, start, end);
  }

  let replacement: string;
  let replaceStart: number;
  let replaceEnd: number;

  if (expr) {
    replaceStart = expr.outerStart;
    replaceEnd = expr.outerEnd;

    if (delta === null) {
      replacement = expr.inner; // clear → strip wrapper
    } else {
      const newWeight = Math.round((expr.weight + delta) * 100) / 100;
      // 1.00 is neutral — strip the wrapper instead of keeping (text:1.00)
      replacement = newWeight === 1.0
        ? expr.inner
        : `(${expr.inner}:${newWeight.toFixed(2)})`;
    }
  } else {
    // Plain unweighted text — only + and - make sense here
    replaceStart = start;
    replaceEnd = end;

    if (delta === null) {
      replacement = selected; // nothing to clear
    } else {
      replacement = delta > 0 ? `(${selected}:1.05)` : `(${selected}:0.95)`;
    }
  }

  return {
    newValue: text.slice(0, replaceStart) + replacement + text.slice(replaceEnd),
    newSel: { start: replaceStart, end: replaceStart + replacement.length },
  };
}

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  hint?: string;
  showPolish?: boolean;
}

export default function PromptArea({ label, value, onChange, placeholder, rows = 3, hint, showPolish = false }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Persists last selection even after the textarea loses focus (e.g. when a
  // toolbar button is tapped on mobile, which blurs the textarea first).
  const savedSel = useRef<Sel>({ start: 0, end: 0 });

  const [polishing, setPolishing] = useState(false);
  const [polishError, setPolishError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  async function handlePolish() {
    if (!value.trim() || polishing) return;
    setPolishing(true);
    setPolishError(null);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    try {
      const res = await fetch('/api/generate/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: value }),
      });
      const data = await res.json() as { result?: string; error?: string };
      if (!res.ok || data.error) {
        const msg = data.error ?? `Error ${res.status}`;
        setPolishError(msg);
        errorTimerRef.current = setTimeout(() => setPolishError(null), 5000);
        return;
      }
      if (data.result) onChange(data.result);
    } catch (err) {
      const msg = String(err);
      setPolishError(msg);
      errorTimerRef.current = setTimeout(() => setPolishError(null), 5000);
    } finally {
      setPolishing(false);
    }
  }

  function saveSel() {
    const ta = taRef.current;
    if (ta) savedSel.current = { start: ta.selectionStart, end: ta.selectionEnd };
  }

  function act(delta: number | null) {
    const { newValue, newSel } = applyWeight(value, savedSel.current, delta);
    if (newValue === value) return;
    onChange(newValue);
    // Restore focus + highlight after React re-renders the controlled textarea
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(newSel.start, newSel.end);
      savedSel.current = newSel;
    });
  }

  return (
    <div>
      <label className="label">{label}</label>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onSelect={saveSel}
        onMouseUp={saveSel}
        onKeyUp={saveSel}
        onTouchEnd={saveSel}
        rows={rows}
        placeholder={placeholder}
        className="input-base resize-none leading-relaxed"
      />

      {/* Static weight toolbar — never floats, never conflicts with native selection UI */}
      <div className="flex items-center gap-1.5 mt-1.5">
        <button
          type="button"
          // Prevents textarea blur on desktop so selectionStart/End stay readable;
          // on mobile we rely on savedSel instead.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => act(+0.05)}
          className="min-h-12 min-w-12 flex items-center justify-center rounded-lg
                     bg-zinc-800 hover:bg-zinc-700 active:scale-95
                     border border-zinc-700 text-zinc-100 font-bold text-xl
                     transition-all select-none"
          aria-label="Increase weight by 0.05"
        >
          +
        </button>

        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => act(-0.05)}
          className="min-h-12 min-w-12 flex items-center justify-center rounded-lg
                     bg-zinc-800 hover:bg-zinc-700 active:scale-95
                     border border-zinc-700 text-zinc-100 font-bold text-xl
                     transition-all select-none"
          aria-label="Decrease weight by 0.05"
        >
          −
        </button>

        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => act(null)}
          className="min-h-12 px-4 flex items-center justify-center gap-1.5 rounded-lg
                     bg-zinc-800 hover:bg-zinc-700 active:scale-95
                     border border-zinc-700 text-zinc-400 text-sm
                     transition-all select-none"
          aria-label="Clear weight"
        >
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
          Clear
        </button>

        {showPolish && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void handlePolish()}
            disabled={polishing || !value.trim()}
            className="min-h-12 px-3 flex items-center justify-center gap-1.5 rounded-lg
                       bg-violet-600/10 hover:bg-violet-600/20 active:scale-95
                       border border-violet-600/30 hover:border-violet-500/50
                       text-violet-300 text-sm font-medium
                       transition-all select-none disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Expand prompt with AI"
          >
            {polishing ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
                </svg>
                Polishing…
              </>
            ) : (
              <>✨ Polish</>
            )}
          </button>
        )}

        <span className="ml-auto text-xs text-zinc-600 select-none">select text first</span>
      </div>

      {polishError && (
        <p className="mt-1 text-xs text-red-400 leading-relaxed truncate" title={polishError}>
          Polish failed: {polishError}
        </p>
      )}

      {hint && (
        <p className="mt-1 text-xs text-zinc-400 leading-relaxed">
          <span className="text-zinc-500">Default: </span>{hint}
        </p>
      )}
    </div>
  );
}
