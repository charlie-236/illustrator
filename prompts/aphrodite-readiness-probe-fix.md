# Batch — Aphrodite readiness probe fix

PR #12's status route uses `/v1/models` to probe the Aphrodite writer (21434) and polisher (11438). `/v1/models` returns 2xx as soon as the API server binds its port, before the model finishes loading into VRAM. Result: the Admin tab shows green for Aphrodite services that aren't actually serving inference yet — exactly the failure PR #12 was meant to fix.

The earlier prompt asserted `/v1/models` was "the canonical lightweight readiness check for Aphrodite-style servers" and forbade `/v1/completions`. Both calls were wrong for Aphrodite specifically — the metadata endpoint doesn't reflect model state, and only an endpoint that actually exercises the model does.

ComfyUI is unaffected. `/system_stats` is correct for ComfyUI because ComfyUI loads checkpoints lazily — process up == ready. Don't touch ComfyUI's probe.

---

## Empirical verification — required before any code change

Before modifying `SERVICE_CONFIG`, verify the chosen probe endpoint actually distinguishes "loading" from "ready" against a real running instance. Don't pick by analogy.

From mint-pc (where this app runs), against whichever Aphrodite service is currently up — polisher (11438) or writer (21434):

```bash
curl -i -m 5 http://127.0.0.1:11438/health
curl -i -m 5 http://127.0.0.1:11438/v1/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model_name>","prompt":"hi","max_tokens":1}'
```

Document in the PR description:
- Status code returned by `/health` against a fully-loaded service.
- Status code, latency, and response body shape from `/v1/completions max_tokens:1`.
- Whether `/health` exists at all on this Aphrodite build (some builds return 404).

If both endpoints return 2xx in the loaded state, prefer `/health` — it's lighter (no inference, microsecond latency) and conventional. Use `/v1/completions` only if `/health` doesn't exist or returns the same 2xx during model load (i.e. fails the discriminator test).

The "during model load" half of the test is the user's smoke test (restarting the polisher to verify amber appears) — out of scope for the agent's verification, since restarting Aphrodite mid-development is disruptive. The agent verifies the loaded-state behavior; the user verifies the loading-state behavior.

If verification reveals that **neither** `/health` nor `/v1/completions` discriminates correctly: stop and surface that finding in the PR description. Don't ship a probe known to be wrong. The status route would need a different approach (e.g. a model-name-specific check), and that's a separate design conversation.

---

## Required changes

### `src/app/api/services/status/route.ts`

Update `SERVICE_CONFIG` for the two Aphrodite entries. Leave `comfy-illustrator` exactly as-is.

If `/health` is the verified-correct endpoint:

```ts
'aphrodite-writer': {
  unit: 'aphrodite-writer',
  probeUrl: 'http://127.0.0.1:21434/health',
},
'aphrodite-cinematographer': {
  unit: 'aphrodite-cinematographer',
  probeUrl: 'http://127.0.0.1:11438/health',
},
```

If `/v1/completions` is required, the probe needs a body — extend the probe function to accept method + body, defaulting to GET-with-no-body so the ComfyUI call doesn't change:

```ts
type ProbeSpec = { url: string; method?: 'GET' | 'POST'; body?: string };

async function probe(spec: ProbeSpec): Promise<boolean> {
  try {
    const res = await fetch(spec.url, {
      method: spec.method ?? 'GET',
      headers: spec.body ? { 'Content-Type': 'application/json' } : undefined,
      body: spec.body,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

…and the `SERVICE_CONFIG` entries become:

```ts
'aphrodite-writer': {
  unit: 'aphrodite-writer',
  probe: { url: 'http://127.0.0.1:21434/v1/completions', method: 'POST',
           body: JSON.stringify({ model: '<model_name>', prompt: 'a', max_tokens: 1 }) },
},
```

Hardcoding the model name is acceptable — it's a probe, not user-facing. If the model name changes the user updates one place. Don't pull it from env.

The 5-second timeout stays.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- The PR description includes the curl-output evidence for whichever endpoint was chosen.
- `grep -n "/v1/models" src/app/api/services/status/route.ts` returns no matches.
- `grep -n ":8188/system_stats" src/app/api/services/status/route.ts` still matches — ComfyUI's probe is unchanged.
- The `comfy-illustrator` entry in `SERVICE_CONFIG` is byte-identical to before.
- The 5000 ms `AbortSignal.timeout` is still in place for all probes.

Manual smoke test (user, post-PR):
1. With the polisher fully loaded, hit Check Status — green.
2. Stop the polisher. Hit Check Status — red.
3. Start the polisher. Within ~2 seconds, hit Check Status — **amber** (the bug fix). Hit it again repeatedly during the load window; should stay amber until the model finishes loading.
4. After load completes (verify externally with `curl http://127.0.0.1:11438/<chosen-endpoint>` returning 200), hit Check Status — green.
5. Repeat 2–4 for the writer at 21434, assuming the tunnel is live.

If step 3 still goes green immediately, the chosen endpoint isn't a true readiness signal and the fix didn't work. File a fresh bug — don't iterate inside this PR.

---

## Out of scope

- Don't change the SSH/systemctl side of the route.
- Don't change the response shape.
- Don't change `ServerBay.tsx` — the `'ready' | 'loading' | 'inactive' | 'unknown'` union and amber-dot rendering from PR #12 are correct.
- Don't add auto-polling.
- Don't change ComfyUI's `/system_stats` probe.
- Don't add `/health` to ComfyUI's probe list as belt-and-braces. Single source of truth per service.
- Don't touch `ecosystem.config.js`.

---

## Documentation

In CLAUDE.md, find the `GET /api/services/status` section, specifically the "Probe endpoints" table. Update the writer and polisher rows to the verified endpoint. Leave the ComfyUI row alone.

Add one sentence above the table:

> Aphrodite services need an endpoint that exercises the loaded model — `/v1/models` returns 2xx as soon as the API server binds, before the model finishes loading into VRAM, so it can't be used as a readiness signal. ComfyUI loads lazily, so `/system_stats` (a process-level check) is sufficient.

When done, push and create the PR via `gh pr create` per AGENTS.md.
