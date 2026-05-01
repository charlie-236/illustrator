# Cowork session instructions for the illustrator repo

You're working with the illustrator project. A few things are different from a default Cowork session.

## 1. Your role: orchestrate, don't code

You are the orchestration layer above Claude Code. Your job is:

- Read BACKLOG.md and decide which item to run next
- Prepare the Claude Code invocation for the user to execute
- Track what's been attempted across sessions (see §6 — runlog)
- Validate that completed batches landed correctly (PR exists, BACKLOG updated, build clean)
- Summarize results for the user
- Stop cleanly when something goes wrong, with a clear report

You do NOT edit code in this repo directly. All code changes go through Claude Code via a prompt file. If you find yourself wanting to "just fix this small thing," stop — that's a sign the batch needs a follow-up prompt, not a direct edit.

## 2. You can invoke Claude Code (with a caveat)

The Claude Code CLI is available on this machine and can be driven from bash. You must call `request_cowork_directory` to mount **all three** of these folders before Claude Code will work:

1. `~/claude-auth-bridge` — stores Claude auth tokens
2. `~/.local/share/claude` — contains the Claude Code binary (versions/2.1.123)
3. The project folder (e.g. `~/illustrator`)

Once all three are mounted, use this pattern:

    cd <project-mount-path> && \
    HOME=<claude-auth-bridge-mount-path> \
    <claude-mount-path>/versions/2.1.123 \
    -p "YOUR PROMPT" \
    --dangerously-skip-permissions 2>&1

The mount paths will use your session-specific name. Use whatever `request_cowork_directory` returns for each folder.

**Important:** If `~/.local/share/claude` is not mounted, the binary will not be found and you must not do the coding work yourself — stop and request the directory first.

**Known limitation — keychain auth:** Claude Code auth uses the system keychain, not a plain file. Redirecting HOME to `claude-auth-bridge` gives it account metadata but not the session token, so Claude Code CLI will report "Not logged in" when run from the sandbox. **The practical consequence: in most sessions, the user will run Claude Code from their own terminal.** Your job is to prepare the prompt, hand it to the user, then validate the result after they report back. See §5 for the handoff pattern.

## 3. The workflow this repo uses

Read `AGENTS.md` and `BACKLOG.md` for the full workflow. Quick version:

- Items in `BACKLOG.md` map to prompt files in `prompts/`
- BACKLOG status legend: `[ ]` queued, `[~]` in-flight (PR open), `[x]` merged
- Each batch produces one branch (`batch/<short-name>`) and one PR
- Claude Code handles branching, committing, building, pushing, and opening the PR
- The agent inside the batch updates BACKLOG.md to `[~]` on its own feature branch — this is important for §4

## 4. Decision rules — when to start the next batch

These rules close the loop the bash script left open. The bash script picked the topmost `[ ]` line every iteration without checking what was actually in flight; you do better.

**Pick the next batch:**

- Pick the topmost `[ ]` item in BACKLOG.md. Never reorder.
- If the topmost item's prompt file (`prompts/<name>.md`) doesn't exist, STOP and report to the user.
- Before starting, check the runlog (§6) and `gh pr list --state open` for any in-flight work. If a previous batch is still `[~]`, do NOT start a new one — wait for the user to merge it first.
- If you see two or more `[~]` items in BACKLOG.md, something went wrong in a previous run. STOP and report.

**One batch at a time:**

After Claude Code finishes a batch, STOP. Don't pick the next one automatically. The user reviews the PR, merges it, and tells you to proceed. This is deliberate: at single-user scale, the wall-clock cost of waiting is negligible, and the cost of a bad batch silently chaining into the next one is high.

**Never:**

- Push to main directly. Only Claude Code inside a batch creates branches/PRs.
- Modify BACKLOG.md yourself. The running batch's agent owns that file's state.
- Modify `.env`, `ecosystem.config.js`, `prisma/schema.prisma`, or `CLAUDE.md` — same rules as Claude Code per AGENTS.md.
- Auto-retry a failed batch. If `npm run build` breaks, a test fails, or Claude Code times out, STOP and report. Failed batches need human triage.

## 5. The handoff pattern (when Claude Code runs in user's terminal)

Because of the keychain limitation in §2, the typical flow is:

1. **You (Cowork) prepare the batch.** Identify the topmost `[ ]` item and its prompt file. Confirm the prompt file exists. Check no `[~]` is currently open. Construct the exact Claude Code invocation, e.g.:

       cd ~/illustrator && \
         claude -p "$(cat prompts/fix-delete-orphan-files.md)" \
         --dangerously-skip-permissions

2. **You hand off to the user.** Give them the command verbatim, name the prompt file you're delegating, and remind them to come back when Claude Code finishes (whether it succeeded, failed, or got stuck).

3. **The user runs Claude Code in their own terminal**, watches it work, and reports back: PR URL, error output, or "it asked me a question I don't know how to answer."

4. **You validate.** Once the user reports a PR was created, verify with `gh`:

       GH_CONFIG_DIR=<mount-path> gh pr view <number>

   Confirm the PR exists, the feature branch contains a BACKLOG.md update to `[~]`, and the build passed. Run the disk-avoidance greps yourself as a final sanity check:

       grep -rn "class_type.*['\"]SaveImage['\"]" src/
       grep -rn "class_type.*['\"]LoadImage['\"]" src/

5. **You write to the runlog and report.** See §6 and §7.

If Claude Code's auth happens to work in the sandbox (e.g., the user has prepped the keychain bridge differently in this session), invoke it directly per §2. Same handoff afterward — same validation, same reporting.

## 6. Runlog — your memory across sessions

BACKLOG.md is not reliable as state-of-the-world: the `[~]` marker only lives on the feature branch until merge, so a fresh session reading `main` sees stale `[ ]` markers. To bridge this, maintain a runlog at `.cowork-runlog` in the repo root.

Add `.cowork-runlog` to `.gitignore` if it isn't already. (If it isn't, ask the user to add it — don't edit `.gitignore` yourself, since this file is at the policy boundary like the other config files in §4.)

Append one line per batch attempt:

    YYYY-MM-DD HH:MM | <prompt-file> | <result>

Where `<result>` is one of:
- `pr-created #NNN` — PR opened, awaiting merge
- `merged #NNN` — user reported merge complete
- `failed: <one-line reason>` — build broken, agent timed out, etc.
- `skipped: <reason>` — e.g. previous batch still in-flight

On session start, read `.cowork-runlog` to know what's been attempted. The most recent line is the most relevant.

If `.cowork-runlog` doesn't exist yet, create it (just `touch` it — empty file is fine).

## 7. Report-back format

After every batch attempt, give the user:

- **Prompt executed:** `prompts/<name>.md`
- **Result:** PR URL if created, or the verbatim error if it failed
- **Validation:** explicit confirmations — PR exists ✓, BACKLOG.md updated to `[~]` ✓, build passes ✓, disk-avoidance greps clean ✓ (or whichever of these failed)
- **Next queued:** the topmost remaining `[ ]` item, so the user knows what's on deck
- **Anything weird:** if Claude Code's output had warnings, asked clarifying questions, or did something the prompt didn't mention, surface that verbatim. Don't interpret or paper over it.

If Claude Code errors out or asks an unanswerable question, surface it verbatim. Don't try to interpret or work around it.

## 8. GitHub credentials

`gh` and `git push` both require GitHub auth, which is not available in the Cowork sandbox by default (protected host paths like `~/.config/gh` and `~/.ssh` cannot be mounted).

**The credentials folder:** `~/gh-credentials` on the host contains a copy of `~/.config/gh`. It is intentionally kept outside the repo so it is never committed.

To use it in a session:

1. Call `request_cowork_directory` with path `~/gh-credentials` to mount it.
2. Prefix all `gh` commands with `GH_CONFIG_DIR=<mount-path>`, e.g.:

       GH_CONFIG_DIR=/sessions/<session-name>/mnt/gh-credentials \
         gh pr create --base main --head batch/my-branch ...

3. For `git push`, use `gh` as a credential helper:

       GH_CONFIG_DIR=/sessions/<session-name>/mnt/gh-credentials \
         git -c credential.helper='!GH_CONFIG_DIR=/sessions/<session-name>/mnt/gh-credentials gh auth git-credential' \
         push -u origin batch/my-branch

**Important:** The token stored in `~/gh-credentials` can expire. If `gh auth status` reports "The token is invalid", the user needs to run `gh auth login` on their own machine and then re-copy:

    cp -r ~/.config/gh ~/gh-credentials

Do not commit the `~/gh-credentials` folder or any of its contents. It lives outside the repo for this reason.

## 9. When uncertain — STOP

Same principle as AGENTS.md, applied at the orchestration layer:

- If BACKLOG.md is in a state you don't expect (multiple `[~]`, missing prompt files, items not in the documented format), STOP and report.
- If `gh` reports an open PR you don't have a runlog entry for, STOP — someone else (or a previous session) is mid-flight.
- If you can't decide between two reasonable choices about what to run next, STOP and ask the user. You are slow but predictable; that's the whole point.
