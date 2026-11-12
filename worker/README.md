# Cloudflare Personal Curator

This Worker builds a small M3U and matching XMLTV file from an IPTV provider, stores both in a private R2 bucket, and serves them at token-bearing URLs. Video is never proxied: every selected M3U entry retains the provider's original stream URL.

The existing Python application is independent and unchanged.

## Architecture

- A weekly Cron Trigger or authenticated `POST /admin/refresh` starts a refresh.
- The Worker reads `M3U_URL` as a secret and line-parses the provider playlist.
- Entries are selected by exact `group-title`, fuzzy movie title/year matching, or a selected series name followed by an episode marker such as `S02E03` or `2x03`.
- Wishlist-only entries are moved to `🎬 Watchlist`. Entries already included by category keep their original group.
- `tvg-id` values from selected entries drive a streaming XMLTV filter. `EPG_URL` can be supplied explicitly; otherwise an Xtream-style `get.php` URL is converted to `xmltv.php` with the same username and password.
- Playlist and EPG output is buffered into fixed 5 MiB multipart chunks and uploaded under one versioned R2 prefix. A small manifest is switched only after both files finish, so clients never see half of a refresh. Current and previous versions are always retained; unreferenced builds older than 24 hours are removed after successful refreshes.
- A missing or failed EPG produces a valid empty XMLTV document instead of failing the playlist refresh.
- Selection JSON is stored under the `selection` key in KV. The first refresh seeds it from `selection.example.json` if it is absent.
- `GET|HEAD /p/<PLAYLIST_TOKEN>/playlist.m3u` and `/p/<PLAYLIST_TOKEN>/epg.xml` read the R2 objects. A bad token returns `404`.

`PUBLIC_BASE_URL` is used to place this Worker's EPG URL in the M3U `url-tvg` header. Set it to the final `workers.dev` or custom-domain origin, with no path.

## Configuration

Requirements: Node.js 20+ and a Cloudflare account.

```bash
cd worker
npm install
```

Create the resources (these commands are instructions; this repository does not create or deploy anything automatically):

```bash
npx wrangler login
npx wrangler r2 bucket create iptvwatchdog-curator
npx wrangler kv namespace create iptvwatchdog-curator-config
```

Copy the KV namespace ID printed by Wrangler into `wrangler.jsonc` in place of `REPLACE_WITH_KV_NAMESPACE_ID`. Change `bucket_name` if a different R2 name was used. Also replace `PUBLIC_BASE_URL` with the Worker's expected URL, for example:

```json
"PUBLIC_BASE_URL": "https://iptvwatchdog-curator.example.workers.dev"
```

Create the Worker, then enter each secret interactively. Do not put secret values on the command line:

```bash
npx wrangler deploy
npx wrangler secret put M3U_URL
npx wrangler secret put PLAYLIST_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

Use a separate, long random value for each token. If XMLTV cannot be derived from `M3U_URL`, also run:

```bash
npx wrangler secret put EPG_URL
```

`wrangler secret put` creates and deploys a new Worker version. Review Cloudflare's secret/version behavior before rotating a production value.

### Selection

Edit `selection.example.json` before the first refresh. It supports:

```json
{
  "keep_categories": ["exact provider group-title"],
  "wishlist": [{"title": "Movie title", "year": "2024"}],
  "series": ["Series name"],
  "match_threshold": 78,
  "year_bonus": 12,
  "year_penalty": 5
}
```

The Worker automatically writes this example to KV when no selection exists. To seed or replace it explicitly:

```bash
npx wrangler kv key put selection \
  --binding CURATOR_CONFIG \
  --path selection.example.json \
  --remote
```

Step 2 can edit the same KV key. Keep it valid JSON with the schema above.

### First refresh and playlist URLs

Trigger the first build after all secrets and `PUBLIC_BASE_URL` are configured:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  https://iptvwatchdog-curator.example.workers.dev/admin/refresh
```

Configure IPTV clients with:

```text
https://iptvwatchdog-curator.example.workers.dev/p/YOUR_PLAYLIST_TOKEN/playlist.m3u
```

The playlist's `url-tvg` header points to the corresponding token-protected `epg.xml`. The configured Cron Trigger runs at 04:00 UTC every Monday.

## Local development and tests

```bash
cp .dev.vars.example .dev.vars
# Replace every placeholder in .dev.vars with test-only values.
npm test
npm run typecheck
npm run dev
```

Local R2 and KV data are simulated by Wrangler. The fixtures use fake hosts and credentials. `.dev.vars` is ignored and must never be committed.

## CPU and cost assessment

Workers Free is not a realistic target for the refresh job. Its current CPU allowance is 10 ms per HTTP or Cron invocation. A 50,000-entry scan performs normalization and fuzzy comparison for each wishlist item, then tokenizes a potentially large XMLTV document; streaming bounds memory but does not reduce that CPU work.

Workers Paid has a $5 USD monthly minimum, a 128 MB memory limit, up to 5 minutes of CPU for HTTP requests (30 seconds by default), and up to 15 minutes for Cron intervals of at least one hour. Weekly Cron is therefore the preferred refresh path. Manual refresh is useful for setup, but a very large catalog may exceed its default CPU allowance; increase the Worker's CPU limit only after measuring on the Paid plan.

R2 stores two generated files per retained version plus a small manifest, and KV stores one small JSON document, so their usage should normally remain in the included tiers. Failed builds can remain for up to 24 hours. Actual cost depends on playlist/EPG size and client fetch frequency.

If one Paid invocation still exceeds CPU or memory limits, the next design step is staged processing with Queues or Workflows and temporary R2 chunks. That adds state, retries, and paid-resource complexity, so it is deliberately not part of this step.

Current limits and pricing:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

## Security notes

- Provider URLs and generated stream URLs contain credentials. The R2 bucket must remain private.
- Use long, unrelated values for `PLAYLIST_TOKEN` and `ADMIN_TOKEN`; both are compared using SHA-256 digests.
- The secret path is a bearer credential. Avoid analytics, screenshots, support messages, or app exports that reveal it.
- Refresh logs contain only event names and counts, never provider URLs, playlist tokens, or stream URLs.
- The Worker serves playlist and EPG files only. It never fetches or relays video streams.
