'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CheckpointConfig, LoraConfig, ModelInfo } from '@/types';

export interface ModelLists {
  checkpoints: string[];
  loras: string[];
  checkpointNames: Record<string, string>;
  checkpointBaseModels: Record<string, string>;
  loraNames: Record<string, string>;
  loraTriggerWords: Record<string, string>;
  loraBaseModels: Record<string, string>;
}

const EMPTY: ModelLists = {
  checkpoints: [],
  loras: [],
  checkpointNames: {},
  checkpointBaseModels: {},
  loraNames: {},
  loraTriggerWords: {},
  loraBaseModels: {},
};

export function useModelLists(refreshToken?: number): {
  data: ModelLists;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [data, setData] = useState<ModelLists>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch('/api/models').then((r) => r.json() as Promise<ModelInfo>),
      fetch('/api/checkpoint-config').then((r) => r.json() as Promise<CheckpointConfig[]>).catch(() => []),
      fetch('/api/lora-config').then((r) => r.json() as Promise<LoraConfig[]>).catch(() => []),
    ])
      .then(([modelsData, ckptConfigs, loraConfigs]) => {
        const checkpointNames: Record<string, string> = {};
        const checkpointBaseModels: Record<string, string> = {};
        for (const c of ckptConfigs) {
          if (c.friendlyName) checkpointNames[c.checkpointName] = c.friendlyName;
          if (c.baseModel) checkpointBaseModels[c.checkpointName] = c.baseModel;
        }
        const loraNames: Record<string, string> = {};
        const loraTriggerWords: Record<string, string> = {};
        const loraBaseModels: Record<string, string> = {};
        for (const l of loraConfigs) {
          if (l.friendlyName) loraNames[l.loraName] = l.friendlyName;
          if (l.triggerWords?.trim()) loraTriggerWords[l.loraName] = l.triggerWords;
          if (l.baseModel?.trim()) loraBaseModels[l.loraName] = l.baseModel;
        }
        setData({
          checkpoints: modelsData.checkpoints ?? [],
          loras: modelsData.loras ?? [],
          checkpointNames,
          checkpointBaseModels,
          loraNames,
          loraTriggerWords,
          loraBaseModels,
        });
      })
      .catch((err) => {
        setError(String(err));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshToken]);

  return { data, loading, error, refresh };
}
