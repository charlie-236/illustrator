'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ProjectSummary, ProjectDetail, ProjectClip } from '@/types';
import ProjectDetailView from './ProjectDetail';
import { imgSrc } from '@/lib/imageSrc';

interface Props {
  onNavigateToGallery: () => void;
  onGenerateInProject: (project: ProjectDetail, latestClip: ProjectClip | null) => void;
}

interface NewProjectForm {
  name: string;
  description: string;
  styleNote: string;
  defaultFrames: string;
  defaultSteps: string;
  defaultCfg: string;
  defaultWidth: string;
  defaultHeight: string;
}

const VIDEO_RESOLUTIONS = [
  { label: '1280×704', w: 1280, h: 704 },
  { label: '768×768', w: 768, h: 768 },
  { label: '704×1280', w: 704, h: 1280 },
];

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const months = Math.floor(days / 30);
  return `${months} ${months === 1 ? 'month' : 'months'} ago`;
}

interface NewProjectModalProps {
  onClose: () => void;
  onCreated: (project: ProjectDetail) => void;
}

function NewProjectModal({ onClose, onCreated }: NewProjectModalProps) {
  const [form, setForm] = useState<NewProjectForm>({
    name: '',
    description: '',
    styleNote: '',
    defaultFrames: '',
    defaultSteps: '',
    defaultCfg: '',
    defaultWidth: '',
    defaultHeight: '',
  });
  const [showDefaults, setShowDefaults] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(key: keyof NewProjectForm, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = { name: form.name.trim() };
    if (form.description.trim()) body.description = form.description.trim();
    if (form.styleNote.trim()) body.styleNote = form.styleNote.trim();
    if (form.defaultFrames) body.defaultFrames = parseInt(form.defaultFrames, 10);
    if (form.defaultSteps) body.defaultSteps = parseInt(form.defaultSteps, 10);
    if (form.defaultCfg) body.defaultCfg = parseFloat(form.defaultCfg);
    if (form.defaultWidth) body.defaultWidth = parseInt(form.defaultWidth, 10);
    if (form.defaultHeight) body.defaultHeight = parseInt(form.defaultHeight, 10);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Failed to create project'); return; }
      onCreated(data as ProjectDetail);
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">New Project</h2>
          <button onClick={onClose} className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          <div>
            <label className="label block mb-1">Name *</label>
            <input
              className="input-base"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. Sci-fi short, Sunset walk…"
              autoFocus
            />
          </div>

          <div>
            <label className="label block mb-1">Description</label>
            <textarea
              className="input-base resize-none"
              rows={2}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Short description of the project"
            />
          </div>

          <div>
            <label className="label block mb-1">Style note</label>
            <textarea
              className="input-base resize-none"
              rows={3}
              value={form.styleNote}
              onChange={(e) => set('styleNote', e.target.value)}
              placeholder="Creative anchor — what is this project about? Tone, visual style, key constraints…"
            />
          </div>

          <button
            type="button"
            onClick={() => setShowDefaults((s) => !s)}
            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200 min-h-12"
          >
            <svg
              className={`w-4 h-4 transition-transform ${showDefaults ? 'rotate-90' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            Default settings
          </button>

          {showDefaults && (
            <div className="space-y-4 pl-4 border-l-2 border-zinc-700">
              <div>
                <label className="label block mb-1">Resolution</label>
                <div className="flex gap-2 flex-wrap">
                  {VIDEO_RESOLUTIONS.map((r) => (
                    <button
                      key={r.label}
                      type="button"
                      onClick={() => { set('defaultWidth', String(r.w)); set('defaultHeight', String(r.h)); }}
                      className={`px-3 min-h-12 rounded-lg text-sm border transition-colors
                        ${form.defaultWidth === String(r.w) && form.defaultHeight === String(r.h)
                          ? 'border-violet-500 bg-violet-600/20 text-violet-300'
                          : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-500'}`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label block mb-1">Default frames</label>
                  <input
                    className="input-base"
                    type="number"
                    min={17} max={121} step={8}
                    value={form.defaultFrames}
                    onChange={(e) => set('defaultFrames', e.target.value)}
                    placeholder="57"
                  />
                </div>
                <div>
                  <label className="label block mb-1">Default steps</label>
                  <input
                    className="input-base"
                    type="number"
                    min={4} max={40} step={2}
                    value={form.defaultSteps}
                    onChange={(e) => set('defaultSteps', e.target.value)}
                    placeholder="20"
                  />
                </div>
              </div>

              <div>
                <label className="label block mb-1">Default CFG</label>
                <input
                  className="input-base"
                  type="number"
                  min={1} max={10} step={0.1}
                  value={form.defaultCfg}
                  onChange={(e) => set('defaultCfg', e.target.value)}
                  placeholder="3.5"
                />
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 min-h-12 rounded-xl bg-zinc-800 text-zinc-300 hover:bg-zinc-700 font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 min-h-12 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold transition-colors disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ProjectCard({ project, onClick }: { project: ProjectSummary; onClick: () => void }) {
  const clipLabel = project.clipCount === 0
    ? 'No clips'
    : project.clipCount === 1
      ? '1 clip'
      : `${project.clipCount} clips`;

  return (
    <button
      onClick={onClick}
      className="card text-left hover:border-zinc-600 transition-colors w-full"
    >
      {/* Cover frame */}
      <div className="aspect-video rounded-lg overflow-hidden bg-zinc-800 mb-3">
        {project.coverFrame ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            src={imgSrc(project.coverFrame)}
            preload="metadata"
            muted
            playsInline
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-zinc-600">
            <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
            </svg>
          </div>
        )}
      </div>

      <p className="font-semibold text-zinc-100 text-sm truncate">{project.name}</p>
      {project.description ? (
        <p className="text-xs text-zinc-400 mt-0.5 line-clamp-1">{project.description}</p>
      ) : (
        <p className="text-xs text-zinc-600 mt-0.5">No description</p>
      )}
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs text-zinc-500">{clipLabel}</span>
        <span className="text-xs text-zinc-600">{formatRelativeTime(project.updatedAt)}</span>
      </div>
    </button>
  );
}

export default function Projects({ onNavigateToGallery, onGenerateInProject }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewModal, setShowNewModal] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      setProjects(data.projects ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function handleCreated(project: ProjectDetail) {
    setShowNewModal(false);
    setActiveProjectId(project.id);
    void load();
  }

  function handleProjectDeleted() {
    setActiveProjectId(null);
    void load();
  }

  if (activeProjectId) {
    return (
      <ProjectDetailView
        projectId={activeProjectId}
        onBack={() => setActiveProjectId(null)}
        onDeleted={handleProjectDeleted}
        onNavigateToGallery={onNavigateToGallery}
        onGenerateInProject={onGenerateInProject}
      />
    );
  }

  return (
    <div className="px-4 py-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-bold text-zinc-100">Projects</h1>
        <button
          onClick={() => setShowNewModal(true)}
          className="min-h-12 px-4 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold text-sm transition-colors flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New Project
        </button>
      </div>

      {loading && (
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card animate-pulse">
              <div className="aspect-video rounded-lg bg-zinc-800 mb-3" />
              <div className="h-4 bg-zinc-800 rounded w-3/4 mb-2" />
              <div className="h-3 bg-zinc-800 rounded w-1/2" />
            </div>
          ))}
        </div>
      )}

      {!loading && projects.length === 0 && (
        <div className="flex flex-col items-center justify-center min-h-64 text-center">
          <div className="w-16 h-16 rounded-2xl bg-zinc-800 flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
            </svg>
          </div>
          <p className="text-zinc-300 font-semibold mb-1">No projects yet</p>
          <p className="text-zinc-500 text-sm mb-5">Organise your video clips into named projects</p>
          <button
            onClick={() => setShowNewModal(true)}
            className="min-h-12 px-6 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold transition-colors"
          >
            Create your first project
          </button>
        </div>
      )}

      {!loading && projects.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} onClick={() => setActiveProjectId(p.id)} />
          ))}
        </div>
      )}

      {showNewModal && (
        <NewProjectModal onClose={() => setShowNewModal(false)} onCreated={handleCreated} />
      )}
    </div>
  );
}
