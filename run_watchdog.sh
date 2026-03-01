#!/bin/bash
# ─────────────────────────────────────────────────────────────
# IPTV Movie Watchdog – daily runner
# Called by cron every morning at 08:00.
# ─────────────────────────────────────────────────────────────

# Resolve this script's directory so paths work regardless of
# where cron launches it from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/watchdog.log"
PYTHON_SCRIPT="$SCRIPT_DIR/iptv_watchdog.py"

# ── Find Python 3 ────────────────────────────────────────────
PYTHON=$(command -v python3 2>/dev/null)
if [ -z "$PYTHON" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') ERROR: python3 not found." >> "$LOG_FILE"
    exit 1
fi

# ── Run the watchdog ─────────────────────────────────────────
echo "$(date '+%Y-%m-%d %H:%M:%S') Starting IPTV Watchdog..." >> "$LOG_FILE"
"$PYTHON" "$PYTHON_SCRIPT" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') Done ✓" >> "$LOG_FILE"
else
    echo "$(date '+%Y-%m-%d %H:%M:%S') FAILED (exit code $EXIT_CODE)" >> "$LOG_FILE"
fi

# Keep log trimmed to the last 500 lines
tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
