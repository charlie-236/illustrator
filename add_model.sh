#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
VM_USER="charlie"
VM_IP="100.96.99.94"
SSH_KEY="$HOME/.ssh/a100-key.pem"
NEXT_API_URL="http://127.0.0.1:3001/api/models/register"

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
  CIVIT_META=$(ssh -i "$SSH_KEY" \
      -o StrictHostKeyChecking=no \
      -o BatchMode=yes \
      "$VM_USER@$VM_IP" \
      "curl -4 -s -H 'Authorization: Bearer $CIVIT_TOKEN' 'https://civitai.com/api/v1/model-versions/$MODEL_ID'")

  # Sanity-check: confirm we got a JSON object, not an error page
  if ! echo "$CIVIT_META" | jq -e 'type == "object"' &>/dev/null; then
    echo "[line $LINE_NUM] SKIP — CivitAI metadata fetch failed or returned non-JSON" >&2
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
  ssh -i "$SSH_KEY" \
      -o StrictHostKeyChecking=no \
      -o BatchMode=yes \
      "$VM_USER@$VM_IP" \
      "wget -q --show-progress --progress=bar:force:noscroll \
        \"https://civitai.red/api/download/models/$MODEL_ID?token=$CIVIT_TOKEN\" \
        -O \"$REMOTE_PATH\""

  # Register metadata in local DB
  echo "   ==> Registering metadata …"
  PAYLOAD=$(echo "$CIVIT_META" | jq -c \
    --arg filename    "$RANDOM_FILENAME" \
    --arg type        "$TYPE" \
    --argjson modelId     "$MODEL_ID" \
    --argjson parentUrlId "$PARENT_URL_ID" \
    '{filename: $filename, type: $type, modelId: $modelId, parentUrlId: $parentUrlId, civitaiMetadata: .}')

  RESPONSE=$(curl -sf -X POST "$NEXT_API_URL" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")

  echo "   ==> Registered: $RESPONSE"
  SUCCESS=$(( SUCCESS + 1 ))

done < "$QUEUE_FILE"

echo ""
echo "════════════════════════════════════════"
echo "  Done. $SUCCESS succeeded, $FAIL failed."
echo "  Model registered successfully and UI updated!"
echo "════════════════════════════════════════"
