'use client';

import { useState, useEffect } from 'react';
import type { ProjectSummary } from '@/types';

interface Props {
  open: boolean;
  currentProjectId: string | null;
  title?: string;
  /** Disables all buttons during an async operation (e.g. assignment PATCH). */
  busy?: boolean;
  onClose: () => void;
  /** Called with (projectId, projectName); null means "None / unassign". */
  onSelect: (projectId: string | null, projectName: string | null) => void;
  onCreateNew: () => void;
}

export default function ProjectPicker({
  open,
  currentProjectId,
  title = 'Switch project',
  busy = false,
  onClose,
  onSelect,
  onCreateNew,
}: Props) {
  const [projects, setProjects] = useState<Pick<ProjectSummary, 'id' | 'name' | 'clipCount'>[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  // Fetch list whenever picker opens (always fresh).
  useEffect(() => {
    if (!open) { setSearch(''); setProjects(null); return; }
    setLoading(true);
    fetch('/api/projects')
      .then((r) => r.json())
      .then(({ projects: ps }: { projects: Pick<ProjectSummary, 'id' | 'name' | 'clipCount'>[] }) => {
        setProjects(ps ?? []);
      })
      .catch(() => setProjects([]))
      .finally(() => setLoading(false));
  }, [open]);

  // Remove deleted projects from the live list while picker is open.
  useEffect(() => {
    if (!open) return;
    function onDeleted(e: Event) {
      const { id } = (e as CustomEvent<{ id: string }>).detail;
      setProjects((prev) => prev ? prev.filter((p) => p.id !== id) : prev);
    }
    window.addEventListener('project-deleted', onDeleted);
    return () => window.removeEventListener('project-deleted', onDeleted);
  }, [open]);

  // Escape closes picker.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    }
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, [open, onClose]);

  if (!open) return null;

  const filtered = projects
    ? projects.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()))
    : [];

  return (
    <div
      className="fixed inset-0 flex items-end justify-center bg-black/60"
      style={{ zIndex: 60 }}
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-t-2xl w-full max-h-[70vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-zinc-800 flex-shrink-0">
          <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
          <button
            onClick={onClose}
            className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Search — only when list is large */}
        {projects && projects.length > 10 && (
          <div className="px-4 pt-3 pb-2 flex-shrink-0">
            <input
              className="input-base"
              placeholder="Search projects…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>
        )}

        {/* List */}
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="px-5 py-4 text-sm text-zinc-500">Loading…</div>
          ) : (
            <>
              {/* None option */}
              <button
                onClick={() => onSelect(null, null)}
                disabled={busy}
                className={`w-full min-h-12 px-5 flex items-center justify-between text-sm transition-colors hover:bg-zinc-800 disabled:opacity-50
                  ${!currentProjectId ? 'text-violet-300 font-medium' : 'text-zinc-300'}`}
              >
                <span>None</span>
                {!currentProjectId && (
                  <svg className="w-4 h-4 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>

              {/* Project list */}
              {filtered.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onSelect(p.id, p.name)}
                  disabled={busy}
                  className={`w-full min-h-12 px-5 flex items-center justify-between text-sm transition-colors hover:bg-zinc-800 disabled:opacity-50
                    ${currentProjectId === p.id ? 'text-violet-300 font-medium' : 'text-zinc-200'}`}
                >
                  <span className="truncate mr-2">{p.name}</span>
                  <span className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-xs text-zinc-500">{p.clipCount} clips</span>
                    {currentProjectId === p.id && (
                      <svg className="w-4 h-4 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>
                </button>
              ))}

              {projects && projects.length === 0 && !search && (
                <p className="px-5 py-3 text-sm text-zinc-500">No projects yet.</p>
              )}

              {projects && search && filtered.length === 0 && (
                <p className="px-5 py-3 text-sm text-zinc-500">No matches for &ldquo;{search}&rdquo;</p>
              )}

              {/* Create new project */}
              <button
                onClick={onCreateNew}
                disabled={busy}
                className="w-full min-h-12 px-5 flex items-center gap-2 text-sm text-violet-400 hover:bg-zinc-800 disabled:opacity-50 transition-colors border-t border-zinc-800"
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Create new project
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
