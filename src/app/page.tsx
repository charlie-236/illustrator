'use client';

import { useState, useCallback } from 'react';
import Studio from '@/components/Studio';
import Gallery from '@/components/Gallery';
import Projects from '@/components/Projects';
import ModelConfig from '@/components/ModelConfig';
import ServerBay from '@/components/ServerBay';
import TabNav from '@/components/TabNav';
import ToastContainer from '@/components/Toast';
import { QueueProvider } from '@/contexts/QueueContext';
import type { GenerationParams, GenerationRecord, LoraEntry, VideoRemixData, ProjectContext, ProjectDetail, ProjectClip } from '@/types';

export type Tab = 'studio' | 'projects' | 'gallery' | 'models' | 'admin';

function parseLoras(loraStr: string | null): LoraEntry[] {
  if (!loraStr) return [];
  return loraStr.split(', ').flatMap((part) => {
    const m = part.match(/^(.+) \((-?\d+(?:\.\d+)?)\)$/);
    return m ? [{ name: m[1], weight: parseFloat(m[2]) }] : [];
  });
}

function recordToParams(record: GenerationRecord): GenerationParams {
  return {
    checkpoint: record.model,
    loras: record.lorasJson ?? parseLoras(record.lora),
    positivePrompt: record.promptPos,
    negativePrompt: record.promptNeg,
    width: record.width,
    height: record.height,
    steps: record.steps,
    cfg: record.cfg,
    seed: -1,
    sampler: record.sampler,
    scheduler: record.scheduler,
    batchSize: 1,
    highResFix: record.highResFix,
  };
}

export default function Home() {
  const [tab, setTab] = useState<Tab>('studio');
  const [refreshGallery, setRefreshGallery] = useState(0);
  const [remixParams, setRemixParams] = useState<GenerationParams | null>(null);
  const [videoRemixParams, setVideoRemixParams] = useState<VideoRemixData | null>(null);
  const [modelConfigVersion, setModelConfigVersion] = useState(0);
  const [projectsKey, setProjectsKey] = useState(0);
  const [projectContextTrigger, setProjectContextTrigger] = useState<ProjectContext | null>(null);

  const handleRemix = useCallback((record: GenerationRecord) => {
    if (record.mediaType === 'video') {
      setVideoRemixParams({
        positivePrompt: record.promptPos,
        width: record.width,
        height: record.height,
        frames: record.frames ?? 57,
        steps: record.steps,
        cfg: record.cfg,
      });
      setRemixParams(null);
    } else {
      setRemixParams(recordToParams(record));
      setVideoRemixParams(null);
    }
    setTab('studio');
  }, []);

  const handleRemixConsumed = useCallback(() => setRemixParams(null), []);
  const handleVideoRemixConsumed = useCallback(() => setVideoRemixParams(null), []);
  const handleNavigateToGallery = useCallback(() => setTab('gallery'), []);
  const handleNavigateToProjects = useCallback(() => {
    setProjectsKey((k) => k + 1);
    setTab('projects');
  }, []);
  const handleProjectContextTriggerConsumed = useCallback(() => setProjectContextTrigger(null), []);
  const handleGenerateInProject = useCallback((project: ProjectDetail, latestClip: ProjectClip | null) => {
    const context: ProjectContext = {
      projectId: project.id,
      projectName: project.name,
      latestClipId: latestClip?.id ?? null,
      latestClipPrompt: latestClip?.prompt ?? null,
      defaults: {
        frames: project.defaultFrames,
        steps: project.defaultSteps,
        cfg: project.defaultCfg,
        width: project.defaultWidth,
        height: project.defaultHeight,
      },
    };
    setProjectContextTrigger(context);
    setTab('studio');
  }, []);

  return (
    <QueueProvider>
      <div className="flex flex-col min-h-screen max-w-2xl mx-auto">
        <TabNav active={tab} onChange={setTab} />
        <main className="flex-1 overflow-y-auto pb-24">
          <div className={tab === 'studio' ? '' : 'hidden'}>
            <Studio
              tab={tab}
              onGenerated={() => setRefreshGallery((n) => n + 1)}
              remixParams={remixParams}
              onRemixConsumed={handleRemixConsumed}
              videoRemixParams={videoRemixParams}
              onVideoRemixConsumed={handleVideoRemixConsumed}
              onRemix={handleRemix}
              modelConfigVersion={modelConfigVersion}
              onNavigateToGallery={handleNavigateToGallery}
              projectContextTrigger={projectContextTrigger}
              onProjectContextTriggerConsumed={handleProjectContextTriggerConsumed}
            />
          </div>
          <div className={tab === 'projects' ? '' : 'hidden'}>
            <Projects
              key={projectsKey}
              onNavigateToGallery={handleNavigateToGallery}
              onGenerateInProject={handleGenerateInProject}
            />
          </div>
          <div className={tab === 'projects' ? '' : 'hidden'}>
            <Projects key={projectsKey} onNavigateToGallery={handleNavigateToGallery} />
          </div>
          <div className={tab === 'gallery' ? '' : 'hidden'}>
            <Gallery refreshToken={refreshGallery} onRemix={handleRemix} onNavigateToProject={handleNavigateToProjects} />
          </div>
          <div className={tab === 'models' ? '' : 'hidden'}>
            <ModelConfig onSaved={() => setModelConfigVersion((n) => n + 1)} />
          </div>
          <div className={tab === 'admin' ? '' : 'hidden'}>
            <ServerBay />
          </div>
        </main>
        <ToastContainer onNavigateToGallery={handleNavigateToGallery} />
      </div>
    </QueueProvider>
  );
}
