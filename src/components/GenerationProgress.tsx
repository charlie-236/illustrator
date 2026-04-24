'use client';

interface Props {
  value: number;
  max: number;
  imageUrl?: string;
}

export default function GenerationProgress({ value, max, imageUrl }: Props) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;

  return (
    <div className="space-y-3">
      {!imageUrl && (
        <div>
          <div className="flex justify-between text-xs text-zinc-500 mb-1.5">
            <span>Generating…</span>
            <span className="tabular-nums">{value}/{max} steps ({pct}%)</span>
          </div>
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-violet-500 rounded-full transition-all duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt="Generated"
          className="w-full rounded-xl border border-zinc-700 object-contain max-h-[70vw]"
        />
      )}
    </div>
  );
}
