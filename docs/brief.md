# Project Brief: IPTV Personal Curator

## Executive Summary

The **IPTV Personal Curator** is a feature extension to the existing IPTV Watchdog that transforms a bloated 50,000-entry provider M3U playlist into a slim, personally curated playlist served from the user's own VPS. The core problem it solves is noise: IPTV apps are slow to load, cluttered with irrelevant content, and require the user to navigate through thousands of unwanted channels. The solution is a filtered M3U endpoint that combines a static category whitelist with a dynamic layer of 4K movies matched by the existing Watchdog engine — accessible from any device via a secret-token URL.

**Target user:** Single user (personal tool). No multi-tenancy, no accounts.

---

## Problem Statement

### Current state
IPTV providers deliver a single monolithic M3U playlist containing 30,000–150,000 entries: live channels from every country, VOD, series, 4K, SD, HD, sports, news, adult content, foreign language — all mixed together. The user has subscribed for a narrow set of interests (NFL, Dutch TV, US channels, 24/7 loops, 4K movies on wishlist).

### Pain points
- IPTV apps (TiviMate, IPTV Smarters, etc.) take significant time to parse and index a 150MB playlist on startup
- The UI is cluttered with thousands of entries the user will never touch
- No way to reorganize or rename categories without modifying the app itself
- The 4K movie watchlist (already solved by the Watchdog) has no connection to the active playlist on devices

### Why existing solutions fall short
- Provider portals offer no filtering — they serve the full playlist or nothing
- Third-party M3U editors are desktop apps, not server-side, so they don't keep in sync automatically
- No tool connects watchlist movie availability to the served playlist

---

## Proposed Solution

A new server-side component added to the existing `server.py` Flask application on the openclaw VPS that:

1. **Reads** the most recently fetched M3U from the provider (already downloaded by the Watchdog daily cron)
2. **Filters** it to keep only entries whose `group-title` exactly matches the user's explicit category whitelist (`filter_config.json`)
3. **Appends** a dynamic layer of 4K movie entries that currently match the Watchdog wishlist
4. **Serves** the result as a standard M3U file at a secret-token URL accessible from any device without VPN

The approach deliberately avoids proxying video streams — the stream URLs retain provider credentials and point directly to the provider CDN. This is an accepted, conscious trade-off in exchange for simplicity and zero bandwidth overhead on the VPS.

---

## Target Users

### Primary: The owner (single user)
- Watches IPTV on a home smart TV (Netherlands) and an Apple TV in Santa Pola, Spain
- Interested in: NFL, possibly other US sports, US TV channels, Dutch TV channels, 24/7 category channels, 4K movies from personal wishlist
- Technical comfort level: high — already running Python scripts and managing a VPS
- Goal: one clean playlist URL that works on all devices, stays current automatically, contains only what matters

---

## Goals & Success Metrics

### Objectives
- Reduce M3U size from ~150MB / 50,000 entries to under 2MB / ~500 entries
- App startup/refresh time on IPTV clients drops noticeably (subjective: "feels instant")
- Wishlist 4K movies available in the provider catalog automatically appear in the playlist
- One URL works on all devices (home TV, Apple TV Santa Pola, phone) with zero per-device setup

### Success criteria
- Any IPTV app pointed at the curator URL shows only whitelisted categories + matched 4K movies
- After a Watchdog scan finds a new match, that movie appears in the playlist on next M3U refresh
- When a movie leaves the provider catalog, it drops from the playlist automatically
- The secret token URL is not guessable and is stored only in `config.json` (gitignored)

---

## MVP Scope

### Core Features (Must Have)

- **Group discovery command:** One-shot script/CLI flag that dumps all unique `group-title` values from the current M3U to a readable file. Required prerequisite so the user can identify exact category strings to whitelist.

- **`filter_config.json`:** A simple JSON file (gitignored, created manually per machine) containing the explicit list of `group-title` strings to keep. Example:
  ```json
  {
    "keep_categories": [
      "US | NFL",
      "NL | Dutch Channels",
      "USA | Entertainment",
      "24/7 | Movies"
    ]
  }
  ```

- **Filtered M3U endpoint:** New Flask route on `server.py`:
  ```
  GET /m3u/<secret_token>/playlist.m3u
  ```
  Returns a valid M3U containing only whitelisted category entries + dynamic 4K wishlist matches. Token is a long random string stored in `config.json`.

- **Dynamic 4K layer:** After applying the category filter, append all 4K catalog entries that matched the most recent Watchdog scan (i.e., entries in `reports/latest.html` results, re-read from scan state or a persisted JSON). Group these under a custom group title: `"🎬 Watchlist – Available Now"`.

- **Token configuration:** `config.json` gains a `playlist_token` field (random UUID or long string). If absent, the endpoint returns 404. Token is never committed to git.

### Out of Scope for MVP
- Stream URL rewriting / credential proxying (consciously deferred)
- Dashboard UI for managing the category whitelist (edit `filter_config.json` directly)
- Multiple user profiles or access levels
- Automatic group discovery on cron (manual one-shot only)
- EPG (Electronic Programme Guide) passthrough
- Per-device access tokens

### MVP Success Criteria
All whitelisted categories render correctly in TiviMate or IPTV Smarters when pointed at the curator URL. The `"🎬 Watchlist – Available Now"` group appears and contains currently matched movies. Accessing the URL without the correct token returns 404.

---

## Post-MVP Vision

### Phase 2
- **Dashboard UI section** for managing the category whitelist (add/remove categories via web UI, no need to SSH)
- **Category entry counts** shown in the dashboard (e.g., "US | NFL — 47 entries")
- **Scheduled M3U re-fetch** decoupled from the scan, so the playlist stays fresh even if the user hasn't run a full Watchdog scan
- **Custom group renaming** — map provider group names to cleaner display names in `filter_config.json`

### Long-term vision
A fully self-hosted personal IPTV hub: curated playlist, watchlist management, availability alerts (e.g., notify via Telegram when a wishlisted movie appears), and a lightweight EPG overlay for live channels — all from a single VPS with no third-party dependencies.

### Expansion opportunities
- Multi-provider support (merge filtered playlists from multiple M3U sources)
- Tailscale integration for fully private serving when all devices support it
- Basic watch-history tracking (which stream URLs were accessed)

---

## Technical Considerations

### Platform requirements
- **Runtime:** Python 3.10+ (already on openclaw VPS)
- **Framework:** Flask (already used in `server.py`)
- **Client devices:** Any IPTV app on smart TV (Samsung/LG), Apple TV, iOS — all consuming standard M3U format
- **Serving:** HTTP on a non-standard port (e.g., 8787 already in use, or a separate port)

### Technology preferences
- **Backend:** Python / Flask — extend existing `server.py`, no new framework
- **Config:** JSON files (`config.json`, `filter_config.json`) — consistent with existing pattern
- **No database:** Scan results already in memory / latest.html; read from `_scan_state` or a persisted JSON sidecar written after each scan
- **Hosting:** openclaw VPS, existing setup

### Architecture considerations
- **Repository:** Single repo (`IPTVwatchdog`), new code added to existing files where logical
- **New files:** `filter_config.json` (gitignored), `filter_config.example.json` (committed as template)
- **Service architecture:** No new process — new endpoint added to existing Flask app
- **Security:** Secret token in URL path. Provider credentials remain embedded in stream URLs (accepted risk). Token stored in gitignored `config.json`.
- **M3U source:** Reuse the M3U already fetched by the Watchdog cron — no duplicate downloads. If no cached M3U exists, trigger a fresh fetch.

---

## Constraints & Assumptions

### Constraints
- **Budget:** Zero — personal tool, no external services
- **Timeline:** No deadline — builds when convenient
- **Resources:** Single developer (AI-assisted), single VPS
- **Technical:** Cannot proxy video streams without significant VPS bandwidth cost — stream URLs stay as-is with embedded provider credentials

### Key Assumptions
- Provider uses Xtream Codes format — credentials embedded in every stream URL (verified by examining M3U URL structure)
- The group-title values in the M3U are stable enough that an explicit whitelist doesn't break on minor provider updates
- The openclaw VPS has a stable public IP or DNS that devices can reach
- The existing Watchdog cron keeps the local M3U cache reasonably fresh (daily)
- `filter_config.json` is created manually on the VPS after deployment — no automated provisioning needed

---

## Risks & Open Questions

### Key Risks
- **Provider credential exposure:** Anyone with the secret token URL can read the M3U and extract provider username/password from stream URLs. Mitigated by: long random token, non-standard port, no public DNS pointing to this endpoint.
- **Group-title instability:** Provider may rename or restructure categories on their end, silently breaking the whitelist filter. Mitigated by: group discovery tool can be re-run; filter simply returns zero entries for unmatched categories rather than crashing.
- **M3U cache staleness:** If the Watchdog cron hasn't run recently, the served playlist may be outdated. Mitigated by: endpoint can optionally trigger a fresh fetch if cache is older than N hours.
- **Port accessibility:** VPS firewall must have the Flask port open to the internet. Needs to be confirmed/configured on openclaw.

### Open Questions
- What exact port should the curator endpoint run on — same as `server.py` (8787) or a dedicated port?
- Should the dynamic 4K layer pull from `_scan_state` (in-memory, lost on server restart) or from a persisted JSON file written after each scan?
- Should the M3U be regenerated on every request or cached and regenerated on a timer / after each scan?

### Areas Needing Further Research
- Confirm exact `group-title` strings in the user's provider M3U (requires group discovery tool output)
- Verify openclaw VPS firewall configuration for inbound HTTP access

---

## Next Steps

1. **Run group discovery** — add `--list-groups` flag to `iptv_watchdog.py` to dump all unique `group-title` values; user reviews output and selects exact category strings
2. **Create `filter_config.example.json`** — committed template showing expected structure
3. **Implement filtered M3U endpoint** in `server.py` — `/m3u/<token>/playlist.m3u`
4. **Persist scan results** — write matched movie entries to a JSON sidecar after each scan so they survive server restarts
5. **Test on one device** — point TiviMate or IPTV Smarters at the curator URL, verify categories and 4K layer
6. **Open VPS port** — confirm firewall allows inbound traffic on the serving port

---

## PM Handoff

This Project Brief provides the full context for the IPTV Personal Curator feature. Please start in 'PRD Generation Mode', review the brief thoroughly to work with the user to create the PRD section by section as the template indicates, asking for any necessary clarification or suggesting improvements.
