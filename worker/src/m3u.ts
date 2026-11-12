import {
  matchesSeries,
  matchesWishlist,
  prepareWishlist,
  type MatchOptions,
  type PreparedWishlistItem,
} from "./matching";
import type { M3uEntry, Selection } from "./types";

export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) yield line;
      if (done) {
        completed = true;
        break;
      }
    }
    if (pending) yield pending;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function attribute(line: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escapedName}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(line)?.[2]?.trim() ?? "";
}

export function parseExtinf(extinf: string, url: string): M3uEntry {
  const comma = extinf.lastIndexOf(",");
  const displayTitle = comma >= 0 ? extinf.slice(comma + 1).trim() : "";
  return {
    extinf,
    url,
    title: attribute(extinf, "tvg-name") || displayTitle || "Unknown",
    group: attribute(extinf, "group-title"),
    tvgId: attribute(extinf, "tvg-id"),
  };
}

export async function* parseM3u(stream: ReadableStream<Uint8Array>): AsyncGenerator<M3uEntry> {
  let pendingExtinf = "";
  for await (const rawLine of readLines(stream)) {
    const line = rawLine.trim();
    if (line.startsWith("#EXTINF")) {
      pendingExtinf = line;
    } else if (pendingExtinf && line && !line.startsWith("#")) {
      yield parseExtinf(pendingExtinf, line);
      pendingExtinf = "";
    }
  }
}

function quoteAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export function withGroup(extinf: string, group: string): string {
  const encoded = quoteAttribute(group);
  if (/\bgroup-title\s*=\s*(["']).*?\1/i.test(extinf)) {
    return extinf.replace(/\bgroup-title\s*=\s*(["']).*?\1/i, `group-title="${encoded}"`);
  }
  const comma = extinf.lastIndexOf(",");
  return comma >= 0
    ? `${extinf.slice(0, comma)} group-title="${encoded}"${extinf.slice(comma)}`
    : `${extinf} group-title="${encoded}"`;
}

export type SelectionReason = "category" | "wishlist" | "series";

export function selectionReason(
  entry: M3uEntry,
  selection: Selection,
  categorySet: ReadonlySet<string>,
  matchOptions: MatchOptions,
  preparedWishlist: PreparedWishlistItem[] = prepareWishlist(selection.wishlist),
): SelectionReason | undefined {
  if (categorySet.has(entry.group)) return "category";
  if (matchesWishlist(entry.title, preparedWishlist, matchOptions)) return "wishlist";
  if (matchesSeries(entry.title, selection.series)) return "series";
  return undefined;
}
