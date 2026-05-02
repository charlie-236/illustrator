// Notification helpers: audio chime, browser notifications.
// All functions are client-side only — never call from server-side code.

const NOTIF_PERM_KEY = 'queue-notif-perm';

// ─── audio chime ─────────────────────────────────────────────────────────────

// Synthesises a short bell-like chime (880 Hz → 660 Hz, ~0.8 s) using the
// Web Audio API. No external asset required.
export function playChime(volume = 0.5): void {
  try {
    const ctx = new AudioContext();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.4);

    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);

    osc.start(now);
    osc.stop(now + 0.8);

    osc.onended = () => { void ctx.close(); };
  } catch {
    // AudioContext may be blocked or unavailable (e.g. SSR) — silently skip
  }
}

// ─── browser notifications ────────────────────────────────────────────────────

// Returns the permission state the user previously granted/denied, or 'default'
// if they've never been asked. Reads from localStorage so we don't prompt again
// if they denied.
export function getStoredPermission(): NotificationPermission | 'default' {
  if (typeof window === 'undefined') return 'default';
  try {
    const v = localStorage.getItem(NOTIF_PERM_KEY);
    if (v === 'granted' || v === 'denied') return v;
  } catch { /* ignore */ }
  return 'default';
}

// Requests notification permission if not already decided. Stores the result
// in localStorage so we don't prompt again after a denial.
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'denied';

  const stored = getStoredPermission();
  if (stored === 'denied') return 'denied';
  if (stored === 'granted' || Notification.permission === 'granted') return 'granted';

  try {
    const perm = await Notification.requestPermission();
    try { localStorage.setItem(NOTIF_PERM_KEY, perm); } catch { /* ignore */ }
    return perm;
  } catch {
    return 'denied';
  }
}

// Fires a browser notification if permission is granted and the tab is not
// in the foreground. onclick focuses the tab.
export function sendBrowserNotification(opts: {
  title: string;
  body: string;
  tag: string;
}): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  // Skip if the tab is visible — the toast covers it
  if (!document.hidden) return;

  try {
    const n = new Notification(opts.title, { body: opts.body, tag: opts.tag });
    n.onclick = () => { window.focus(); };
  } catch { /* ignore */ }
}
