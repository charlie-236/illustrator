# Quick fix — env var split + hardware-neutral renames

Two small changes, both env-var-only. No schema changes, no behavioral changes, no UI changes.

1. **Split `LLM_ENDPOINT` into per-feature endpoints.** Polish and storyboard get their own endpoint variables (`POLISH_LLM_ENDPOINT`, `STORYBOARD_LLM_ENDPOINT`). Today they share `LLM_ENDPOINT`; this assumes coupling that doesn't need to exist. Going forward, the two features can theoretically point at completely different LLM tunnels — different ports, different machines, different model servers — without one's configuration affecting the other.

2. **Remove hardware-specific names from env vars.** `A100_*` becomes generic. Today the SSH credentials carry the GPU model in their name; this is incidental detail that doesn't belong in env var keys. New names: `GPU_VM_USER`, `GPU_VM_IP`, `GPU_VM_SSH_KEY_PATH`. (The codebase already uses neutral terms in adjacent vars like `COMFYUI_MODELS_ROOT` — this brings the SSH credentials in line.)

Re-read CLAUDE.md before starting. Disk-avoidance is unaffected — this batch doesn't touch the workflow build path, finalize, or WS capture.

---

## Required changes

### Part 1 — Polish route reads its own endpoint var

`src/app/api/generate/polish/route.ts` — find:

```ts
const endpoint = process.env.LLM_ENDPOINT;
const model = process.env.POLISH_LLM_MODEL;
if (!endpoint || !model) {
  throw new Error("LLM_ENDPOINT or POLISH_LLM_MODEL not set");
}
```

Replace with:

```ts
const endpoint = process.env.POLISH_LLM_ENDPOINT;
const model = process.env.POLISH_LLM_MODEL;
if (!endpoint || !model) {
  throw new Error("POLISH_LLM_ENDPOINT or POLISH_LLM_MODEL not set");
}
```

### Part 2 — Storyboard route reads its own endpoint var

`src/app/api/storyboard/generate/route.ts` — Phase 5a wired this to `process.env.LLM_ENDPOINT`. Update to `process.env.STORYBOARD_LLM_ENDPOINT`. Mirror the same shape change as Part 1: rename in the read, rename in the error message.

If 5a hasn't landed yet at the time this batch runs, the change still applies — the agent ensures the storyboard route reads `STORYBOARD_LLM_ENDPOINT` regardless of who introduced the file.

### Part 3 — Rename SSH credential vars

The current vars are `A100_VM_USER`, `A100_VM_IP`, `A100_SSH_KEY_PATH`. Rename to:

- `A100_VM_USER` → `GPU_VM_USER`
- `A100_VM_IP` → `GPU_VM_IP`
- `A100_SSH_KEY_PATH` → `GPU_VM_SSH_KEY_PATH`

Files that read these env vars (verify with `grep -rn "A100_" src/`):

- `src/lib/civitaiIngest.ts` — top-of-file reads + the validation check inside `ingestModel`.
- `src/app/api/models/[id]/route.ts` — top-of-file reads + DELETE handler validation checks.
- `src/app/api/services/control/route.ts` — top-of-file reads + POST handler validation checks.
- `src/app/api/services/status/route.ts` — top-of-file reads + GET handler validation checks.

In each file, every reference (variable read AND error message) updates to the new name. The error messages currently say things like `"A100_SSH_KEY_PATH not configured"` — those become `"GPU_VM_SSH_KEY_PATH not configured"` etc. The error-message rename matters because operators reading server logs need the message to match the env var they're setting.

After the source pass, `grep -rn "A100_" src/` should return nothing.

### Part 4 — Update `.env.example`

Update the variable definitions to the new names. The "A100 VM SSH credentials" section header also drops the hardware reference — rename the section to "GPU VM SSH credentials".

The polish section adds a new `POLISH_LLM_ENDPOINT` variable (replacing the old shared `LLM_ENDPOINT`). The storyboard section adds `STORYBOARD_LLM_ENDPOINT`. Remove the old shared `LLM_ENDPOINT` definition entirely.

Final shape for the relevant sections:

```
# ── GPU VM SSH credentials ────────────────────────────────────────────────────
# All three are required for any SSH-using route (model ingest, model delete,
# video SSH cleanup, service control). Routes return 500 if any are missing.

# SSH username for the GPU VM.
GPU_VM_USER=username

# Reachable IP of the GPU VM. Never contact this directly from Next.js —
# use the localhost SSH tunnels instead. This is only used for SSH commands.
GPU_VM_IP=xxx.xxx.xxx.xxx

# Absolute path to the private key used to SSH into the GPU VM.
GPU_VM_SSH_KEY_PATH=path-to-key
```

```
# ── LLM / Prompt Polish ───────────────────────────────────────────────────────

# OpenAI-compatible chat-completions endpoint for prompt polish.
# Reached via SSH tunnel on localhost (llama-server or compatible).
# Independent from the storyboard endpoint — they may point at the same tunnel
# or completely different tunnels / machines / models.
# Required when the Polish button is used; returns 200 with polished:false
# (graceful degradation) if unset or unreachable.
POLISH_LLM_ENDPOINT=http://127.0.0.1:11438/v1/chat/completions

# Model identifier passed to the LLM as the `model` field.
# For llama-server this is typically the .gguf file path.
POLISH_LLM_MODEL=/path/to/your/model.gguf

# (existing POLISH_TIMEOUT_MS, POLISH_TEMPERATURE, etc. — unchanged)
```

```
# ── LLM / Storyboard Generation ───────────────────────────────────────────────

# OpenAI-compatible chat-completions endpoint for storyboard generation.
# Independent from the polish endpoint — they may point at the same tunnel
# or completely different ones. Useful when storyboards want a different
# (often larger / more capable) model than prompt polish.
# Required when storyboards are generated; returns ok:false / reason:llm_error
# if unset or unreachable.
STORYBOARD_LLM_ENDPOINT=http://127.0.0.1:11438/v1/chat/completions

# Model identifier for storyboard requests.
# Can match POLISH_LLM_MODEL or differ.
STORYBOARD_LLM_MODEL=/path/to/your/model.gguf

# (existing STORYBOARD_TIMEOUT_MS, STORYBOARD_TEMPERATURE, etc. — unchanged)
```

Both default endpoint values point at the same localhost:11438 tunnel — that mirrors current behavior for users who don't change anything. Users who want full separation set them to different tunnels.

### Part 5 — Update CLAUDE.md

Three things to update:

**1. The schema/env doc block** — wherever CLAUDE.md describes the env vars (search for `A100_VM_USER` and `LLM_ENDPOINT`), update to the new names. The "SSH-related vars (`A100_*`, `A100_SSH_KEY_PATH`)" sentence becomes "SSH-related vars (`GPU_VM_*`)".

**2. The polish API description** (`POST /api/generate/polish`) — update the line "Calls `LLM_ENDPOINT`..." to "Calls `POLISH_LLM_ENDPOINT`...".

**3. The Phase 5a storyboard description** (if landed) — update similarly.

Also: **drop the hardware-specific Infrastructure section content** that names the GPU model and pastes the Tailscale IP. Replace:

```markdown
| Machine | Role |
|---------|------|
| `mint-pc` | Local Linux desktop. Hosts Next.js (port 3001), PostgreSQL, and the PM2 SSH tunnel. Reachable from the tablet over Wi-Fi. |
| `a100-core` | Azure VM, 4× A100 GPUs. Runs ComfyUI on port 8188. Bound to Tailscale only — no public internet exposure. Tailscale IP: `100.96.99.94`. |
```

With:

```markdown
| Machine | Role |
|---------|------|
| `mint-pc` | Local Linux desktop. Hosts Next.js (port 3001), PostgreSQL, and the PM2 SSH tunnel. Reachable from the tablet over Wi-Fi. |
| `gpu-vm` | Remote VM running ComfyUI on port 8188. Reached only via the local SSH tunnel — never contacted directly from Next.js. |
```

Drop the SSH tunnel command's specific username + IP. Replace with placeholder shape:

```bash
ssh -N -L 0.0.0.0:8188:<gpu-vm-ip>:8188 <user>@<gpu-vm-ip>
```

Also drop the literal Tailscale IP from the source layout description in `civitaiIngest.ts`'s entry — change "SSH-driven CivitAI metadata fetch + download to A100 VM" to "SSH-driven CivitAI metadata fetch + download to the GPU VM".

`grep -n "A100\|a100\|100.96.99.94" CLAUDE.md` should return nothing after this.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -rn "A100_" src/` returns nothing.
- `grep -rn "LLM_ENDPOINT" src/` returns only `POLISH_LLM_ENDPOINT` and `STORYBOARD_LLM_ENDPOINT` matches — no bare `LLM_ENDPOINT`.
- `grep -n "A100\|a100\|100.96.99.94" CLAUDE.md` returns nothing.
- `grep -n "A100\|a100" .env.example` returns nothing.
- `grep -n "POLISH_LLM_ENDPOINT\|STORYBOARD_LLM_ENDPOINT" .env.example` returns matches for both.
- `grep -n "GPU_VM_USER\|GPU_VM_IP\|GPU_VM_SSH_KEY_PATH" .env.example` returns matches for all three.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet, post-deploy):

1. **Update `.env`.** Rename existing local `A100_VM_USER` → `GPU_VM_USER`, `A100_VM_IP` → `GPU_VM_IP`, `A100_SSH_KEY_PATH` → `GPU_VM_SSH_KEY_PATH`. Rename `LLM_ENDPOINT` → `POLISH_LLM_ENDPOINT` (keep value). Add new `STORYBOARD_LLM_ENDPOINT` line with the same value (or different, as desired). Restart Next.js (`pm2 restart illustrator`).
2. **SSH-using routes work.** Trigger model ingest from the Models tab. Confirm completion (route uses GPU_VM_* SSH credentials).
3. **Polish works.** Open Studio image mode. Type a prompt. Tap Polish. Confirm successful expansion (route reads `POLISH_LLM_ENDPOINT`).
4. **Storyboard works.** Open a project. Tap "Plan with AI". Generate a storyboard. Confirm scenes render (route reads `STORYBOARD_LLM_ENDPOINT`).
5. **Independence test.** Set `POLISH_LLM_ENDPOINT` to an invalid URL (e.g., `http://127.0.0.1:99999/v1/chat/completions`). Restart. Confirm: Polish fails gracefully with `polished:false`; **storyboard generation still works** (uses its own var). Restore.
6. **Reverse independence test.** Set `STORYBOARD_LLM_ENDPOINT` to an invalid URL. Restart. Confirm: storyboard fails gracefully; **Polish still works**. Restore.
7. **Old env vars not silently used.** Add an unused `LLM_ENDPOINT=http://example-bogus/` to `.env`. Restart. Confirm both polish and storyboard use the new vars (the bogus value is ignored — no fallback to the old name). Remove.
8. **Service control still works.** Open Admin tab, toggle a service. Confirm SSH commands run (uses GPU_VM_* credentials).
9. **Disk-avoidance regression check.** Generate an image. Confirm `ssh <gpu-vm> ls /models/ComfyUI/output/*.png 2>&1` returns "no such file or directory" (no orphans). Workflow contract unchanged.

---

## Out of scope

- Any code path beyond the env var read site changes. Behavior is identical pre/post.
- Renaming the SSH tunnel itself or the underlying network setup. The tunnel keeps working with whatever name the operator gives it.
- A migration script for existing operators' `.env` files. Operators rename manually per smoke test step 1.
- Backwards-compatible fallback (e.g., reading `A100_VM_USER` if `GPU_VM_USER` isn't set). Clean break — old names ignored, missing new names fail closed.
- Changing the LLM call shape, sampling params, or system prompts.
- Touching the polisher's retry logic or graceful-degradation behavior.
- Changing default values for any env var.
- Changes to AGENTS.md or other docs beyond CLAUDE.md updates.

---

## Documentation

CLAUDE.md updates per Part 5 above. No additional docs needed.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
