import defaultSelection from "../selection.example.json";
import { deriveEpgUrl, filterXmltv } from "./epg";
import { prepareWishlist } from "./matching";
import { parseM3u, selectionReason, withGroup } from "./m3u";
import { createMultipartObjectWriter } from "./r2-multipart";
import { cleanupOldBuilds, objectKey, publishVersion } from "./storage";
import type { Env, RefreshStats, Selection } from "./types";

const SELECTION_KEY = "selection";
const encoder = new TextEncoder();

function optionalScore(value: unknown, name: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be a finite number from 0 to 100`);
  }
}

function validateSelection(value: unknown): Selection {
  if (!value || typeof value !== "object") throw new Error("Selection must be an object");
  const candidate = value as Partial<Selection>;
  if (!Array.isArray(candidate.keep_categories) || !candidate.keep_categories.every((v) => typeof v === "string")) {
    throw new Error("selection.keep_categories must be a string array");
  }
  if (!Array.isArray(candidate.series) || !candidate.series.every((v) => typeof v === "string")) {
    throw new Error("selection.series must be a string array");
  }
  if (
    !Array.isArray(candidate.wishlist) ||
    !candidate.wishlist.every(
      (v) =>
        v &&
        typeof v === "object" &&
        typeof v.title === "string" &&
        (v.year === undefined || typeof v.year === "string"),
    )
  ) {
    throw new Error("selection.wishlist must contain title and optional year strings");
  }
  optionalScore(candidate.match_threshold, "selection.match_threshold");
  optionalScore(candidate.year_bonus, "selection.year_bonus");
  optionalScore(candidate.year_penalty, "selection.year_penalty");
  return candidate as Selection;
}

export async function loadSelection(env: Env): Promise<Selection> {
  const stored = await env.CURATOR_CONFIG.get(SELECTION_KEY, "json");
  if (stored) return validateSelection(stored);
  const seeded = validateSelection(defaultSelection);
  await env.CURATOR_CONFIG.put(SELECTION_KEY, JSON.stringify(seeded));
  return seeded;
}

function publicEpgUrl(env: Env, version: string): string {
  const base = env.PUBLIC_BASE_URL.endsWith("/") ? env.PUBLIC_BASE_URL : `${env.PUBLIC_BASE_URL}/`;
  const url = new URL(`p/${encodeURIComponent(env.PLAYLIST_TOKEN)}/epg.xml`, base);
  url.searchParams.set("v", version);
  return url.toString();
}

async function writeEmptyEpg(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.put(key, '<?xml version="1.0" encoding="UTF-8"?>\n<tv></tv>\n', {
    httpMetadata: { contentType: "application/xml; charset=utf-8" },
  });
}

async function refreshEpg(env: Env, key: string, channelIds: ReadonlySet<string>): Promise<{
  available: boolean;
  programmes: number;
}> {
  const epgUrl = env.EPG_URL?.trim() || deriveEpgUrl(env.M3U_URL);
  if (!epgUrl || channelIds.size === 0) {
    await writeEmptyEpg(env.CURATOR_BUCKET, key);
    return { available: false, programmes: 0 };
  }

  let response: Response;
  try {
    response = await fetch(epgUrl, { headers: { "User-Agent": "IPTVWatchdog-Worker/1.0" } });
  } catch {
    await writeEmptyEpg(env.CURATOR_BUCKET, key);
    return { available: false, programmes: 0 };
  }
  if (!response.ok || !response.body) {
    response.body?.cancel();
    await writeEmptyEpg(env.CURATOR_BUCKET, key);
    return { available: false, programmes: 0 };
  }

  const output = await createMultipartObjectWriter(
    env.CURATOR_BUCKET,
    key,
    "application/xml; charset=utf-8",
  );
  try {
    const result = await filterXmltv(response.body, channelIds, output.writer);
    await output.writer.close();
    return { available: true, programmes: result.programmes };
  } catch (error) {
    await output.abort(error);
    await writeEmptyEpg(env.CURATOR_BUCKET, key);
    return { available: false, programmes: 0 };
  }
}

export async function refresh(env: Env): Promise<RefreshStats> {
  const version = crypto.randomUUID();
  const playlistKey = objectKey(version, "playlist.m3u");
  const epgKey = objectKey(version, "epg.xml");
  const selection = await loadSelection(env);
  const response = await fetch(env.M3U_URL, {
    headers: { "User-Agent": "VLC/3.0 (compatible; IPTVWatchdog-Worker)" },
  });
  if (!response.ok || !response.body) {
    response.body?.cancel();
    throw new Error(`Provider playlist fetch failed with status ${response.status}`);
  }

  const categorySet = new Set(selection.keep_categories);
  const matchOptions = {
    threshold: selection.match_threshold ?? 78,
    yearBonus: selection.year_bonus ?? 12,
    yearPenalty: selection.year_penalty ?? 5,
  };
  const preparedWishlist = prepareWishlist(selection.wishlist);
  const channelIds = new Set<string>();
  const output = await createMultipartObjectWriter(
    env.CURATOR_BUCKET,
    playlistKey,
    "audio/x-mpegurl; charset=utf-8",
  );
  let scanned = 0;
  let selected = 0;

  try {
    await output.writer.write(encoder.encode(`#EXTM3U url-tvg="${publicEpgUrl(env, version)}"\n`));
    for await (const entry of parseM3u(response.body)) {
      scanned += 1;
      const reason = selectionReason(entry, selection, categorySet, matchOptions, preparedWishlist);
      if (!reason) continue;
      const extinf = reason === "wishlist" ? withGroup(entry.extinf, "🎬 Watchlist") : entry.extinf;
      await output.writer.write(encoder.encode(`${extinf}\n${entry.url}\n`));
      selected += 1;
      if (entry.tvgId) channelIds.add(entry.tvgId);
    }
    await output.writer.close();
  } catch (error) {
    await output.abort(error);
    throw error;
  }

  const epg = await refreshEpg(env, epgKey, channelIds);
  await publishVersion(env, version);
  await cleanupOldBuilds(env).catch(() => undefined);
  return {
    scanned,
    selected,
    channels: channelIds.size,
    epgProgrammes: epg.programmes,
    epgAvailable: epg.available,
  };
}
