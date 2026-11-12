import { deriveEpgUrl, filterXmltv } from "./epg";
import { prepareWishlist } from "./matching";
import { parseM3u, selectionReason, withGroup } from "./m3u";
import type { ByteWriter, RefreshStats, Selection } from "./types";

const encoder = new TextEncoder();

export interface PlaylistBuildOptions {
  m3uUrl: string;
  publicBaseUrl: string;
  playlistToken: string;
  version: string;
  selection: Selection;
  writer: ByteWriter;
}

export interface PlaylistBuildResult {
  scanned: number;
  selected: number;
  channelIds: Set<string>;
}

function publicEpgUrl(options: PlaylistBuildOptions): string {
  const base = options.publicBaseUrl.endsWith("/") ? options.publicBaseUrl : `${options.publicBaseUrl}/`;
  const url = new URL(`p/${encodeURIComponent(options.playlistToken)}/epg.xml`, base);
  url.searchParams.set("v", options.version);
  return url.toString();
}

export async function buildPlaylist(options: PlaylistBuildOptions): Promise<PlaylistBuildResult> {
  const response = await fetch(options.m3uUrl, {
    headers: { "User-Agent": "VLC/3.0 (compatible; IPTVWatchdog-Action)" },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Provider playlist fetch failed with status ${response.status}`);
  }

  const categorySet = new Set(options.selection.keep_categories);
  const matchOptions = {
    threshold: options.selection.match_threshold ?? 78,
    yearBonus: options.selection.year_bonus ?? 12,
    yearPenalty: options.selection.year_penalty ?? 5,
  };
  const preparedWishlist = prepareWishlist(options.selection.wishlist);
  const channelIds = new Set<string>();
  let scanned = 0;
  let selected = 0;

  await options.writer.write(encoder.encode(`#EXTM3U url-tvg="${publicEpgUrl(options)}"\n`));
  for await (const entry of parseM3u(response.body)) {
    scanned += 1;
    const reason = selectionReason(entry, options.selection, categorySet, matchOptions, preparedWishlist);
    if (!reason) continue;
    const extinf = reason === "wishlist" ? withGroup(entry.extinf, "🎬 Watchlist") : entry.extinf;
    await options.writer.write(encoder.encode(`${extinf}\n${entry.url}\n`));
    selected += 1;
    if (entry.tvgId) channelIds.add(entry.tvgId);
  }
  if (scanned === 0) throw new Error("Provider playlist contained no entries");

  return { scanned, selected, channelIds };
}

export async function writeEmptyEpg(writer: ByteWriter): Promise<void> {
  await writer.write(encoder.encode('<?xml version="1.0" encoding="UTF-8"?>\n<tv></tv>\n'));
}

export async function buildEpg(
  m3uUrl: string,
  configuredEpgUrl: string | undefined,
  channelIds: ReadonlySet<string>,
  writer: ByteWriter,
): Promise<{ available: boolean; programmes: number }> {
  const epgUrl = configuredEpgUrl?.trim() || deriveEpgUrl(m3uUrl);
  if (!epgUrl || channelIds.size === 0) {
    await writeEmptyEpg(writer);
    return { available: false, programmes: 0 };
  }

  let response: Response;
  try {
    response = await fetch(epgUrl, { headers: { "User-Agent": "IPTVWatchdog-Action/1.0" } });
  } catch {
    await writeEmptyEpg(writer);
    return { available: false, programmes: 0 };
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    await writeEmptyEpg(writer);
    return { available: false, programmes: 0 };
  }

  const result = await filterXmltv(response.body, channelIds, writer);
  return { available: true, programmes: result.programmes };
}

export function buildStats(
  playlist: PlaylistBuildResult,
  epg: { available: boolean; programmes: number },
): RefreshStats {
  return {
    scanned: playlist.scanned,
    selected: playlist.selected,
    channels: playlist.channelIds.size,
    epgProgrammes: epg.programmes,
    epgAvailable: epg.available,
  };
}
