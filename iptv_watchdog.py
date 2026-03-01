#!/usr/bin/env python3
"""
IPTV Movie Watchdog
===================
Scans your IPTV M3U playlist for 4K movies that match your wishlist,
and generates a daily HTML report showing what's available to watch.

Usage:
    python3 iptv_watchdog.py
    python3 iptv_watchdog.py --config /path/to/config.json
"""

import csv
import re
import os
import sys
import json
import argparse
import requests
from datetime import datetime
from pathlib import Path

# ── Auto-install rapidfuzz if missing ─────────────────────────────────────────
try:
    from rapidfuzz import fuzz, process as rfprocess
except ImportError:
    print("Installing rapidfuzz...")
    os.system(f"{sys.executable} -m pip install rapidfuzz requests --break-system-packages --quiet")
    from rapidfuzz import fuzz, process as rfprocess


# ─── DEFAULTS (overridden by config.json) ─────────────────────────────────────
DEFAULTS = {
    "m3u_url": "YOUR_M3U_URL_HERE",
    "category_keywords": ["4k", "uhd", "2160"],          # Keywords to identify 4K groups
    "category_must_include_movie": False,                  # Set True if provider separates Movies/Series
    "match_threshold": 78,                                 # 0–100. 78 = good balance for messy IPTV names
    "year_bonus": 12,                                      # Score boost when wishlist year matches catalog year
    "year_penalty": 5,                                     # Penalty when years differ (avoids wrong decade match)
    "report_open_browser": False                           # Set True to auto-open report in browser
}


# ─── CONFIG LOADING ────────────────────────────────────────────────────────────
def load_config(config_path: Path) -> dict:
    cfg = DEFAULTS.copy()
    if config_path.exists():
        with open(config_path, encoding="utf-8") as f:
            user_cfg = json.load(f)
        cfg.update(user_cfg)
    else:
        print(f"WARNING: config.json not found at {config_path}. Using defaults.")
    if cfg["m3u_url"] == "YOUR_M3U_URL_HERE":
        print("ERROR: Please set your M3U URL in config.json before running.")
        sys.exit(1)
    return cfg


# ─── M3U FETCHING & PARSING ───────────────────────────────────────────────────
def fetch_m3u(url: str) -> str:
    """Download M3U playlist using streaming to handle large files (50–150 MB)."""
    print("Fetching playlist from provider...")
    headers = {"User-Agent": "VLC/3.0 (compatible; IPTV)"}
    try:
        # connect_timeout=10s, read_timeout=180s — large playlists need time to stream
        with requests.get(url, headers=headers, stream=True,
                          timeout=(10, 180)) as resp:
            resp.raise_for_status()

            chunks = []
            total  = 0
            for chunk in resp.iter_content(chunk_size=1024 * 64):
                if chunk:
                    chunks.append(chunk)
                    total += len(chunk)
                    if total % (1024 * 1024) < 1024 * 64:   # print every ~1 MB
                        print(f"  Downloading… {total // 1024:,} KB received", flush=True)

            content = b"".join(chunks).decode("utf-8", errors="replace")
            print(f"Playlist downloaded — {total / 1024:.0f} KB, "
                  f"{content.count('#EXTINF'):,} entries.")
            return content

    except requests.exceptions.ConnectTimeout:
        print("ERROR: Connection timed out — check your network or VPN.")
        sys.exit(1)
    except requests.exceptions.ReadTimeout:
        print("ERROR: Playlist download timed out after 180 s — "
              "the file may be extremely large or the server is slow.")
        sys.exit(1)
    except requests.RequestException as e:
        print(f"ERROR: Could not fetch playlist: {e}")
        sys.exit(1)


def parse_m3u(content: str) -> list:
    """Parse M3U content into a list of entry dicts."""
    entries = []
    lines = content.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith("#EXTINF"):
            entry = {}

            # group-title attribute
            g = re.search(r'group-title=["\']([^"\']*)["\']', line)
            entry["group"] = g.group(1).strip() if g else ""

            # tvg-name attribute (preferred for clean title)
            tvg = re.search(r'tvg-name=["\']([^"\']*)["\']', line)

            # Display name: text after the last comma on the EXTINF line
            comma_idx = line.rfind(",")
            display = line[comma_idx + 1:].strip() if comma_idx >= 0 else ""

            entry["title"] = (tvg.group(1).strip() if tvg else None) or display or "Unknown"

            # Stream URL on the next line
            if i + 1 < len(lines):
                next_line = lines[i + 1].strip()
                if next_line and not next_line.startswith("#"):
                    entry["url"] = next_line
                    i += 2
                else:
                    i += 1
            else:
                i += 1

            entries.append(entry)
        else:
            i += 1
    return entries


def filter_4k_movies(entries: list, cfg: dict) -> list:
    """Return only entries that belong to a 4K movie category."""
    keywords = [k.lower() for k in cfg["category_keywords"]]
    result = []
    for e in entries:
        group_lower = e.get("group", "").lower()
        is_4k = any(kw in group_lower for kw in keywords)
        if not is_4k:
            continue
        if cfg["category_must_include_movie"] and "movie" not in group_lower:
            continue
        result.append(e)
    return result


# ─── TITLE NORMALIZATION ──────────────────────────────────────────────────────
# Tags commonly found in IPTV catalog titles that should be ignored during matching
_QUALITY_TAGS = re.compile(
    r"\b(4k|uhd|fhd|hd|hdr|hdr10|hdr10\+|dolby|vision|dv|sdr|2160p|1080p|720p|480p"
    r"|bluray|blu[\s\-]?ray|bdrip|brrip|webrip|web[\s\-]dl|hdtv|dvdrip|dvd"
    r"|hevc|x265|x264|avc|h264|h265|av1|remux"
    r"|extended|directors[\s\.\_]cut|theatrical|unrated|remastered|proper|imax"
    r"|atmos|truehd|dts|aac|ac3|5\.1|7\.1"
    r"|english|french|dutch|german|spanish|arabic|hindi"
    r"|vip|premium|ott)\b",
    re.IGNORECASE
)


def clean_title(title: str) -> str:
    """Normalize a title for fuzzy comparison."""
    t = title
    # Remove years in brackets/parens
    t = re.sub(r"[\(\[\{]\s*\d{4}\s*[\)\]\}]", " ", t)
    # Remove standalone 4-digit years
    t = re.sub(r"\b(19|20)\d{2}\b", " ", t)
    # Remove quality/format tags
    t = _QUALITY_TAGS.sub(" ", t)
    # Remove any remaining non-alphanumeric characters except spaces
    t = re.sub(r"[^a-zA-Z0-9\s]", " ", t)
    # Collapse whitespace and lowercase
    return re.sub(r"\s+", " ", t).strip().lower()


def extract_year(text: str) -> str:
    """Extract the first plausible release year (1980–2030) from a string."""
    m = re.search(r"\b(19[89]\d|20[0-2]\d)\b", text)
    return m.group(0) if m else ""


# ─── WISHLIST LOADING ─────────────────────────────────────────────────────────
def load_wishlist(path: Path) -> list:
    if not path.exists():
        print(f"WARNING: Wishlist not found at {path}. Creating a sample template...")
        _create_wishlist_template(path)
        return []

    wishlist = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            title = row.get("title", "").strip()
            year  = row.get("year", "").strip()
            notes = row.get("notes", "").strip()
            if title:
                wishlist.append({
                    "title": title,
                    "year": year,
                    "notes": notes,
                    "clean": clean_title(title)
                })
    print(f"Loaded {len(wishlist)} movies from wishlist.")
    return wishlist


def _create_wishlist_template(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["title", "year", "notes"])
        writer.writerow(["Dune Part Two", "2024", ""])
        writer.writerow(["Oppenheimer", "2023", ""])
        writer.writerow(["The Batman", "2022", ""])
        writer.writerow(["Alien Romulus", "2024", ""])
        writer.writerow(["Inception", "2010", "Rewatch in 4K"])
    print(f"Template wishlist created at {path}. Edit it and re-run the script.")


# ─── MATCHING ENGINE ──────────────────────────────────────────────────────────
def match_movies(wishlist: list, catalog: list, cfg: dict) -> list:
    """Match each wishlist movie against the 4K catalog using fuzzy scoring."""
    threshold   = cfg["match_threshold"]
    year_bonus  = cfg["year_bonus"]
    year_penalty = cfg["year_penalty"]

    # Pre-clean catalog titles
    catalog_cleaned = [(clean_title(e["title"]), e) for e in catalog]
    catalog_names   = [c[0] for c in catalog_cleaned]

    results = []
    for wish in wishlist:
        # Find top 5 candidates via token_sort_ratio (handles word reordering)
        candidates = rfprocess.extract(
            wish["clean"],
            catalog_names,
            scorer=fuzz.token_sort_ratio,
            limit=5
        )

        found_matches = []
        for _, base_score, idx in candidates:
            entry = catalog_cleaned[idx][1]
            cat_year = extract_year(entry["title"])

            # Adjust score based on year alignment
            if wish["year"] and cat_year:
                if wish["year"] == cat_year:
                    score = min(base_score + year_bonus, 100)
                    year_status = "match"
                else:
                    score = max(base_score - year_penalty, 0)
                    year_status = "mismatch"
            else:
                score = base_score
                year_status = "unknown"

            if score >= threshold:
                found_matches.append({
                    "catalog_title": entry["title"],
                    "catalog_group": entry.get("group", ""),
                    "stream_url":    entry.get("url", ""),
                    "base_score":    base_score,
                    "score":         score,
                    "catalog_year":  cat_year,
                    "year_status":   year_status
                })

        # Sort by descending score, deduplicate by catalog title
        seen = set()
        unique_matches = []
        for m in sorted(found_matches, key=lambda x: -x["score"]):
            if m["catalog_title"] not in seen:
                seen.add(m["catalog_title"])
                unique_matches.append(m)

        results.append({
            "wish_title":  wish["title"],
            "wish_year":   wish["year"],
            "wish_notes":  wish.get("notes", ""),
            "matches":     unique_matches,
            "found":       len(unique_matches) > 0
        })

    return results


# ─── HTML REPORT GENERATION ───────────────────────────────────────────────────
def generate_html_report(results: list, catalog_count: int) -> str:
    found     = [r for r in results if r["found"]]
    not_found = [r for r in results if not r["found"]]
    now       = datetime.now().strftime("%d %B %Y, %H:%M")
    pct       = round(len(found) / len(results) * 100) if results else 0

    # ── Found rows ──
    found_rows = ""
    for r in found:
        best = r["matches"][0]
        score_color = "#22c55e" if best["score"] >= 90 else "#f59e0b" if best["score"] >= 82 else "#fb923c"
        year_badge = ""
        if best["year_status"] == "match":
            year_badge = '<span class="badge year-ok">✓ Year</span>'
        elif best["year_status"] == "mismatch":
            year_badge = f'<span class="badge year-miss">⚠ {best["catalog_year"] or "?"}</span>'

        alt_count = len(r["matches"]) - 1
        alt_note = f'<br><span class="alt-note">+{alt_count} other version{"s" if alt_count>1 else ""}</span>' if alt_count > 0 else ""

        wish_year_str = f' <span class="year-tag">({r["wish_year"]})</span>' if r["wish_year"] else ""
        notes_str = f'<br><span class="notes">{r["wish_notes"]}</span>' if r["wish_notes"] else ""

        found_rows += f"""
        <tr>
          <td><strong>{r['wish_title']}</strong>{wish_year_str}{notes_str}</td>
          <td class="catalog-title">{best['catalog_title']}{alt_note}</td>
          <td><span class="group-tag">{best['catalog_group']}</span></td>
          <td><span class="score-badge" style="background:{score_color}22;color:{score_color};border:1px solid {score_color}44">{best['score']}%</span></td>
          <td>{year_badge}</td>
        </tr>"""

    if not found_rows:
        found_rows = '<tr><td colspan="5" class="empty-cell">No wishlist movies found in the 4K catalogue yet. Check back tomorrow!</td></tr>'

    # ── Not-found rows ──
    not_found_rows = ""
    for r in not_found:
        wish_year_str = f'({r["wish_year"]})' if r["wish_year"] else "—"
        notes_str = r.get("wish_notes", "") or "—"
        not_found_rows += f"""
        <tr>
          <td><strong>{r['wish_title']}</strong></td>
          <td>{wish_year_str}</td>
          <td>{notes_str}</td>
          <td class="not-found-cell">Not yet in 4K catalogue</td>
        </tr>"""

    if not not_found_rows:
        not_found_rows = '<tr><td colspan="4" class="empty-cell">🎉 All wishlist movies are in the catalogue!</td></tr>'

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>IPTV Watchdog – {now}</title>
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: #0d1117; color: #c9d1d9; min-height: 100vh; padding: 2rem 1rem;
    }}
    .wrap {{ max-width: 980px; margin: 0 auto; }}

    /* Header */
    header {{ margin-bottom: 2rem; }}
    h1 {{ font-size: 1.9rem; color: #f0f6fc; letter-spacing: -0.5px; }}
    h1 em {{ color: #a371f7; font-style: normal; }}
    .meta {{ color: #8b949e; font-size: 0.875rem; margin-top: 0.35rem; }}

    /* Stat cards */
    .stats {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin-bottom: 2rem; }}
    .card {{
      background: #161b22; border: 1px solid #30363d; border-radius: 10px;
      padding: 1.1rem 1.3rem;
    }}
    .card .num {{ font-size: 2.1rem; font-weight: 700; line-height: 1; }}
    .card .lbl {{ font-size: 0.78rem; color: #8b949e; margin-top: 0.3rem; }}
    .card.green .num {{ color: #3fb950; }}
    .card.purple .num {{ color: #a371f7; }}
    .card.yellow .num {{ color: #d29922; }}

    /* Progress bar */
    .progress-wrap {{ background: #21262d; border-radius: 100px; height: 6px; margin-bottom: 2rem; overflow: hidden; }}
    .progress-bar {{ height: 100%; border-radius: 100px; background: linear-gradient(90deg, #a371f7, #3fb950); transition: width 0.6s; }}

    /* Sections */
    section {{ background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 1.4rem; margin-bottom: 1.5rem; }}
    h2 {{ font-size: 1rem; font-weight: 600; margin-bottom: 1.1rem; display: flex; align-items: center; gap: 0.5rem; }}
    h2.found-h {{ color: #3fb950; }}
    h2.miss-h {{ color: #d29922; }}

    /* Tables */
    table {{ width: 100%; border-collapse: collapse; font-size: 0.875rem; }}
    th {{ text-align: left; padding: 0.5rem 0.75rem; color: #8b949e; font-weight: 500; font-size: 0.8rem; border-bottom: 1px solid #21262d; }}
    td {{ padding: 0.75rem 0.75rem; border-bottom: 1px solid #1c2128; vertical-align: middle; }}
    tr:last-child td {{ border-bottom: none; }}
    tr:hover td {{ background: #0d111788; }}

    .catalog-title {{ color: #8b949e; font-size: 0.83rem; }}
    .alt-note {{ color: #6e7681; font-size: 0.75rem; }}
    .notes {{ color: #6e7681; font-size: 0.78rem; }}
    .year-tag {{ color: #6e7681; font-weight: normal; font-size: 0.82rem; }}

    .group-tag {{
      background: #1f2d3d; color: #79c0ff; padding: 2px 8px;
      border-radius: 4px; font-size: 0.73rem; white-space: nowrap;
    }}
    .score-badge {{
      padding: 2px 10px; border-radius: 100px; font-size: 0.8rem; font-weight: 700;
    }}
    .badge {{
      display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 0.73rem; font-weight: 500;
    }}
    .year-ok {{ background: #0d2b1a; color: #3fb950; border: 1px solid #3fb95044; }}
    .year-miss {{ background: #2b1a0d; color: #f0883e; border: 1px solid #f0883e44; }}
    .not-found-cell {{ color: #6e7681; font-style: italic; font-size: 0.83rem; }}
    .empty-cell {{ text-align: center; color: #6e7681; padding: 1.5rem; font-style: italic; }}

    footer {{ text-align: center; color: #30363d; font-size: 0.78rem; margin-top: 2.5rem; }}
    footer a {{ color: #388bfd; text-decoration: none; }}
  </style>
</head>
<body>
<div class="wrap">

  <header>
    <h1>🎬 IPTV <em>Watchdog</em></h1>
    <p class="meta">Report generated: {now} &nbsp;·&nbsp; {catalog_count:,} titles scanned in 4K catalogue</p>
  </header>

  <div class="stats">
    <div class="card purple"><div class="num">{len(results)}</div><div class="lbl">Wishlist movies</div></div>
    <div class="card green"><div class="num">{len(found)}</div><div class="lbl">Available in 4K ✅</div></div>
    <div class="card yellow"><div class="num">{len(not_found)}</div><div class="lbl">Still waiting ⏳</div></div>
    <div class="card"><div class="num">{pct}%</div><div class="lbl">Coverage</div></div>
  </div>

  <div class="progress-wrap">
    <div class="progress-bar" style="width:{pct}%"></div>
  </div>

  <section>
    <h2 class="found-h">✅ Available now – watch tonight!</h2>
    <table>
      <thead>
        <tr>
          <th>Your Wishlist</th>
          <th>Matched in Catalogue</th>
          <th>Category</th>
          <th>Match</th>
          <th>Year</th>
        </tr>
      </thead>
      <tbody>{found_rows}</tbody>
    </table>
  </section>

  <section>
    <h2 class="miss-h">⏳ Still waiting for…</h2>
    <table>
      <thead>
        <tr>
          <th>Movie</th>
          <th>Year</th>
          <th>Notes</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>{not_found_rows}</tbody>
    </table>
  </section>

  <footer>
    IPTV Watchdog &nbsp;·&nbsp; Edit <strong>wishlist.csv</strong> to update your list &nbsp;·&nbsp;
    Report auto-refreshes daily
  </footer>

</div>
</body>
</html>"""
    return html


# ─── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="IPTV Movie Watchdog")
    parser.add_argument("--config", default=None, help="Path to config.json")
    args = parser.parse_args()

    script_dir  = Path(__file__).parent
    config_path = Path(args.config) if args.config else script_dir / "config.json"
    wishlist_path = script_dir / "wishlist.csv"
    reports_dir   = script_dir / "reports"

    print("=" * 52)
    print("  IPTV Movie Watchdog")
    print(f"  {datetime.now().strftime('%A, %d %B %Y – %H:%M')}")
    print("=" * 52)

    # Load config
    cfg = load_config(config_path)

    # Load wishlist
    wishlist = load_wishlist(wishlist_path)
    if not wishlist:
        print("\nWishlist is empty. Edit wishlist.csv and re-run.")
        sys.exit(0)

    # Fetch & parse M3U
    content    = fetch_m3u(cfg["m3u_url"])
    all_entries = parse_m3u(content)
    print(f"Parsed {len(all_entries):,} total entries from playlist.")

    # Filter 4K movies
    movies_4k = filter_4k_movies(all_entries, cfg)
    print(f"Filtered to {len(movies_4k):,} entries in 4K categories.")

    if not movies_4k:
        print("\nWARNING: No 4K entries found. Check category_keywords in config.json.")
        print("Groups found in your playlist:")
        groups = sorted({e.get("group", "unknown") for e in all_entries})
        for g in groups[:30]:
            print(f"  · {g}")
        sys.exit(1)

    # Match wishlist against catalogue
    results = match_movies(wishlist, movies_4k, cfg)

    # Console summary
    found_count = sum(1 for r in results if r["found"])
    print(f"\n── Results: {found_count}/{len(results)} wishlist movies found in 4K ──")
    for r in results:
        if r["found"]:
            best = r["matches"][0]
            print(f"  ✅ {r['wish_title']:<35} → {best['catalog_title']} ({best['score']}%)")
        else:
            print(f"  ❌ {r['wish_title']}")

    # Generate & save HTML report
    reports_dir.mkdir(parents=True, exist_ok=True)
    date_str     = datetime.now().strftime("%Y-%m-%d")
    report_name  = f"watchdog_{date_str}.html"
    report_path  = reports_dir / report_name
    latest_path  = reports_dir / "latest.html"

    html = generate_html_report(results, len(movies_4k))
    report_path.write_text(html, encoding="utf-8")
    latest_path.write_text(html, encoding="utf-8")

    print(f"\n  Report saved: {report_path}")
    print(f"  Shortcut:     {latest_path}")

    if cfg.get("report_open_browser"):
        import webbrowser
        webbrowser.open(latest_path.as_uri())

    print("\nDone. ✓")


if __name__ == "__main__":
    main()
