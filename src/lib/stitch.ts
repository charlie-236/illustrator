import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';

interface ClipMeta {
  width: number;
  height: number;
  fps: number;
  durationSecs: number;
  frameCount: number;
}

function parseFps(str: string): number {
  const parts = str.split('/');
  if (parts.length === 2) {
    const n = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    return d > 0 ? n / d : n || 16;
  }
  return parseFloat(str) || 16;
}

async function probeClip(filePath: string): Promise<ClipMeta> {
  return new Promise((resolve, reject) => {
    const cp = spawn('ffprobe', [
      '-v', 'quiet', '-print_format', 'json',
      '-show_streams', '-show_format', filePath,
    ]) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    cp.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    cp.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    cp.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed (code ${code}): ${stderr.slice(0, 200)}`));
        return;
      }
      try {
        const info = JSON.parse(stdout) as {
          streams: Array<{
            codec_type: string;
            width?: number;
            height?: number;
            r_frame_rate?: string;
            duration?: string;
          }>;
          format?: { duration?: string };
        };
        const vs = info.streams?.find((s) => s.codec_type === 'video');
        if (!vs) { reject(new Error(`No video stream in ${path.basename(filePath)}`)); return; }
        const fps = parseFps(vs.r_frame_rate ?? '16/1');
        const durationSecs = parseFloat(info.format?.duration ?? vs.duration ?? '0');
        const width = vs.width ?? 1280;
        const height = vs.height ?? 704;
        resolve({ width, height, fps, durationSecs, frameCount: Math.round(durationSecs * fps) });
      } catch (e) {
        reject(new Error(`ffprobe parse error: ${e}`));
      }
    });
  });
}

async function runFfmpeg(
  args: string[],
  totalFrames: number,
  onProgress?: (frame: number, total: number) => void,
  onChildProcess?: (cp: ChildProcessWithoutNullStreams) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const cp = spawn('ffmpeg', args) as ChildProcessWithoutNullStreams;
    onChildProcess?.(cp);

    let progBuf = '';
    let stderrFull = '';
    let finalFrame = 0;
    let reportCount = 0;

    cp.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderrFull += s;
      progBuf += s;
      const lines = progBuf.split('\n');
      progBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('frame=')) {
          const f = parseInt(line.slice(6).trim(), 10);
          if (!isNaN(f)) {
            finalFrame = f;
            reportCount++;
            if (reportCount % 10 === 0) onProgress?.(f, totalFrames);
          }
        }
      }
    });

    cp.on('close', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error('ffmpeg process was killed'));
        return;
      }
      if (code !== 0) {
        const tail = stderrFull.split('\n').slice(-8).join('\n');
        reject(new Error(`ffmpeg exited with code ${code}: ${tail}`));
        return;
      }
      if (finalFrame > 0) onProgress?.(finalFrame, totalFrames);
      resolve(finalFrame);
    });
  });
}

export async function stitchProject(params: {
  clipPaths: string[];
  outputPath: string;
  transition: 'hard-cut' | 'crossfade';
  onProgress?: (frame: number, totalFrames: number) => void;
  onChildProcess?: (cp: ChildProcessWithoutNullStreams) => void;
}): Promise<{ width: number; height: number; durationSeconds: number; frameCount: number }> {
  const { clipPaths, outputPath, transition, onProgress, onChildProcess } = params;

  if (clipPaths.length < 2) throw new Error('At least 2 clips required');

  const metas = await Promise.all(clipPaths.map(probeClip));
  const first = metas[0];
  const targetW = first.width;
  const targetH = first.height;
  const targetFps = Math.round(first.fps) || 16;
  const n = metas.length;

  const allSame = metas.every(
    (m) => m.width === targetW && m.height === targetH && Math.round(m.fps) === targetFps,
  );

  const totalSrcFrames = metas.reduce((s, m) => s + m.frameCount, 0);
  const xDur = 0.5;

  const outDuration = transition === 'crossfade'
    ? Math.max(0, metas.reduce((s, m) => s + m.durationSecs, 0) - xDur * (n - 1))
    : metas.reduce((s, m) => s + m.durationSecs, 0);

  const outFrameEst = Math.round(outDuration * targetFps);

  let finalFrame: number;

  if (transition === 'hard-cut') {
    if (allSame) {
      // Fast path: concat demuxer — requires identical codec/resolution/framerate
      const listContent = clipPaths.map((p) => `file '${p}'`).join('\n');
      const listPath = path.join(
        os.tmpdir(),
        `stitch-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
      );
      await writeFile(listPath, listContent, 'utf8');
      const args = [
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18',
        '-movflags', '+faststart', '-an',
        '-progress', 'pipe:2', '-nostats',
        '-y', outputPath,
      ];
      try {
        finalFrame = await runFfmpeg(args, totalSrcFrames, onProgress, onChildProcess);
      } finally {
        await unlink(listPath).catch(() => {});
      }
    } else {
      // Slow path: concat filter with explicit scale + fps normalisation
      const inputs = clipPaths.flatMap((p) => ['-i', p]);
      const scaled = metas.map((_, i) =>
        `[${i}:v]scale=${targetW}:${targetH},fps=${targetFps},setsar=1[v${i}]`,
      ).join(';');
      const streams = metas.map((_, i) => `[v${i}]`).join('');
      const fc = `${scaled};${streams}concat=n=${n}:v=1:a=0[outv]`;
      const args = [
        ...inputs,
        '-filter_complex', fc,
        '-map', '[outv]',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18',
        '-movflags', '+faststart', '-an',
        '-progress', 'pipe:2', '-nostats',
        '-y', outputPath,
      ];
      finalFrame = await runFfmpeg(args, totalSrcFrames, onProgress, onChildProcess);
    }
  } else {
    // Crossfade path — use xfade filter; pre-scale if resolutions differ
    const inputs = clipPaths.flatMap((p) => ['-i', p]);
    const filterParts: string[] = [];
    let streamLabels: string[];

    if (!allSame) {
      streamLabels = metas.map((_, i) => `[sv${i}]`);
      metas.forEach((_, i) => {
        filterParts.push(
          `[${i}:v]scale=${targetW}:${targetH},fps=${targetFps},setsar=1[sv${i}]`,
        );
      });
    } else {
      streamLabels = metas.map((_, i) => `[${i}:v]`);
    }

    // Chain xfade filters; offset accumulates as (sum of prev durations - overlaps so far)
    let cumulOffset = 0;
    let curLabel = streamLabels[0];
    for (let i = 1; i < n; i++) {
      cumulOffset += metas[i - 1].durationSecs - xDur;
      const outLabel = i === n - 1 ? '[outv]' : `[xf${i}]`;
      filterParts.push(
        `${curLabel}${streamLabels[i]}xfade=transition=fade:duration=${xDur}:offset=${cumulOffset.toFixed(3)}${outLabel}`,
      );
      curLabel = `[xf${i}]`;
    }

    const fc = filterParts.join(';');
    const args = [
      ...inputs,
      '-filter_complex', fc,
      '-map', '[outv]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18',
      '-movflags', '+faststart', '-an',
      '-progress', 'pipe:2', '-nostats',
      '-y', outputPath,
    ];
    finalFrame = await runFfmpeg(args, totalSrcFrames, onProgress, onChildProcess);
  }

  return {
    width: targetW,
    height: targetH,
    durationSeconds: outDuration,
    frameCount: finalFrame > 0 ? finalFrame : outFrameEst,
  };
}
