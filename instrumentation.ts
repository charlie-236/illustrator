export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startQueueRunner } = await import('./src/lib/queueRunner');
    startQueueRunner();
  }
}
