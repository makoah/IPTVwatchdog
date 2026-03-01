# 🎬 IPTV Watchdog

Scans your IPTV M3U playlist for 4K movies that match your personal wishlist and generates a daily HTML report. Comes with an optional web dashboard for managing your list and triggering scans.

---

## How it works

1. Downloads your M3U playlist from your IPTV provider
2. Filters entries that belong to 4K/UHD categories
3. Fuzzy-matches those titles against your `wishlist.csv` (handles messy IPTV naming, quality tags, year variants)
4. Outputs a styled HTML report showing what's available and what's still missing

---

## Files

| File | Purpose |
|------|---------|
| `iptv_watchdog.py` | Core engine — fetch, parse, match, generate report |
| `server.py` | Optional Flask web dashboard on port 8787 |
| `run_watchdog.sh` | Shell wrapper used by cron to run the scan |
| `setup_schedule.sh` | One-time script to register the daily cron job |
| `wishlist.csv` | Your movie wishlist (title, year, notes) |
| `config.json` | Your local config — **never committed** |
| `config.example.json` | Config template with all available options |

Reports are saved to `reports/watchdog_YYYY-MM-DD.html` and `reports/latest.html`.

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/makoah/IPTVwatchdog.git
cd IPTVwatchdog
```

### 2. Create your config

```bash
cp config.example.json config.json
```

Edit `config.json` and set your M3U URL:

```json
{
  "m3u_url": "http://your-provider.com/get.php?username=YOU&password=PASS&type=m3u_plus&output=ts"
}
```

### 3. Dependencies

Dependencies install automatically on first run (`rapidfuzz`, `requests`, `flask`). No manual `pip install` needed.

### 4. Edit your wishlist

Open `wishlist.csv` and add the movies you want to track:

```csv
title,year,notes
Dune Part Two,2024,
Oppenheimer,2023,
Inception,2010,Rewatch in 4K
```

Or use the web dashboard to manage it visually.

---

## Usage

### Option A — Command line (scan only)

```bash
python3 iptv_watchdog.py
```

Runs the scan and saves the report to `reports/`. Use `--config` to point to a config file elsewhere:

```bash
python3 iptv_watchdog.py --config /path/to/config.json
```

### Option B — Web dashboard

```bash
python3 server.py
```

Open `http://localhost:8787` in your browser. The dashboard lets you:

- Add and remove wishlist movies (with year and notes)
- Trigger a scan with the **Run Scan Now** button
- Watch live scan progress in the log panel
- View the latest report embedded inline

### Option C — Schedule via cron (automated daily runs)

Run once to register the cron job:

```bash
bash setup_schedule.sh
```

This adds a cron entry that runs the scan every day at **08:00** via `run_watchdog.sh`. Logs are written to `watchdog.log` and kept trimmed to 500 lines.

To change the schedule, edit your crontab manually:

```bash
crontab -e
```

---

## Config options

All settings in `config.json` are optional — defaults work for most providers.

| Key | Default | Description |
|-----|---------|-------------|
| `m3u_url` | *(required)* | Your IPTV M3U playlist URL |
| `category_keywords` | `["4k","uhd","2160"]` | Keywords used to identify 4K groups in the playlist |
| `category_must_include_movie` | `false` | Set `true` if your provider separates Movies from Series in group names |
| `match_threshold` | `78` | Minimum fuzzy match score (0–100). Lower = more lenient |
| `year_bonus` | `12` | Score boost when wishlist year matches catalog year |
| `year_penalty` | `5` | Score reduction when years differ |
| `report_open_browser` | `false` | Auto-open the report in a browser after each scan |

### Tuning match quality

- **Too many false positives** (wrong movies matching): raise `match_threshold` to 85+
- **Missing movies you know are there**: lower `match_threshold` to 70–75
- **Provider mixes Movies and Series in 4K groups**: set `category_must_include_movie: true`

---

## Running on a VPS / headless server

```bash
# Clone and configure
git clone https://github.com/makoah/IPTVwatchdog.git
cd IPTVwatchdog
cp config.example.json config.json
nano config.json   # add your M3U URL

# Run a scan manually
python3 iptv_watchdog.py

# Or schedule it
bash setup_schedule.sh

# To expose the dashboard (bind to all interfaces instead of localhost)
# Edit the last line of server.py: host="0.0.0.0"
python3 server.py
```

> **Note:** `config.json` is gitignored and must be created manually on each machine.

---

## Report scoring

Each wishlist match shows a confidence score:

| Score | Meaning |
|-------|---------|
| 90–100% | Strong match — very likely correct |
| 82–89% | Good match — worth checking |
| 78–81% | Threshold match — verify if title looks odd |

A **✓ Year** badge confirms the catalog entry's year matches your wishlist. A **⚠ year** badge means the year differs — could be a remaster, re-release, or wrong match.
