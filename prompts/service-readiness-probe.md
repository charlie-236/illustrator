# Batch — Real-readiness status probe for Admin tab services

`/api/services/status` runs `systemctl is-active <unit>` over SSH and reports binary `'active' | 'inactive' | 'unknown'`. The Admin tab's Service Status therefore goes green the moment the systemd unit is up — but for ComfyUI and Aphrodite, that's seconds after Start while the model takes minutes to load into VRAM. The user sees green dots for services that aren't actually serving requests yet.

Fix: keep the systemd check as the "process running" signal, add an HTTP readiness probe per service on top of it, and combine into a three-state value: `'ready' | 'loading' | 'inactive'` (plus `'unknown'` for SSH transport failures).

All probes go through localhost ports — the SSH tunnels managed on mint-pc are the single ingress for HTTP traffic to the VM. SSH stays in the route only for the systemctl side, since `systemctl is-active` isn't exposed over HTTP.

Re-read CLAUDE.md before starting — disk-avoidance is unaffected.

---

## Required changes

### `src/app/api/services/status/route.ts` — combine systemctl with HTTP probes

Today the route produces statuses from systemd alone. Replace with a two-source check:

1. **SSH systemctl** (existing) — runs `systemctl is-active <unit>` for all three services in one shell command. Same single-round-trip pattern as today; the systemctl logic itself doesn't change.
2. **HTTP localhost probes** (new) — one `fetch()` per service to a known endpoint that only responds 2xx when the model is fully loaded.

Service config — replace the existing `SERVICE_UNITS` constant with a richer one that co-locates the systemd unit and the probe URL per service:

```ts
const SERVICE_CONFIG: Record<ServiceName, { unit: string; probeUrl: string }> = {
  'comfy-illustrator': {
    unit: 'comfy-illustrator.service',
    probeUrl: 'http://127.0.0.1:8188/system_stats',
  },
  'aphrodite-writer': {
    unit: 'aphrodite-writer',
    probeUrl: 'http://127.0.0.1:21434/v1/models',
  },
  'aphrodite-cinematographer': {
    unit: 'aphrodite-cinematographer',
    probeUrl: 'http://127.0.0.1:11438/v1/models',
  },
};
```

Don't add new env vars for the probe URLs. The values are stable and documented in CLAUDE.md.

Probe function:

```ts
async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}
```

`res.ok` is 2xx. Any error — connection refused, timeout, 5xx, 4xx — returns `false`. The user's scenario (model loading) presents as either connection refused or 5xx, both covered by `!res.ok || throw`. We don't inspect the body.

Run SSH and probes concurrently (independent operations, no reason to serialize):

```ts
const [systemdResults, probeResults] = await Promise.all([
  runSystemctlChecks(),  // existing logic, factored into a helper if needed
  Promise.all(SERVICES.map((s) => probe(SERVICE_CONFIG[s].probeUrl))),
]);
```

Where `runSystemctlChecks()` is the existing SSH+`systemctl is-active` block, returning `Record<ServiceName, number>` (exit codes per service) — extract it from the current route body if it makes the new logic cleaner.

Combine logic:

```ts
const statuses: Record<ServiceName, ServiceStatus> = { /* all 'unknown' */ };
SERVICES.forEach((name, i) => {
  const systemdActive = systemdResults[name] === 0;
  const probeOk = probeResults[i];
  if (!systemdActive) statuses[name] = 'inactive';
  else if (probeOk) statuses[name] = 'ready';
  else statuses[name] = 'loading';
});
```

If SSH fails entirely: keep today's behavior — return HTTP 500 with the SSH error string. Without systemd info, probe results alone aren't actionable.

The response shape stays `{ statuses: Record<ServiceName, ServiceStatus> }`. The `ServiceStatus` union widens; only `ServerBay.tsx` consumes this, so updating it (below) is the only consumer change.

### `src/components/ServerBay.tsx` — three-state status union and StatusDot

Find:

```ts
type ServiceStatus = 'active' | 'inactive' | 'unknown';
```

Replace with:

```ts
type ServiceStatus = 'ready' | 'loading' | 'inactive' | 'unknown';
```

`BLANK_STATUSES` — initial value stays `'unknown'` for all three services.

`StatusDot` color logic, currently:

```ts
const color =
  status === 'active'
    ? 'bg-emerald-400'
    : status === 'inactive'
    ? 'bg-red-500'
    : 'bg-zinc-600';
```

Replace with:

```ts
const color =
  status === 'ready'
    ? 'bg-emerald-400'
    : status === 'loading'
    ? 'bg-amber-400 animate-pulse'
    : status === 'inactive'
    ? 'bg-red-500'
    : 'bg-zinc-600';
```

The `animate-pulse` on the loading state visually distinguishes "in flight" from "settled green" without needing a heavier loading-spinner UI. If `animate-pulse` looks too aggressive on a 2.5px dot in the tablet viewport, drop it — the amber color alone is sufficient. Match the existing dot size and shape; nothing else about `StatusDot` changes.

Verify with `grep -n "'active'" src/components/ServerBay.tsx` that no other code is checking for the old literal. The `actionState` union (`'idle' | 'pending' | 'sent' | 'error'`) is unrelated and uses different strings — don't conflate them.

### Tunnel preconditions (NOT a code change — call out in PR description)

For all three probes to succeed, mint-pc must have SSH tunnels forwarding these ports to the VM:

- `127.0.0.1:8188` → `a100:8188` — ComfyUI. Already exists per ecosystem.config.js (used by /api/generate).
- `127.0.0.1:11438` → `a100:11438` — polisher. Already in use by /api/generate/polish, so the tunnel is live.
- `127.0.0.1:21434` → `a100:21434` — writer. Used by SillyTavern; the user confirms this should be tunneled but hasn't confirmed it currently is.

If the writer tunnel doesn't exist, the writer probe will fail and report `'loading'` indefinitely even when the writer is fully up. The PR description should flag this as a precondition the user verifies before end-to-end testing — `curl http://127.0.0.1:21434/v1/models` from mint-pc must return 200 when the writer is loaded.

Don't modify `ecosystem.config.js` to add the tunnel. AGENTS.md forbids it; the user owns the tunnel infrastructure.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `src/app/api/services/status/route.ts` defines `SERVICE_CONFIG` with `{ unit, probeUrl }` per service.
- The status route runs SSH and HTTP probes inside a single top-level `Promise.all`, not sequentially.
- Probe timeout is 5000 ms via `AbortSignal.timeout(5000)`.
- `grep -n "'active'" src/components/ServerBay.tsx` returns no matches inside `ServiceStatus`-related code (the `actionState` union's strings are unaffected).
- `grep -n "ServiceStatus" src/components/ServerBay.tsx` shows the new union `'ready' | 'loading' | 'inactive' | 'unknown'`.
- `StatusDot` renders `bg-amber-400` (with or without `animate-pulse`) when status is `'loading'` and `bg-emerald-400` when `'ready'`.

Manual smoke test (deferred to user):
1. Stop the polisher via the Admin tab. Hit Check Status. The polisher row is red (`'inactive'`).
2. Start the polisher. Within ~2 seconds (before VRAM load completes), hit Check Status. The polisher row is amber (`'loading'`).
3. Wait for the polisher to finish loading (the model takes ~minutes). Verify externally with `curl http://127.0.0.1:11438/v1/models` returning 200. Hit Check Status again — the polisher row is now green (`'ready'`).
4. Repeat 2–3 for the writer at port 21434. If the writer tunnel isn't configured on mint-pc, the row will stay amber permanently — that's the precondition; add the tunnel to ecosystem.config.js and `pm2 restart` separately if needed (not part of this batch).
5. Start ComfyUI. The dot should be green within seconds (no VRAM load step for the ComfyUI process itself; checkpoint loading happens lazily at first generation).
6. Verify the existing post-action 2.5s auto-recheck still fires after Start All / Stop All — no regression in that flow.

---

## Out of scope

- Don't auto-poll status while any service is `'loading'`. The current manual-button UX is preserved. Auto-poll while loading can be a follow-up if the user finds the manual refresh clumsy.
- Don't add new env vars for the probe URLs.
- Don't modify `ecosystem.config.js` to add the writer tunnel.
- Don't change `/api/services/control` (start/stop semantics are unchanged).
- Don't probe `/health`, `/v1/chat/completions`, or any deeper endpoint. `/v1/models` is the canonical lightweight readiness check for Aphrodite-style servers; `/system_stats` is the equivalent for ComfyUI.
- Don't introduce a per-service "last checked at" timestamp or staleness indicator. Out of scope.
- Don't change the SSH side of the status check. systemd inspection works correctly today — the probe is purely additive.

---

## Documentation

In CLAUDE.md, find the `GET /api/services/status` section. Today it reads roughly:

```
Opens a single SSH session, runs `systemctl is-active {unit}` for all three services in one command, and returns:
  { statuses: Record<ServiceName, 'active' | 'inactive' | 'unknown'> }
Exit code 0 from systemctl is-active → active; anything else → inactive.
If SSH fails entirely, returns HTTP 500.
```

Replace with:

```
Combines two checks per service, run in parallel: (1) SSH `systemctl is-active <unit>` (process running) and (2) HTTP probe of the service's endpoint via the localhost SSH tunnel (process actually answering). Returns:

  { statuses: Record<ServiceName, 'ready' | 'loading' | 'inactive' | 'unknown'> }

- inactive — systemd reports the unit isn't active.
- loading — systemd active, HTTP probe failed or timed out (5 s). Typically means the model is still loading into VRAM.
- ready — systemd active and the probe returned 2xx.
- unknown — SSH itself failed; HTTP results aren't meaningful in that case (route returns HTTP 500).

Probe endpoints:
| Service | Probe URL |
|---|---|
| comfy-illustrator | http://127.0.0.1:8188/system_stats |
| aphrodite-writer | http://127.0.0.1:21434/v1/models |
| aphrodite-cinematographer | http://127.0.0.1:11438/v1/models |

All probes go through mint-pc localhost tunnels. The writer (21434) and polisher (11438) tunnels must be live on mint-pc for their probes to succeed. ComfyUI (8188) shares the tunnel used by /api/generate.
```

Also: in the source layout section, the entry for `services/status/` says "for all four services" — should be three. Fix while you're in there.

When done, push and create the PR via `gh pr create` per AGENTS.md.
