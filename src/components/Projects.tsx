'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ProjectSummary, ProjectDetail, ProjectClip } from '@/types';
import ProjectDetailView from './ProjectDetail';
import NewProjectModal from './NewProjectModal';
import { imgSrc } from '@/lib/imageSrc';

interface Props {
  onNavigateToGallery: () => void;
  onGenerateInProject: (project: ProjectDetail, latestClip: ProjectClip | null, mode: 'image' | 'video') => void;
}

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
          project.coverMediaType === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imgSrc(project.coverFrame)}
              alt={project.name}
              className="w-full h-full object-cover"
            />
          ) : (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              src={imgSrc(project.coverFrame)}
              preload="metadata"
              muted
              playsInline
              className="w-full h-full object-cover"
            />
          )
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
