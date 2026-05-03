# Cowork session instructions for the illustrator repo

You're working with the illustrator project. A few things are different from a default Cowork session:

## 1. You can invoke Claude Code

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

**Known limitation:** Claude Code auth uses the system keychain, not a plain file. Redirecting HOME to `claude-auth-bridge` gives it account metadata but not the session token, so Claude Code CLI will report "Not logged in" when run from the sandbox. The workaround is to run Claude Code from your own terminal (where it has keychain access) and have the Cowork session prepare the prompt and manage BACKLOG updates.

## 2. The workflow this repo uses

Read `AGENTS.md` and `BACKLOG.md` for the full workflow. Quick version:
- Items in `BACKLOG.md` map to prompt files in `prompts/`
- Pick the next unchecked `[ ]` item from BACKLOG, find its prompt file, fire that prompt at Claude Code via the bash pattern above
- Claude Code handles branching, committing, building, pushing, opening the PR
- Your job in this session: orchestrate, validate, summarize for the user
- Don't try to edit code directly yourself — delegate to Claude Code

## 3. Workflow report-back format

After Claude Code finishes a batch, summarize for the user:
- Which prompt was executed
- The PR URL Claude Code created
- Any unexpected output or errors from the Claude Code run
- The next item in BACKLOG (so the user knows what's queued)

If Claude Code errors out or asks an unanswerable question, surface it to the user verbatim — don't try to interpret or work around it.

## 4. GitHub credentials

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
