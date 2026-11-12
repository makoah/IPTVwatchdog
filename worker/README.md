# Cloudflare Personal Curator

The curator uses GitHub Actions for the expensive playlist and XMLTV processing, then uses a very small Cloudflare Worker to serve the generated files from private R2. Video is never proxied: selected M3U entries retain the provider's original stream URLs.

The existing Python application is independent and unchanged.

## Architecture

### GitHub Actions refresh

`.github/workflows/refresh-curator.yml` runs at 04:00 UTC every Monday and supports GitHub's **Run workflow** button through `workflow_dispatch`.

The Node process reuses the TypeScript parser and matching modules in `worker/src/`:

- fetch and line-parse the provider M3U;
- retain exact `group-title` categories, fuzzy wishlist movie matches, and all episodes of selected series;
- move wishlist-only matches to `🎬 Watchlist`;
- collect selected `tvg-id` values and stream-filter XMLTV;
- derive Xtream `xmltv.php` from `M3U_URL`, unless `EPG_URL` is supplied;
- write an empty valid XMLTV document if EPG retrieval fails;
- multipart-upload versioned `playlist.m3u` and `epg.xml` objects through R2's S3 API;
- update `current.json` only after both objects finish, then remove unreferenced builds older than 24 hours.

Generated files exist only in the hosted runner's temporary directory. The workflow does not commit them, upload a GitHub artifact, use a cache, or print their contents.

### Thin Worker

The Worker performs only:

1. constant-time verification of `PLAYLIST_TOKEN`;
2. one small R2 manifest read;
3. a streamed R2 `GET` or metadata-only `HEAD`.

Routes:

```text
GET|HEAD /p/<PLAYLIST_TOKEN>/playlist.m3u
GET|HEAD /p/<PLAYLIST_TOKEN>/epg.xml
```

A wrong token returns `404`. There is no Worker Cron Trigger or `/admin/refresh` endpoint. Manual refresh uses GitHub's **Actions → Refresh Cloudflare curator → Run workflow** control, avoiding an additional GitHub API token inside Cloudflare.

## Selection in KV

Selection remains in the `selection` key of the existing KV namespace:

```text
iptvwatchdog-curator-selection
99c03154219743e68952b9ff860545a6
```

KV is preferable to a repository JSON file because a future Access-protected admin UI can update the same key without making repository commits. The Action reads it using a narrowly scoped Cloudflare API token; the serving Worker does not read it yet.

Seed or replace the key from `worker/selection.example.json`:

```bash
cd worker
npx wrangler kv key put selection \
  --namespace-id 99c03154219743e68952b9ff860545a6 \
  --path selection.example.json \
  --remote
```

The JSON schema is:

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

## Cloudflare setup

These are setup instructions only. This repository does not create resources or deploy automatically.

### 1. R2 and API credentials

Create the private bucket if it does not already exist:

```bash
cd worker
npm install
npx wrangler login
npx wrangler r2 bucket create iptvwatchdog-curator
```

In the Cloudflare dashboard, create:

- an R2 S3 API token scoped to this bucket, producing an Access Key ID and Secret Access Key for uploads;
- a separate Cloudflare API token with read access to Workers KV for the selection namespace.

Keep the bucket private. Do not enable its `r2.dev` URL.

### 2. Worker secret and deployment

Create one long random playlist token. The same value must be stored in Cloudflare and GitHub:

```bash
npx wrangler deploy
npx wrangler secret put PLAYLIST_TOKEN
```

`wrangler secret put` creates and deploys a new Worker version. No provider credential is needed by the Worker.

The account's Workers subdomain is `karmma-ict`; the expected origin is:

```text
https://iptvwatchdog-curator.karmma-ict.workers.dev
```

Confirm the final URL in Cloudflare before configuring GitHub.

## GitHub configuration

Add these repository **Actions secrets**:

| Secret | Purpose |
|---|---|
| `M3U_URL` | Full provider playlist URL, including provider credentials |
| `EPG_URL` | Optional explicit XMLTV URL; leave unset for Xtream derivation |
| `PLAYLIST_TOKEN` | Same long token set on the Worker |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | Narrow token that can read the selection KV namespace |
| `R2_ACCESS_KEY_ID` | R2 S3 token access key |
| `R2_SECRET_ACCESS_KEY` | R2 S3 token secret |

Add this repository **Actions variable**:

| Variable | Value |
|---|---|
| `CURATOR_PUBLIC_BASE_URL` | Final Worker origin, without a path |

The namespace ID and bucket name are non-secret constants in the workflow. Change them there if the resources are renamed.

The workflow explicitly masks provider URLs, token values, R2 credentials, and derived EPG URLs. Its only success output is aggregate entry/programme counts. Errors intentionally omit exception details that might contain a credential-bearing URL.

Run the first refresh from the GitHub Actions tab. Then configure IPTV clients with:

```text
https://iptvwatchdog-curator.karmma-ict.workers.dev/p/YOUR_PLAYLIST_TOKEN/playlist.m3u
```

## Local development and tests

```bash
cd worker
cp .dev.vars.example .dev.vars
# Use a test-only PLAYLIST_TOKEN.
npm run check
npm run dev
```

The Action refresh command expects real private service credentials and is intended to run in GitHub Actions. Unit fixtures use fake hosts and credentials. `.dev.vars`, generated playlists, XMLTV files, and Wrangler state are ignored by Git.

## Free-tier assessment

- **Workers Free:** serving performs no parsing and should fit the 10 ms CPU allowance. The plan currently includes 100,000 Worker requests per day; playlist and EPG downloads count as requests.
- **GitHub Actions:** scheduled and manually dispatched runs use GitHub-hosted runner minutes. Standard runners are free for public repositories; private repositories consume the account's included monthly allowance and may incur charges after that allowance. One weekly job is expected to be modest, but provider download speed and XMLTV size determine duration.
- **R2:** only versioned generated files plus a small manifest are stored. R2 includes a free tier for storage and Class A/Class B operations; weekly writes and personal-client reads should normally remain small, but large EPG files and frequent app reloads determine actual usage.
- **KV:** one small selection read per refresh is far below normal free allowances.

Current references:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

## Security notes

- Provider URLs and generated stream URLs contain credentials. Keep R2 private and never commit, artifact, cache, or log generated files.
- Treat the playlist path as a bearer credential. Avoid analytics, screenshots, support messages, or app exports that reveal it.
- Use separate, least-privilege Cloudflare KV and R2 credentials.
- The Worker serves playlist and EPG files only. It never fetches or relays video streams.
