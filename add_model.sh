#!/usr/bin/env bash
#set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
VM_USER="charlie"
VM_IP="100.96.99.94"
SSH_KEY="$HOME/.ssh/a100-key.pem"
NEXT_API_URL="http://127.0.0.1:3001/api/models/register"

# Load CIVITAI_TOKEN from .env (must be in the same directory as this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env not found at $ENV_FILE" >&2
  echo "Add CIVITAI_TOKEN=<your-token> to .env and try again." >&2
  exit 1
fi

# grep/cut/tr reads CIVITAI_TOKEN without sourcing .env (avoids executing arbitrary shell)
# Handles plain, "double-quoted", and 'single-quoted' values
CIVIT_TOKEN=$(grep -E '^CIVITAI_TOKEN=' "$ENV_FILE" | head -n1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")

if [ -z "$CIVIT_TOKEN" ]; then
  echo "Error: CIVITAI_TOKEN not set in $ENV_FILE" >&2
  exit 1
fi

# ── Arguments ─────────────────────────────────────────────────────────────────
if [ $# -ne 1 ]; then
  echo "Usage: $0 <QUEUE_FILE>"
  echo ""
  echo "  QUEUE_FILE  Path to a pipe-delimited text file."
  echo "              Format: TYPE|MODEL_ID|PARENT_URL_ID"
  echo "              Blank lines, lines starting with #, and the header row are ignored."
  echo ""
  echo "  Example queue.txt:"
  echo "    TYPE|MODEL_ID|PARENT_URL_ID"
  echo "    lora|1234567|111111"
  echo "    checkpoint|9876543|222222"
  exit 1
fi

QUEUE_FILE="$1"

if [ ! -f "$QUEUE_FILE" ]; then
  echo "Error: file not found: $QUEUE_FILE" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed (sudo apt install jq)" >&2
  exit 1
fi

# ── Helper: trim leading/trailing whitespace ───────────────────────────────────
trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# ── Process queue ──────────────────────────────────────────────────────────────
LINE_NUM=0
SUCCESS=0
FAIL=0

while IFS= read -r RAW_LINE || [ -n "$RAW_LINE" ]; do
  LINE_NUM=$(( LINE_NUM + 1 ))

  LINE=$(trim "$RAW_LINE")

  # Skip blank lines, comments, and the header row
  [[ -z "$LINE" || "$LINE" == \#* ]] && continue
  [[ "${LINE%%|*}" == "TYPE" ]] && continue

  # Parse 3 pipe-delimited fields
  IFS='|' read -r F_TYPE F_MODEL_ID F_PARENT_URL_ID <<< "$LINE"

  TYPE=$(trim "$F_TYPE")
  MODEL_ID=$(trim "$F_MODEL_ID")
  PARENT_URL_ID=$(trim "$F_PARENT_URL_ID")

  # Validate
  if [ "$TYPE" != "lora" ] && [ "$TYPE" != "checkpoint" ]; then
    echo "[line $LINE_NUM] SKIP — TYPE must be 'lora' or 'checkpoint', got: '$TYPE'" >&2
    FAIL=$(( FAIL + 1 ))
    continue
  fi

  if ! [[ "$MODEL_ID" =~ ^[0-9]+$ ]]; then
    echo "[line $LINE_NUM] SKIP — MODEL_ID must be numeric, got: '$MODEL_ID'" >&2
    FAIL=$(( FAIL + 1 ))
    continue
  fi

  if ! [[ "$PARENT_URL_ID" =~ ^[0-9]+$ ]]; then
    echo "[line $LINE_NUM] SKIP — PARENT_URL_ID must be numeric, got: '$PARENT_URL_ID'" >&2
    FAIL=$(( FAIL + 1 ))
    continue
  fi

  echo ""
  echo "── [$TYPE] model version $MODEL_ID ───────────────────────────────────────"

  # Fetch metadata from CivitAI via the Azure VM (not geoblocked)
  echo "   ==> Fetching metadata from CivitAI via Azure proxy …"
  CIVIT_META=$(ssh -n -i "$SSH_KEY" \
      -o StrictHostKeyChecking=no \
      -o BatchMode=yes \
      "$VM_USER@$VM_IP" \
      "curl -4 -s -H 'Authorization: Bearer $CIVIT_TOKEN' 'https://civitai.com/api/v1/model-versions/$MODEL_ID'")

  # Validate: require a proper model-version object, not a JSON error response
  if ! echo "$CIVIT_META" | jq -e '
      type == "object"
      and (.id | type == "number")
      and (.model | type == "object")
      and (.model.name | type == "string")
    ' &>/dev/null; then
    echo "[line $LINE_NUM] SKIP — CivitAI response is not a valid model-version object" >&2
    echo "   raw response: ${CIVIT_META:0:200}" >&2
    FAIL=$(( FAIL + 1 ))
    continue
  fi

  FRIENDLY_NAME=$(echo "$CIVIT_META" | jq -r '.model.name // .name // "unknown"')
  echo "   name     : $FRIENDLY_NAME"

  # Generate obfuscated filename
  RANDOM_STEM=$(openssl rand -hex 6)
  RANDOM_FILENAME="${RANDOM_STEM}.safetensors"

  if [ "$TYPE" = "lora" ]; then
    REMOTE_PATH="/models/ComfyUI/models/loras/$RANDOM_FILENAME"
  else
    REMOTE_PATH="/models/ComfyUI/models/checkpoints/$RANDOM_FILENAME"
  fi

  echo "   filename : $RANDOM_FILENAME"
  echo "   remote   : $VM_IP:$REMOTE_PATH"

  # Download to Azure VM
  echo "   ==> Downloading …"
  if ! ssh -n -i "$SSH_KEY" \
          -o StrictHostKeyChecking=no \
          -o BatchMode=yes \
          "$VM_USER@$VM_IP" \
          "wget -q --show-progress --progress=bar:force:noscroll \
            \"https://civitai.red/api/download/models/$MODEL_ID?token=$CIVIT_TOKEN\" \
            -O \"$REMOTE_PATH\""; then
    # wget may leave a 0-byte ghost file; remove it so ComfyUI doesn't scan it
    ssh -n -i "$SSH_KEY" -o StrictHostKeyChecking=no -o BatchMode=yes \
        "$VM_USER@$VM_IP" "rm -f \"$REMOTE_PATH\"" 2>/dev/null || true
    echo "[line $LINE_NUM] SKIP — wget failed (network, auth, or disk error)" >&2
    FAIL=$(( FAIL + 1 ))
    continue
  fi

  # Validate the downloaded file is a real model, not an error page
  echo "   ==> Validating download …"
  FILE_SIZE=$(ssh -n -i "$SSH_KEY" \
      -o StrictHostKeyChecking=no \
      -o BatchMode=yes \
      "$VM_USER@$VM_IP" \
      "stat -c %s \"$REMOTE_PATH\" 2>/dev/null || echo 0")

  FILE_SIZE=$(trim "$FILE_SIZE")
  if ! [[ "$FILE_SIZE" =~ ^[0-9]+$ ]]; then
    FILE_SIZE=0
  fi

  MIN_SIZE=$((1024 * 1024))   # 1 MB
  if [ "$FILE_SIZE" -lt "$MIN_SIZE" ]; then
    # Remove the ghost file so ComfyUI doesn't see a corrupt/empty entry
    ssh -n -i "$SSH_KEY" -o StrictHostKeyChecking=no -o BatchMode=yes \
        "$VM_USER@$VM_IP" "rm -f \"$REMOTE_PATH\"" 2>/dev/null || true
    echo "[line $LINE_NUM] SKIP — downloaded file is suspiciously small (${FILE_SIZE} bytes); likely an error page" >&2
    FAIL=$(( FAIL + 1 ))
    continue
  fi

  echo "   size     : $FILE_SIZE bytes"

  # Register metadata in local DB
  echo "   ==> Registering metadata …"
  PAYLOAD=$(echo "$CIVIT_META" | jq -c \
    --arg filename       "$RANDOM_FILENAME" \
    --arg type           "$TYPE" \
    --arg sourceHostname "civitai.red" \
    --argjson modelId     "$MODEL_ID" \
    --argjson parentUrlId "$PARENT_URL_ID" \
    '{filename: $filename, type: $type, modelId: $modelId, parentUrlId: $parentUrlId, sourceHostname: $sourceHostname, civitaiMetadata: .}')

  if ! RESPONSE=$(echo "$PAYLOAD" | curl -sf -X POST "$NEXT_API_URL" \
    -H "Content-Type: application/json" \
    --data-binary @-); then
    echo "[line $LINE_NUM] SKIP — registration POST to $NEXT_API_URL failed" >&2
    echo "   Note: model file is on the VM at $REMOTE_PATH but no DB entry was created." >&2
    FAIL=$(( FAIL + 1 ))
    continue
  fi

  echo "   ==> Registered: $RESPONSE"
  SUCCESS=$(( SUCCESS + 1 ))

done < "$QUEUE_FILE"

echo ""
echo "════════════════════════════════════════"
echo "  Done. $SUCCESS succeeded, $FAIL failed."
echo "  Model registered successfully and UI updated!"
echo "════════════════════════════════════════"
