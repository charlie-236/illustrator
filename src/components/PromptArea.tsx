'use client';

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  hint?: string;
}

export default function PromptArea({ label, value, onChange, placeholder, rows = 3, hint }: Props) {
  return (
    <div>
      <label className="label">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="input-base resize-none leading-relaxed"
      />
      {hint && (
        <p className="mt-1 text-xs text-zinc-600 leading-relaxed">
          <span className="text-zinc-700">Default: </span>{hint}
        </p>
      )}
    </div>
  );
}
