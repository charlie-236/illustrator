'use client';

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}

export default function ParamSlider({ label, value, min, max, step, onChange, format }: Props) {
  const display = format ? format(value) : String(value);

  return (
    <div>
      <div className="flex justify-between items-center mb-1.5">
        <label className="label mb-0">{label}</label>
        <span className="text-xs text-zinc-400 tabular-nums font-mono">{display}</span>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="flex-1 h-2 rounded-lg appearance-none cursor-pointer bg-zinc-700"
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-16 input-base text-center px-1.5 py-1 text-xs"
        />
      </div>
    </div>
  );
}
