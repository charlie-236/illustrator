'use client';

import { useState, useRef } from 'react';
import ParamSlider from './ParamSlider';
import type { CheckpointConfig } from '@/types';

const STYLIZED_BASE_MODELS = ['Pony', 'Illustrious', 'Animagine'];
const MAX_FACE_REFS = 3;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MIN_UPLOAD_BYTES = 100 * 1024;

interface Props {
  baseImage: string | null;
  mask: string | null;
  baseImageDenoise: number;
  faceReferences: string[];
  faceStrength: number;
  selectedCheckpoint: string;
  checkpointConfigs: CheckpointConfig[];
  onBaseImageChange: (b64: string | null) => void;
  onMaskChange: (b64: string | null) => void;
  onBaseImageDenoiseChange: (value: number) => void;
  onFaceReferencesChange: (refs: string[]) => void;
  onFaceStrengthChange: (value: number) => void;
}

async function processUpload(
  file: File,
  opts: { skipMinSize?: boolean } = {},
): Promise<{ ok: true; base64: string } | { ok: false; error: string }> {
  if (!file.type.startsWith('image/')) {
    return { ok: false, error: 'File must be an image' };
  }
  if (!opts.skipMinSize && file.size < MIN_UPLOAD_BYTES) {
    return { ok: false, error: 'Image too small (minimum 100KB)' };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: 'Image too large (maximum 8MB)' };
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const commaIdx = result.indexOf(',');
      const base64 = commaIdx !== -1 ? result.slice(commaIdx + 1) : result;
      resolve({ ok: true, base64 });
    };
    reader.onerror = () => resolve({ ok: false, error: 'Failed to read file' });
    reader.readAsDataURL(file);
  });
}

function useDropTarget(onDrop: (file: File) => void) {
  const [isDragOver, setIsDragOver] = useState(false);
  const handlers = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); },
    onDragLeave: () => setIsDragOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) onDrop(file);
    },
  };
  return { isDragOver, handlers };
}

function isStylizedCheckpoint(ckpt: string, configs: CheckpointConfig[]): boolean {
  const config = configs.find((c) => c.checkpointName === ckpt);
  if (!config?.baseModel) return false;
  return STYLIZED_BASE_MODELS.some((m) =>
    config.baseModel.toLowerCase().includes(m.toLowerCase()),
  );
}

// Quick format detection from base64 prefix bytes for thumbnail display
function toDisplayUrl(base64: string): string {
  if (base64.startsWith('iVBOR')) return `data:image/png;base64,${base64}`;
  return `data:image/jpeg;base64,${base64}`;
}

function ActivityPills({
  hasBaseImage,
  hasMask,
  faceCount,
}: {
  hasBaseImage: boolean;
  hasMask: boolean;
  faceCount: number;
}) {
  if (!hasBaseImage && faceCount === 0) return null;
  return (
    <div className="flex items-center gap-1">
      {hasBaseImage && hasMask && (
        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-600/20 text-blue-300 border border-blue-600/40">
          inpaint
        </span>
      )}
      {hasBaseImage && !hasMask && (
        <span className="text-xs px-2 py-0.5 rounded-full bg-violet-600/20 text-violet-300 border border-violet-600/40">
          img2img
        </span>
      )}
      {faceCount > 0 && (
        <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-600/20 text-emerald-300 border border-emerald-600/40">
          face × {faceCount}
        </span>
      )}
    </div>
  );
}

interface BaseImageSectionProps {
  baseImage: string | null;
  mask: string | null;
  denoise: number;
  onChange: (b64: string | null) => void;
  onMaskChange: (b64: string | null) => void;
  onDenoiseChange: (value: number) => void;
  onError: (msg: string | null) => void;
}

function BaseImageSection({
  baseImage,
  mask,
  denoise,
  onChange,
  onMaskChange,
  onDenoiseChange,
  onError,
}: BaseImageSectionProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const maskFileRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    const result = await processUpload(file);
    if (!result.ok) { onError(result.error); return; }
    onError(null);
    onChange(result.base64);
  }

  async function handleMaskFile(file: File) {
    const result = await processUpload(file, { skipMinSize: true });
    if (!result.ok) { onError(result.error); return; }
    onError(null);
    onMaskChange(result.base64);
  }

  const { isDragOver, handlers } = useDropTarget((f) => void handleFile(f));
  const { isDragOver: isMaskDragOver, handlers: maskHandlers } = useDropTarget((f) => void handleMaskFile(f));

  return (
    <div>
      <p className="label mb-2">Base Image (img2img)</p>
      <div
        {...handlers}
        className={`relative rounded-xl border-2 transition-colors ${
          isDragOver
            ? 'border-violet-500 bg-violet-600/10'
            : baseImage
              ? 'border-zinc-700'
              : 'border-dashed border-zinc-700 hover:border-zinc-500'
        }`}
      >
        {baseImage ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={toDisplayUrl(baseImage)}
              alt="Base image"
              className="w-full max-h-48 object-contain rounded-xl"
            />
            <button
              type="button"
              onClick={() => { onChange(null); onMaskChange(null); }}
              className="absolute top-2 right-2 min-h-8 min-w-8 flex items-center justify-center
                         rounded-full bg-zinc-900/80 text-zinc-300 hover:text-white hover:bg-zinc-800
                         transition-colors"
              aria-label="Remove base image"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="w-full min-h-24 flex flex-col items-center justify-center gap-2
                       text-zinc-400 hover:text-zinc-200 transition-colors active:scale-[0.99] p-4"
          >
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            <span className="text-sm">Drag or tap to upload base image</span>
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
      {baseImage && (
        <>
          <div className="mt-3 space-y-1">
            <ParamSlider
              label="Denoise"
              value={denoise}
              min={0}
              max={1}
              step={0.05}
              onChange={onDenoiseChange}
              format={(v) => v.toFixed(2)}
            />
            <p className="text-xs text-zinc-500">0 = exact reference &nbsp;·&nbsp; 1 = ignore reference</p>
          </div>

          <div className="mt-4">
            <p className="label mb-2">Inpaint Mask <span className="normal-case text-zinc-500 font-normal">(optional)</span></p>
            <div
              {...maskHandlers}
              className={`relative rounded-xl border-2 transition-colors ${
                isMaskDragOver
                  ? 'border-blue-500 bg-blue-600/10'
                  : mask
                    ? 'border-zinc-700'
                    : 'border-dashed border-zinc-700 hover:border-zinc-500'
              }`}
            >
              {mask ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={toDisplayUrl(mask)}
                    alt="Inpaint mask"
                    className="w-full max-h-32 object-contain rounded-xl"
                  />
                  <button
                    type="button"
                    onClick={() => onMaskChange(null)}
                    className="absolute top-2 right-2 min-h-8 min-w-8 flex items-center justify-center
                               rounded-full bg-zinc-900/80 text-zinc-300 hover:text-white hover:bg-zinc-800
                               transition-colors"
                    aria-label="Remove mask"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => maskFileRef.current?.click()}
                  className="w-full min-h-20 flex flex-col items-center justify-center gap-2
                             text-zinc-400 hover:text-zinc-200 transition-colors active:scale-[0.99] p-4"
                >
                  <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                  </svg>
                  <span className="text-sm">Drag or tap to upload mask</span>
                  <span className="text-xs text-zinc-500">White = replace &nbsp;·&nbsp; Black = keep</span>
                </button>
              )}
            </div>
            <input
              ref={maskFileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleMaskFile(f);
                e.target.value = '';
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

interface FaceReferenceSectionProps {
  references: string[];
  strength: number;
  selectedCheckpoint: string;
  checkpointConfigs: CheckpointConfig[];
  onChange: (refs: string[]) => void;
  onStrengthChange: (value: number) => void;
  onError: (msg: string | null) => void;
}

function FaceReferenceSection({
  references,
  strength,
  selectedCheckpoint,
  checkpointConfigs,
  onChange,
  onStrengthChange,
  onError,
}: FaceReferenceSectionProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleNewRef(file: File) {
    if (references.length >= MAX_FACE_REFS) return;
    const result = await processUpload(file);
    if (!result.ok) { onError(result.error); return; }
    onError(null);
    onChange([...references, result.base64]);
  }

  function removeReference(idx: number) {
    onChange(references.filter((_, i) => i !== idx));
  }

  const { isDragOver, handlers } = useDropTarget((f) => void handleNewRef(f));

  return (
    <div>
      <p className="label mb-2">Identity (FaceID)</p>
      <div
        {...handlers}
        className={`grid grid-cols-3 gap-2 rounded-xl p-0.5 transition-colors ${
          isDragOver ? 'outline outline-2 outline-violet-500 bg-violet-600/5' : ''
        }`}
      >
        {Array.from({ length: MAX_FACE_REFS }, (_, i) => {
          const ref = references[i] ?? null;
          const isNextEmpty = i === references.length;

          if (ref !== null) {
            return (
              <div
                key={i}
                className="relative aspect-square rounded-xl overflow-hidden border border-zinc-700 bg-zinc-800"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={toDisplayUrl(ref)}
                  alt={`Reference ${i + 1}`}
                  className="w-full h-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeReference(i)}
                  className="absolute top-1.5 right-1.5 min-h-8 min-w-8 flex items-center justify-center
                             rounded-full bg-zinc-900/80 text-zinc-300 hover:text-white hover:bg-zinc-800
                             transition-colors"
                  aria-label={`Remove reference ${i + 1}`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            );
          }

          if (isNextEmpty) {
            return (
              <button
                key={i}
                type="button"
                onClick={() => fileRef.current?.click()}
                className="aspect-square rounded-xl border-2 border-dashed border-zinc-700
                           hover:border-violet-500 hover:bg-violet-600/5
                           flex items-center justify-center
                           text-zinc-500 hover:text-violet-400
                           transition-colors active:scale-95 min-h-[72px]"
                aria-label={`Add reference image ${i + 1}`}
              >
                <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
              </button>
            );
          }

          // Slot not yet reachable — faded placeholder
          return (
            <div
              key={i}
              className="aspect-square rounded-xl border-2 border-dashed border-zinc-800
                         flex items-center justify-center text-zinc-800 min-h-[72px]"
            >
              <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </div>
          );
        })}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleNewRef(f);
          e.target.value = '';
        }}
      />
      <div className="mt-3 space-y-1">
        <ParamSlider
          label="Strength"
          value={strength}
          min={0}
          max={1.5}
          step={0.05}
          onChange={onStrengthChange}
          format={(v) => v.toFixed(2)}
        />
        <p className="text-xs text-zinc-500">
          Higher strength = more of the reference identity preserved in the output
        </p>
      </div>
      {isStylizedCheckpoint(selectedCheckpoint, checkpointConfigs) && references.length > 0 && (
        <div className="flex gap-2 text-xs text-amber-300 bg-amber-900/20 border border-amber-900/40 rounded-lg p-2 mt-3">
          <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
          </svg>
          <p>
            This checkpoint is heavily stylized and may not preserve facial identity well.
            For best results with face references, use a photorealistic SDXL checkpoint.
          </p>
        </div>
      )}
    </div>
  );
}

export default function ReferencePanel({
  baseImage,
  mask,
  baseImageDenoise,
  faceReferences,
  faceStrength,
  selectedCheckpoint,
  checkpointConfigs,
  onBaseImageChange,
  onMaskChange,
  onBaseImageDenoiseChange,
  onFaceReferencesChange,
  onFaceStrengthChange,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between min-h-12 -m-1 p-1 rounded-lg
                   hover:bg-zinc-800/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-zinc-200">Reference</h2>
          <ActivityPills hasBaseImage={baseImage !== null} hasMask={mask !== null} faceCount={faceReferences.length} />
        </div>
        {expanded ? (
          <svg className="w-5 h-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
          </svg>
        ) : (
          <svg className="w-5 h-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        )}
      </button>

      {expanded && (
        <div className="mt-3 space-y-5">
          <BaseImageSection
            baseImage={baseImage}
            mask={mask}
            denoise={baseImageDenoise}
            onChange={onBaseImageChange}
            onMaskChange={onMaskChange}
            onDenoiseChange={onBaseImageDenoiseChange}
            onError={setError}
          />
          <hr className="border-zinc-800" />
          <FaceReferenceSection
            references={faceReferences}
            strength={faceStrength}
            selectedCheckpoint={selectedCheckpoint}
            checkpointConfigs={checkpointConfigs}
            onChange={onFaceReferencesChange}
            onStrengthChange={onFaceStrengthChange}
            onError={setError}
          />
          {error && (
            <div className="text-xs text-red-300 bg-red-900/20 border border-red-900/40 rounded-lg p-2">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
