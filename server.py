#!/usr/bin/env python3
"""
IPTV Watchdog – Local Web Dashboard
=====================================
Run once:  python3 server.py
Then open: http://localhost:8787

Features:
  · Wishlist management (add / remove movies, with year & notes)
  · "Run Now" button triggers an immediate scan
  · Live status bar shows scan progress
  · Embedded latest report rendered inline
  · Auto-refreshes report when scan finishes
"""

import csv
import io
import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

# ── Auto-install Flask if missing ─────────────────────────────────────────────
try:
    from flask import Flask, jsonify, request, Response
except ImportError:
    print("Installing Flask...")
    os.system(f"{sys.executable} -m pip install flask --break-system-packages --quiet")
    from flask import Flask, jsonify, request, Response

SCRIPT_DIR   = Path(__file__).parent
WISHLIST_PATH = SCRIPT_DIR / "wishlist.csv"
REPORTS_DIR   = SCRIPT_DIR / "reports"
WATCHDOG_PY   = SCRIPT_DIR / "iptv_watchdog.py"

app = Flask(__name__)

# ── Scan state (in-memory) ────────────────────────────────────────────────────
_scan_lock   = threading.Lock()
_scan_state  = {
    "running":   False,
    "last_run":  None,     # ISO string
    "last_log":  [],       # last N lines of output
    "last_found": None,    # int: wishlist movies found
    "last_total": None,    # int: wishlist size
}


# ─── WISHLIST HELPERS ─────────────────────────────────────────────────────────
def _read_wishlist() -> list:
    if not WISHLIST_PATH.exists():
        return []
    rows = []
    with open(WISHLIST_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append({
                "title": (r.get("title") or "").strip(),
                "year":  (r.get("year")  or "").strip(),
                "notes": (r.get("notes") or "").strip(),
            })
    return [r for r in rows if r["title"]]


def _write_wishlist(rows: list):
    WISHLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(WISHLIST_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["title", "year", "notes"])
        writer.writeheader()
        writer.writerows(rows)


# ─── SCAN RUNNER ──────────────────────────────────────────────────────────────
def _run_scan_thread():
    with _scan_lock:
        if _scan_state["running"]:
            return
        _scan_state["running"] = True
        _scan_state["last_log"] = ["Starting scan…"]

    log_lines = ["Starting scan…"]
    found = None
    total = None

    try:
        proc = subprocess.Popen(
            [sys.executable, str(WATCHDOG_PY)],
            cwd=str(SCRIPT_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                log_lines.append(line)
                with _scan_lock:
                    _scan_state["last_log"] = log_lines[-60:]

                # Parse summary line: "Results: 4/8 wishlist movies found"
                if "Results:" in line and "/" in line:
                    import re
                    m = re.search(r"(\d+)/(\d+)", line)
                    if m:
                        found = int(m.group(1))
                        total = int(m.group(2))

        proc.wait()
        log_lines.append(f"Done ✓  (exit {proc.returncode})")
    except Exception as e:
        log_lines.append(f"ERROR: {e}")

    with _scan_lock:
        _scan_state["running"]    = False
        _scan_state["last_run"]   = datetime.now().isoformat(timespec="seconds")
        _scan_state["last_log"]   = log_lines[-60:]
        _scan_state["last_found"] = found
        _scan_state["last_total"] = total


# ─── API ROUTES ───────────────────────────────────────────────────────────────
@app.route("/api/wishlist", methods=["GET"])
def api_wishlist_get():
    return jsonify(_read_wishlist())


@app.route("/api/wishlist", methods=["POST"])
def api_wishlist_add():
    data  = request.get_json(force=True)
    title = (data.get("title") or "").strip()
    year  = (data.get("year")  or "").strip()
    notes = (data.get("notes") or "").strip()
    if not title:
        return jsonify({"error": "title is required"}), 400

    rows = _read_wishlist()
    if any(r["title"].lower() == title.lower() for r in rows):
        return jsonify({"error": "already in wishlist"}), 409

    rows.append({"title": title, "year": year, "notes": notes})
    _write_wishlist(rows)
    return jsonify({"ok": True, "wishlist": rows}), 201


@app.route("/api/wishlist/<path:title>", methods=["DELETE"])
def api_wishlist_delete(title):
    rows    = _read_wishlist()
    new     = [r for r in rows if r["title"].lower() != title.lower()]
    removed = len(rows) - len(new)
    if removed == 0:
        return jsonify({"error": "not found"}), 404
    _write_wishlist(new)
    return jsonify({"ok": True, "wishlist": new})


@app.route("/api/run", methods=["POST"])
def api_run():
    with _scan_lock:
        if _scan_state["running"]:
            return jsonify({"error": "scan already running"}), 409
    t = threading.Thread(target=_run_scan_thread, daemon=True)
    t.start()
    return jsonify({"ok": True, "message": "scan started"})


@app.route("/api/status", methods=["GET"])
def api_status():
    with _scan_lock:
        return jsonify({
            "running":    _scan_state["running"],
            "last_run":   _scan_state["last_run"],
            "last_log":   _scan_state["last_log"],
            "last_found": _scan_state["last_found"],
            "last_total": _scan_state["last_total"],
        })


@app.route("/report")
def serve_report():
    latest = REPORTS_DIR / "latest.html"
    if not latest.exists():
        return "<p style='font-family:sans-serif;color:#888;padding:2rem'>No report yet — run a scan first.</p>"
    return Response(latest.read_text(encoding="utf-8"), mimetype="text/html")


# ─── MAIN DASHBOARD HTML ──────────────────────────────────────────────────────
DASHBOARD_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>IPTV Watchdog</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:     #0d1117;
      --panel:  #161b22;
      --border: #30363d;
      --muted:  #8b949e;
      --text:   #c9d1d9;
      --hi:     #f0f6fc;
      --purple: #a371f7;
      --green:  #3fb950;
      --yellow: #d29922;
      --red:    #f85149;
      --blue:   #388bfd;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: var(--bg); color: var(--text); min-height: 100vh; }

    /* Layout */
    .layout { display: grid; grid-template-columns: 360px 1fr; min-height: 100vh; }
    .sidebar { background: var(--panel); border-right: 1px solid var(--border);
               display: flex; flex-direction: column; }
    .main { display: flex; flex-direction: column; }

    /* Sidebar header */
    .sidebar-header { padding: 1.25rem 1.4rem; border-bottom: 1px solid var(--border); }
    .sidebar-header h1 { font-size: 1.15rem; color: var(--hi); }
    .sidebar-header h1 em { color: var(--purple); font-style: normal; }
    .sidebar-header p  { font-size: 0.78rem; color: var(--muted); margin-top: 0.2rem; }

    /* Run button */
    .run-section { padding: 1.2rem 1.4rem; border-bottom: 1px solid var(--border); }
    #btn-run {
      width: 100%; padding: 0.7rem; font-size: 0.95rem; font-weight: 600;
      background: var(--purple); color: #fff; border: none; border-radius: 8px;
      cursor: pointer; transition: opacity .15s, transform .1s;
    }
    #btn-run:hover:not(:disabled) { opacity: .88; transform: translateY(-1px); }
    #btn-run:disabled { opacity: .45; cursor: not-allowed; transform: none; }
    #btn-run.running { background: var(--yellow); }

    /* Status strip */
    #status-strip {
      margin-top: .7rem; font-size: 0.78rem; color: var(--muted);
      min-height: 1.1rem; display: flex; align-items: center; gap: .5rem;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .dot.idle    { background: var(--muted); }
    .dot.running { background: var(--yellow); animation: pulse 1s infinite; }
    .dot.ok      { background: var(--green); }
    .dot.err     { background: var(--red); }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }

    /* Score badge */
    #score-badge {
      margin-top: .5rem; font-size: 0.82rem; color: var(--green); font-weight: 600;
      min-height: 1rem;
    }

    /* Log */
    .log-wrap { padding: 0 1.4rem .8rem; }
    #log-box {
      background: #0d111788; border: 1px solid var(--border); border-radius: 6px;
      padding: .6rem .75rem; font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.72rem; color: var(--muted); max-height: 160px;
      overflow-y: auto; white-space: pre-wrap; display: none;
    }

    /* Wishlist section */
    .wishlist-section { flex: 1; overflow-y: auto; }
    .section-title {
      padding: .8rem 1.4rem .4rem; font-size: 0.72rem; font-weight: 600;
      letter-spacing: .08em; text-transform: uppercase; color: var(--muted);
      border-bottom: 1px solid var(--border);
    }

    /* Add form */
    .add-form { padding: .9rem 1.4rem; border-bottom: 1px solid var(--border); }
    .add-form .row { display: flex; gap: .5rem; margin-bottom: .5rem; }
    .add-form input {
      flex: 1; background: var(--bg); border: 1px solid var(--border);
      border-radius: 6px; padding: .45rem .7rem; color: var(--text);
      font-size: 0.85rem; outline: none;
    }
    .add-form input:focus { border-color: var(--purple); }
    .add-form input::placeholder { color: var(--muted); }
    .add-form .inp-year  { max-width: 80px; }
    .add-form .inp-notes { }
    #btn-add {
      background: var(--purple); color: #fff; border: none; border-radius: 6px;
      padding: .45rem 1rem; font-size: 0.85rem; font-weight: 600;
      cursor: pointer; white-space: nowrap;
    }
    #btn-add:hover { opacity: .88; }
    #add-error { font-size: 0.75rem; color: var(--red); min-height: 1rem; }

    /* Movie list */
    #movie-list { list-style: none; }
    .movie-item {
      display: flex; align-items: center; gap: .6rem;
      padding: .6rem 1.4rem; border-bottom: 1px solid #1c2128;
      transition: background .1s;
    }
    .movie-item:hover { background: #0d111755; }
    .movie-title { flex: 1; font-size: 0.875rem; color: var(--hi); }
    .movie-meta  { font-size: 0.75rem; color: var(--muted); }
    .movie-year  { font-size: 0.75rem; color: var(--purple); margin-left: .35rem; }
    .movie-notes { font-size: 0.72rem; color: var(--muted); display: block; }
    .btn-remove {
      background: none; border: 1px solid transparent; border-radius: 5px;
      color: var(--muted); cursor: pointer; font-size: 1rem; line-height: 1;
      padding: .2rem .4rem; transition: color .15s, border-color .15s;
    }
    .btn-remove:hover { color: var(--red); border-color: var(--red); }

    /* Report iframe */
    .report-header {
      padding: .8rem 1.4rem; border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
    }
    .report-header h2 { font-size: 0.875rem; color: var(--muted); font-weight: 500; }
    #btn-refresh {
      background: none; border: 1px solid var(--border); border-radius: 5px;
      color: var(--muted); font-size: 0.78rem; padding: .3rem .7rem;
      cursor: pointer;
    }
    #btn-refresh:hover { border-color: var(--purple); color: var(--purple); }
    #report-frame {
      flex: 1; border: none; width: 100%; background: #0d1117;
    }

    /* Empty state */
    .empty { text-align: center; padding: 2rem; color: var(--muted); font-size: .85rem; }
  </style>
</head>
<body>
<div class="layout">

  <!-- ── SIDEBAR ─────────────────────────────────────────────── -->
  <aside class="sidebar">

    <div class="sidebar-header">
      <h1>🎬 IPTV <em>Watchdog</em></h1>
      <p>Your personal 4K movie tracker</p>
    </div>

    <div class="run-section">
      <button id="btn-run" onclick="runScan()">▶ Run Scan Now</button>
      <div id="status-strip">
        <span class="dot idle" id="status-dot"></span>
        <span id="status-text">Ready</span>
      </div>
      <div id="score-badge"></div>
    </div>

    <div class="log-wrap">
      <div id="log-box"></div>
    </div>

    <div class="section-title">Wishlist</div>

    <div class="add-form">
      <div class="row">
        <input id="inp-title" class="inp-title" type="text" placeholder="Movie title…" onkeydown="if(event.key==='Enter')addMovie()">
        <input id="inp-year"  class="inp-year"  type="text" placeholder="Year" maxlength="4" onkeydown="if(event.key==='Enter')addMovie()">
        <button id="btn-add" onclick="addMovie()">＋ Add</button>
      </div>
      <div class="row">
        <input id="inp-notes" class="inp-notes" type="text" placeholder="Notes (optional)…" onkeydown="if(event.key==='Enter')addMovie()">
      </div>
      <div id="add-error"></div>
    </div>

    <div class="wishlist-section">
      <ul id="movie-list"><li class="empty">Loading…</li></ul>
    </div>

  </aside>

  <!-- ── MAIN REPORT PANE ────────────────────────────────────── -->
  <main class="main">
    <div class="report-header">
      <h2 id="report-label">Latest scan report</h2>
      <button id="btn-refresh" onclick="refreshReport()">↺ Refresh</button>
    </div>
    <iframe id="report-frame" src="/report" title="Latest scan report"></iframe>
  </main>

</div>

<script>
  let _polling = false;

  /* ── Load wishlist ─────────────────────────────────────────── */
  async function loadWishlist() {
    const res  = await fetch('/api/wishlist');
    const rows = await res.json();
    renderList(rows);
  }

  function renderList(rows) {
    const ul = document.getElementById('movie-list');
    if (!rows.length) {
      ul.innerHTML = '<li class="empty">No movies yet — add one above.</li>';
      return;
    }
    ul.innerHTML = rows.map(r => `
      <li class="movie-item" data-title="${esc(r.title)}">
        <div style="flex:1;min-width:0">
          <span class="movie-title">${esc(r.title)}</span>
          <span class="movie-year">${r.year ? '(' + esc(r.year) + ')' : ''}</span>
          ${r.notes ? `<span class="movie-notes">${esc(r.notes)}</span>` : ''}
        </div>
        <button class="btn-remove" title="Remove" onclick="removeMovie('${esc(r.title)}')">✕</button>
      </li>`).join('');
  }

  /* ── Add movie ─────────────────────────────────────────────── */
  async function addMovie() {
    const title = document.getElementById('inp-title').value.trim();
    const year  = document.getElementById('inp-year').value.trim();
    const notes = document.getElementById('inp-notes').value.trim();
    const errEl = document.getElementById('add-error');
    errEl.textContent = '';
    if (!title) { errEl.textContent = 'Please enter a title.'; return; }

    const res  = await fetch('/api/wishlist', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({title, year, notes})
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Error adding movie.'; return; }

    document.getElementById('inp-title').value = '';
    document.getElementById('inp-year').value  = '';
    document.getElementById('inp-notes').value = '';
    renderList(data.wishlist);
    document.getElementById('inp-title').focus();
  }

  /* ── Remove movie ──────────────────────────────────────────── */
  async function removeMovie(title) {
    const res  = await fetch('/api/wishlist/' + encodeURIComponent(title), {method: 'DELETE'});
    const data = await res.json();
    if (res.ok) renderList(data.wishlist);
  }

  /* ── Run scan ──────────────────────────────────────────────── */
  async function runScan() {
    const res = await fetch('/api/run', {method: 'POST'});
    if (res.status === 409) { setStatus('running', 'Already running…'); return; }
    if (!res.ok) { setStatus('err', 'Failed to start scan.'); return; }
    setStatus('running', 'Scan running…');
    startPolling();
  }

  /* ── Poll status ───────────────────────────────────────────── */
  function startPolling() {
    if (_polling) return;
    _polling = true;
    pollOnce();
  }

  async function pollOnce() {
    try {
      const res  = await fetch('/api/status');
      const data = await res.json();

      // Update log
      if (data.last_log && data.last_log.length) {
        const box = document.getElementById('log-box');
        box.style.display = 'block';
        box.textContent = data.last_log.join('\n');
        box.scrollTop = box.scrollHeight;
      }

      if (data.running) {
        setStatus('running', 'Scanning playlist…');
        setTimeout(pollOnce, 1200);
      } else {
        _polling = false;
        if (data.last_run) {
          const ts = new Date(data.last_run).toLocaleTimeString('nl-NL');
          setStatus('ok', 'Last scan: ' + ts);
          if (data.last_found !== null) {
            document.getElementById('score-badge').textContent =
              `✅ ${data.last_found} of ${data.last_total} wishlist movies found in 4K`;
          }
          refreshReport();
        } else {
          setStatus('idle', 'Ready');
        }
      }
    } catch(e) {
      _polling = false;
      setStatus('err', 'Connection error');
      setTimeout(pollOnce, 3000);
    }
  }

  /* ── UI helpers ────────────────────────────────────────────── */
  function setStatus(type, text) {
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    const btn = document.getElementById('btn-run');
    dot.className = 'dot ' + type;
    txt.textContent = text;
    btn.disabled  = (type === 'running');
    btn.className = type === 'running' ? 'running' : '';
    btn.textContent = type === 'running' ? '⏳ Scanning…' : '▶ Run Scan Now';
  }

  function refreshReport() {
    const frame = document.getElementById('report-frame');
    const ts = new Date().toLocaleString('nl-NL', {dateStyle:'short', timeStyle:'short'});
    document.getElementById('report-label').textContent = 'Latest scan report — ' + ts;
    frame.src = '/report?t=' + Date.now();
  }

  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  /* ── Init ──────────────────────────────────────────────────── */
  loadWishlist();

  // On load, check if a scan is already running (e.g. page refresh mid-scan)
  fetch('/api/status').then(r => r.json()).then(d => {
    if (d.running) startPolling();
    if (d.last_run) {
      const ts = new Date(d.last_run).toLocaleTimeString('nl-NL');
      setStatus('ok', 'Last scan: ' + ts);
      if (d.last_found !== null)
        document.getElementById('score-badge').textContent =
          `✅ ${d.last_found} of ${d.last_total} wishlist movies found in 4K`;
    }
  });
</script>
</body>
</html>"""


@app.route("/")
def dashboard():
    return Response(DASHBOARD_HTML, mimetype="text/html")


# ─── ENTRY POINT ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = 8787
    print("=" * 52)
    print("  IPTV Watchdog – Web Dashboard")
    print(f"  http://localhost:{port}")
    print("  Press Ctrl+C to stop.")
    print("=" * 52)
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
