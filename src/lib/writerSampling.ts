import type { SamplingParams } from '@/types';

export function envDefaultSamplingParams(): SamplingParams {
  return {
    temperature: parseFloat(process.env.WRITER_DEFAULT_TEMPERATURE ?? '1.1'),
    min_p: parseFloat(process.env.WRITER_DEFAULT_MIN_P ?? '0.05'),
    dry_multiplier: parseFloat(process.env.WRITER_DEFAULT_DRY_MULTIPLIER ?? '0.8'),
    dry_base: parseFloat(process.env.WRITER_DEFAULT_DRY_BASE ?? '1.75'),
    dry_allowed_length: parseInt(process.env.WRITER_DEFAULT_DRY_ALLOWED_LENGTH ?? '2', 10),
    max_tokens: parseInt(process.env.WRITER_DEFAULT_MAX_TOKENS ?? '1500', 10),
  };
}

export function resolveSamplingParams(
  presetParams: SamplingParams | null,
  overrides: Partial<SamplingParams> | null,
): SamplingParams {
  return {
    ...envDefaultSamplingParams(),
    ...(presetParams ?? {}),
    ...(overrides ?? {}),
  };
}

/** Strip undefined/null values before sending to Aphrodite. */
export function samplingParamsForAphrodite(p: SamplingParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}
