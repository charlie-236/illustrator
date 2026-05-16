# Batch — Strip hardcoded service identities and username (privacy + configurability)

Two privacy/configurability issues are mixed throughout the codebase:

1. **Service identities hardcoded everywhere.** The systemd unit names (`comfy-illustrator`, `aphrodite-writer`, `aphrodite-cinematographer`), the probe URLs (`127.0.0.1:8188/system_stats`, `127.0.0.1:21434/health`, `127.0.0.1:11438/health`), and the human display labels ("Image Generation", "Writer", "Prompt Polisher") are baked into source. Anyone reading the public repo learns the user's exact service taxonomy and the user can't reconfigure without code changes.
2. **Username `charlie` appears in `.env.example`, scripts, and several prompt/doc files.** Privacy issue. The repo is public; the username doesn't need to be.

Fix both. Service identities move to numbered env vars (`SERVICE_1_*` through `SERVICE_N_*`); the route and UI iterate over whatever's configured. Username gets stripped from every file in the repo, replaced with placeholder syntax (`<your-user>`) that lines up with the existing `<gpu-vm-ip>` placeholders.

Re-read CLAUDE.md before starting. Disk-avoidance is unaffected — no workflow / WS / finalize changes.

---

## Critical

This batch only touches **the public-repo surface**: source code, `.env.example`, prompt files in `tasks/`, and `CLAUDE.md`. The user's local `.env` is theirs to update — the agent doesn't see it, doesn't write it, and doesn't pretend to know what's in it.

Tablet UX: ServerBay's display labels become user-supplied. The agent can't know what the user will type, so the rendering must handle long labels (truncate or wrap gracefully) and the empty-services case (no services configured → friendly empty state).

---

## Required changes

### Part 1 — Service identities into numbered env vars

`.env.example` gets a new section that defines services slot-by-slot:

```
# ── Services ──────────────────────────────────────────────────────────────────
# Configure the services shown on the Admin tab's Service Status panel and
# controlled via the Start/Stop buttons.
#
# Up to 5 services supported (SERVICE_1_* through SERVICE_5_*). Leave a slot's
# vars unset to skip it. Each configured service requires ALL FOUR vars below.
#
# - SERVICE_N_KEY: stable identifier used in API calls. Lowercase, no spaces.
#                  Sample: image-gen, writer, polisher
# - SERVICE_N_UNIT: systemctl unit name on the GPU VM.
#                   Include the `.service` suffix or omit per your systemd config.
# - SERVICE_N_PROBE_URL: HTTP endpoint that returns 2xx only when the service
#                        is fully ready (model loaded, accepting requests).
# - SERVICE_N_LABEL: Human-readable display name shown in the Admin tab UI.

SERVICE_1_KEY=image-gen
SERVICE_1_UNIT=comfyui.service
SERVICE_1_PROBE_URL=http://127.0.0.1:8188/system_stats
SERVICE_1_LABEL=Image Generation

SERVICE_2_KEY=writer
SERVICE_2_UNIT=writer.service
SERVICE_2_PROBE_URL=http://127.0.0.1:21434/health
SERVICE_2_LABEL=Writer

SERVICE_3_KEY=polisher
SERVICE_3_UNIT=polisher.service
SERVICE_3_PROBE_URL=http://127.0.0.1:11438/health
SERVICE_3_LABEL=Prompt Polisher

# SERVICE_4_KEY=...
# SERVICE_4_UNIT=...
# SERVICE_4_PROBE_URL=...
# SERVICE_4_LABEL=...

# SERVICE_5_KEY=...
# SERVICE_5_UNIT=...
# SERVICE_5_PROBE_URL=...
# SERVICE_5_LABEL=...
```

Sample values (`image-gen`, `comfyui.service`, etc.) are illustrative — they don't have to match the user's actual service names. The point is the shape; the user fills in their own.

### Part 2 — New shared services config loader

Create `src/lib/servicesConfig.ts`:

```ts
export interface ServiceConfig {
  key: string;        // SERVICE_N_KEY — stable identifier for API contracts
  unit: string;       // SERVICE_N_UNIT — systemctl unit name
  probeUrl: string;   // SERVICE_N_PROBE_URL — HTTP readiness check
  label: string;      // SERVICE_N_LABEL — human display name
}

const MAX_SERVICE_SLOTS = 5;

let cachedServices: ServiceConfig[] | null = null;

/**
 * Reads SERVICE_1_* through SERVICE_N_* from env and returns the configured
 * services in slot order. A slot is included only when ALL FOUR vars are set
 * and non-empty. Slots with any missing var are skipped silently.
 *
 * Cached after first read for the lifetime of the process.
 */
export function loadServicesConfig(): ServiceConfig[] {
  if (cachedServices !== null) return cachedServices;

  const services: ServiceConfig[] = [];
  for (let i = 1; i <= MAX_SERVICE_SLOTS; i++) {
    const key = process.env[`SERVICE_${i}_KEY`]?.trim();
    const unit = process.env[`SERVICE_${i}_UNIT`]?.trim();
    const probeUrl = process.env[`SERVICE_${i}_PROBE_URL`]?.trim();
    const label = process.env[`SERVICE_${i}_LABEL`]?.trim();

    // Slot must have ALL four vars set; otherwise skip.
    if (key && unit && probeUrl && label) {
      services.push({ key, unit, probeUrl, label });
    }
  }

  cachedServices = services;
  return services;
}

/**
 * Lookup a service by its key. Returns null if no service with that key exists.
 */
export function getServiceByKey(key: string): ServiceConfig | null {
  return loadServicesConfig().find((s) => s.key === key) ?? null;
}
```

The cache is process-lifetime — Next.js dev mode reloads the module on env changes via hot-reload, production restarts pick up `.env` updates on `pm2 restart illustrator`. No need for cache invalidation logic.

### Part 3 — Status route consumes the config

`src/app/api/services/status/route.ts` — replace the hardcoded `SERVICE_CONFIG` and `ServiceName` union with calls to `loadServicesConfig()`.

The `ServiceName` type narrows away — service keys are now plain `string` at the route boundary. The response shape becomes:

```ts
type ServiceStatus = 'ready' | 'loading' | 'inactive' | 'unknown';

interface StatusResponse {
  statuses: Record<string, ServiceStatus>;  // keyed by service.key
}
```

Implementation outline:

```ts
import { loadServicesConfig } from '@/lib/servicesConfig';

export async function GET() {
  const services = loadServicesConfig();
  if (services.length === 0) {
    return Response.json({ statuses: {} });
  }

  // SSH check (existing logic, parameterized over the loaded services)
  const cmd = services
    .map((s) => `systemctl is-active ${s.unit} >/dev/null 2>&1; echo "${s.key}:$?"`)
    .join('; ');

  // ... existing SSH connection setup ...

  // Probe in parallel with SSH
  const [systemctlResults, probeResults] = await Promise.all([
    runSystemctlChecks(ssh, services, cmd),
    Promise.all(services.map((s) => probe(s.probeUrl))),
  ]);

  const statuses: Record<string, ServiceStatus> = {};
  services.forEach((s, i) => {
    const systemdActive = systemctlResults[s.key] === 0;
    const probeOk = probeResults[i];
    if (!systemdActive) statuses[s.key] = 'inactive';
    else if (probeOk) statuses[s.key] = 'ready';
    else statuses[s.key] = 'loading';
  });

  return Response.json({ statuses });
}
```

`runSystemctlChecks(ssh, services, cmd)` — extract the existing parsing logic into a helper that takes the services array and returns `Record<string, number>` keyed by service key.

### Part 4 — Control route consumes the config

`src/app/api/services/control/route.ts` — replace the hardcoded `SERVICE_UNITS` map with a `getServiceByKey` lookup:

```ts
import { getServiceByKey } from '@/lib/servicesConfig';

export async function POST(req: NextRequest) {
  // ... existing SSH credential checks ...

  const { serviceName, action } = body;
  const service = getServiceByKey(serviceName);
  if (!service) {
    return Response.json({ error: `Unknown service: ${serviceName}` }, { status: 400 });
  }
  if (action !== 'start' && action !== 'stop') {
    return Response.json({ error: "action must be 'start' or 'stop'" }, { status: 400 });
  }

  // ... existing SSH connect + execute logic, using service.unit ...
}
```

The `serviceName` parameter on the request body is unchanged — clients send the user-configured key (e.g., `image-gen`).

### Part 5 — ServerBay reads services from a new endpoint

ServerBay needs the list of services to render. Two options:

**(a)** Add a `GET /api/services/list` endpoint that returns the configured services (without secrets — return `{ key, label }` only, no unit names, no probe URLs).

**(b)** Extend the status endpoint's response to include service metadata alongside statuses.

**(a) is cleaner** — separates "what services exist" from "what's their current state." The list is static-per-deployment; the statuses are dynamic. Different cache semantics, different consumers.

New route at `src/app/api/services/list/route.ts`:

```ts
import { loadServicesConfig } from '@/lib/servicesConfig';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const services = loadServicesConfig();
  // Return only key + label — don't expose unit names or probe URLs to the client
  return Response.json({
    services: services.map((s) => ({ key: s.key, label: s.label })),
  });
}
```

The response is small and stable; no caching headers needed.

### Part 6 — ServerBay refactor

`src/components/ServerBay.tsx` is currently full of compile-time-constant arrays (`ALL_SERVICES`, `STACK_ORDER_START`, `STACK_ORDER_STOP`, `BLANK_ACTIONS`, `BLANK_STATUSES`, `SERVICE_LABELS`). All become runtime data from the new endpoint.

```ts
'use client';

import { useState, useCallback, useEffect } from 'react';

interface ServiceMeta {
  key: string;
  label: string;
}

type ActionState = 'idle' | 'pending' | 'sent' | 'error';
type ServiceStatus = 'ready' | 'loading' | 'inactive' | 'unknown';

interface StackProgressEntry {
  service: string;        // service.key
  status: 'pending' | 'running' | 'ok' | 'error';
  error?: string;
}

interface StackOp {
  action: 'start' | 'stop' | null;
  progress: StackProgressEntry[];
}

export default function ServerBay() {
  const [services, setServices] = useState<ServiceMeta[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [servicesError, setServicesError] = useState<string | null>(null);

  const [actionStates, setActionStates] = useState<Record<string, ActionState>>({});
  const [statusMap, setStatusMap] = useState<Record<string, ServiceStatus>>({});
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [stackOp, setStackOp] = useState<StackOp | null>(null);

  // Load services list on mount
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/services/list');
        const data = await res.json() as { services: ServiceMeta[] };
        if (cancelled) return;
        setServices(data.services);
        // Initialize action/status maps from the loaded services
        const initActions: Record<string, ActionState> = {};
        const initStatuses: Record<string, ServiceStatus> = {};
        for (const s of data.services) {
          initActions[s.key] = 'idle';
          initStatuses[s.key] = 'unknown';
        }
        setActionStates(initActions);
        setStatusMap(initStatuses);
      } catch (err) {
        if (!cancelled) setServicesError(String(err));
      } finally {
        if (!cancelled) setServicesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ... existing checkStatus / sendControl / stack-start / stack-stop logic,
  //     parameterized over the loaded `services` array ...
}
```

Stack ordering: today, `STACK_ORDER_START` is `[image-gen, writer, polisher]` and `STACK_ORDER_STOP` is the reverse. After the refactor, "start order" is the loaded services array as-is (slot order from env), and "stop order" is the reversed array. The user controls the order by deciding which slot each service goes in.

```ts
const stackStartOrder = services;
const stackStopOrder = [...services].reverse();
```

**Empty state:** when `services.length === 0` after load completes, render a friendly empty state:

```tsx
{servicesLoading ? (
  <p>Loading services…</p>
) : servicesError ? (
  <p className="text-red-400">Failed to load services: {servicesError}</p>
) : services.length === 0 ? (
  <div className="rounded-xl border border-dashed border-zinc-700 p-6 text-center">
    <p className="text-sm text-zinc-400">No services configured.</p>
    <p className="text-xs text-zinc-500 mt-2">
      Add SERVICE_1_KEY (and the other SERVICE_1_* vars) to your .env file
      to populate this panel.
    </p>
  </div>
) : (
  /* existing service rows, mapped from `services` */
)}
```

**Long labels:** use `truncate` or `line-clamp-2` Tailwind classes on the label rendering so user-supplied long labels don't break the layout.

### Part 7 — Strip `charlie` username from the public repo

Files that contain the username (verify with `grep -rn "charlie" .` after each pass):

**`.env.example`** — replace any `/home/charlie/...` paths with `/home/<your-user>/...` placeholders. The user updates their local `.env` per their own filesystem.

**`add_model.sh`** — verify; the script should already read everything from `.env`, but check for any default values that fall back to a hardcoded path.

**`tasks/*.md`** — every reference to `/home/charlie/` becomes `/home/<your-user>/`. Same for any `charlie@<ip>` SSH commands (those should be `<your-user>@<gpu-vm-ip>` per the existing placeholder convention).

**`CLAUDE.md`** — same sweep. Replace all paths and usernames.

**`ARCHITECT.md`, `DEBUGGER.md`, `QA.md`, `COWORK.md`** — same sweep. The role definition files reference the user's project context but shouldn't bake in the username.

**`ComfyUI-NextJS-Architecture.md`** — already known to contain `charlie@100.96.99.94`. Remove.

**`.claude/settings.local.json`** — this file has multiple `Bash(... /home/charlie/illustrator/...)` permission entries. These are **local-only** to the user's Claude Code install and may not even be tracked in git — verify with `git check-ignore .claude/settings.local.json`. If it IS tracked, replace `/home/charlie/` with `/home/<your-user>/`. If it's gitignored, leave it alone (the user owns it).

**Anywhere else** — `grep -rn "charlie" .` from the repo root catches what's left. Iterate until zero matches outside of `.env`, `node_modules`, `.git`, and gitignored paths.

### Part 8 — Strip residual hardcoded IPs

The earlier env-cleanup batch was supposed to remove `100.96.99.94` from the codebase. Verify with `grep -rn "100\.96\.99\.94" .` — any matches outside of `.env` and gitignored files get replaced with `<gpu-vm-ip>` placeholder.

Same sweep for `mint-pc` if any source file references it as a hostname (it can stay as a conceptual label in CLAUDE.md, but shouldn't appear as a network target in source).

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -rn "comfy-illustrator\|aphrodite-writer\|aphrodite-cinematographer" src/` returns nothing — no hardcoded service identifiers in source.
- `grep -rn "127.0.0.1:8188/system_stats\|127.0.0.1:21434\|127.0.0.1:11438" src/` returns nothing — no hardcoded probe URLs.
- `grep -rn "Image Generation\|Prompt Polisher" src/components/ServerBay.tsx` returns nothing — labels come from env.
- `grep -rn "charlie" .` (excluding `.env`, `node_modules`, `.git`, and gitignored paths) returns nothing.
- `grep -rn "100\.96\.99\.94" .` (same exclusions) returns nothing.
- `src/lib/servicesConfig.ts` exists with `loadServicesConfig` and `getServiceByKey` exports.
- `src/app/api/services/list/route.ts` exists.
- `src/app/api/services/status/route.ts` and `src/app/api/services/control/route.ts` use the loader.
- `src/components/ServerBay.tsx` fetches `/api/services/list` on mount and renders services dynamically.
- ServerBay handles `services.length === 0` with a friendly empty state.
- `.env.example` has SERVICE_1_*, SERVICE_2_*, SERVICE_3_* fully populated with sample values, plus commented-out SERVICE_4_* and SERVICE_5_* slots.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet, post-deploy):

1. **Update `.env`.** Add SERVICE_1_KEY, SERVICE_1_UNIT, SERVICE_1_PROBE_URL, SERVICE_1_LABEL with the user's actual ComfyUI service. Repeat for SERVICE_2 (writer LLM) and SERVICE_3 (polisher LLM). Restart Next.js (`pm2 restart illustrator`).
2. **Service panel populates.** Open Admin tab. Confirm three services appear with the user-supplied labels. Tap Check Status — confirm correct status states (green/amber/red).
3. **Service control works.** Stop a service via the panel. Confirm the systemctl stop runs. Start it again.
4. **Reorder slots.** In `.env`, swap SERVICE_1 and SERVICE_2 contents (writer becomes slot 1, image gen becomes slot 2). Restart. Confirm Admin tab shows them in the new order; "Start all" starts in the new slot order.
5. **Add a fourth service.** Set SERVICE_4_KEY and the rest. Restart. Confirm it appears as a fourth row.
6. **Remove a service.** Comment out all SERVICE_2_* lines. Restart. Confirm Admin tab now shows only services 1, 3, 4 (slot 2 was skipped because it had no key set). Stack-start now starts in this filtered order.
7. **Empty state.** Comment out ALL SERVICE_*_* lines. Restart. Confirm Admin tab shows the "No services configured" message with instructions to set env vars.
8. **Privacy sweep.** `grep -rn "charlie" .` from the deployed code root returns nothing in tracked files. `grep -rn "comfy-illustrator" .` returns nothing in source. The repo is publishable without leaking either piece of info.
9. **Disk-avoidance regression.** `ssh <gpu-vm> ls /models/ComfyUI/output/*.png 2>&1` returns "no such file or directory" after a generation.

---

## Out of scope

- More than 5 service slots. The cap is documented in the loader; raise it later if the user actually needs more services.
- A UI in the Admin tab for editing service config. `.env` is the source of truth; editing it is an out-of-band operation.
- Hot-reload of service config without app restart. `pm2 restart` is fine.
- Per-service environment-specific overrides (different probe URLs in dev vs prod). One env, one set of values.
- Per-slot enable/disable flags. Leave a slot's vars unset = slot disabled. No need for a separate disabled flag.
- A migration script for users with old hardcoded service names in their setup. Updating `.env` is the user's job; the agent doesn't write to anyone's local `.env`.
- Validating that the systemctl unit names actually exist on the VM, or that the probe URLs are reachable, at config-load time. Bad values fail at usage time with the existing error paths.
- Renaming the `serviceName` body field in the control route to `serviceKey`. Field name is established API contract; not worth churning.
- Touching the `ServerBay`'s stack-start / stack-stop progress UI shape. Same UI, just driven by the loaded services array.
- Backwards-compatible reads of the old hardcoded values when env vars are unset. Clean break — old hardcoded values are gone.

---

## Documentation

In CLAUDE.md, find the existing service / env documentation (the table of probe endpoints, the SERVICE_CONFIG section if present). Replace with a description of the SERVICE_N_* slot pattern:

> **Service configuration.** The Admin tab's services are configured via numbered env vars: `SERVICE_1_KEY`, `SERVICE_1_UNIT`, `SERVICE_1_PROBE_URL`, `SERVICE_1_LABEL`, then `SERVICE_2_*` and so on through `SERVICE_5_*`. A slot is included only when all four vars are set. The loader (`src/lib/servicesConfig.ts`) reads them once at startup; service status (`/api/services/status`) and service control (`/api/services/control`) consume the loaded list. The client UI (`ServerBay.tsx`) fetches the service list via `/api/services/list` and renders dynamically — no hardcoded service identities anywhere in source.

Find any references to specific service names in CLAUDE.md (`comfy-illustrator`, etc.) and replace with generic placeholders or remove if the section is purely illustrative.

In `.env.example`, the `Services` section is the canonical reference for the slot pattern. The CLAUDE.md description is a pointer to it.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
