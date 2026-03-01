#!/bin/bash
# ─────────────────────────────────────────────────────────────
# IPTV Watchdog – one-time cron setup
#
# Run this ONCE from Terminal to register the daily 08:00 job.
# After that, the watchdog runs automatically every morning.
#
# Usage:
#   cd /path/to/iptv_watchdog
#   bash setup_schedule.sh
# ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$SCRIPT_DIR/run_watchdog.sh"

# Make sure the runner is executable
chmod +x "$RUNNER"

# Cron line: every day at 08:00
CRON_LINE="0 8 * * * $RUNNER"

# Add only if not already present
if crontab -l 2>/dev/null | grep -qF "$RUNNER"; then
    echo "✅ Cron job already registered – nothing to do."
else
    # Append to existing crontab (or create new one)
    (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
    echo "✅ Cron job installed! The watchdog will run every day at 08:00."
fi

echo ""
echo "Your crontab:"
crontab -l
echo ""
echo "To verify or edit: run 'crontab -e' in Terminal."
echo "To remove:         run 'crontab -e' and delete the watchdog line."
echo ""
echo "What would you like to do next?"
echo "  [1] Start the web dashboard (http://localhost:8787)"
echo "  [2] Run a scan now (command line only)"
echo "  [3] Nothing – I'll do it later"
read -r CHOICE
case "$CHOICE" in
  1)
    echo ""
    echo "Starting web dashboard at http://localhost:8787 ..."
    echo "Press Ctrl+C in this terminal to stop it."
    echo ""
    # Open browser after a short delay
    (sleep 2 && open "http://localhost:8787") &
    python3 "$SCRIPT_DIR/server.py"
    ;;
  2)
    echo "Running watchdog now..."
    bash "$RUNNER"
    echo "Done. Check reports/latest.html"
    ;;
  *)
    echo "All set. Run 'python3 server.py' any time to open the dashboard."
    ;;
esac
