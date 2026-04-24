'use client';

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}

export default function PromptArea({ label, value, onChange, placeholder, rows = 3 }: Props) {
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
    </div>
  );
}
