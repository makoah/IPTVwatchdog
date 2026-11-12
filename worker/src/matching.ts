import type { WishlistItem } from "./types";

const QUALITY_TAGS =
  /\b(4k|uhd|fhd|hd|hdr|hdr10|hdr10\+|dolby|vision|dv|sdr|2160p|1080p|720p|480p|bluray|blu[\s-]?ray|bdrip|brrip|webrip|web[\s-]dl|hdtv|dvdrip|dvd|hevc|x265|x264|avc|h264|h265|av1|remux|extended|directors[\s._]cut|theatrical|unrated|remastered|proper|imax|atmos|truehd|dts|aac|ac3|5\.1|7\.1|english|french|dutch|german|spanish|arabic|hindi|vip|premium|ott)\b/gi;

export function cleanTitle(title: string): string {
  return title
    .replace(/[(\[{]\s*\d{4}\s*[)\]}]/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(QUALITY_TAGS, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en");
}

export function extractYear(text: string): string {
  return text.match(/\b(19[89]\d|20[0-2]\d)\b/)?.[0] ?? "";
}

function tokenSort(value: string): string {
  return value.split(" ").filter(Boolean).sort().join(" ");
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export function tokenSortRatio(left: string, right: string): number {
  return sortedRatio(tokenSort(left), tokenSort(right));
}

function sortedRatio(a: string, b: string): number {
  if (!a && !b) return 100;
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 0 : Math.round((1 - levenshtein(a, b) / longest) * 100);
}

export interface MatchOptions {
  threshold: number;
  yearBonus: number;
  yearPenalty: number;
}

export interface PreparedWishlistItem {
  clean: string;
  sorted: string;
  year: string;
}

export function prepareWishlist(wishlist: WishlistItem[]): PreparedWishlistItem[] {
  return wishlist
    .map((item) => {
      const clean = cleanTitle(item.title);
      return { clean, sorted: tokenSort(clean), year: item.year?.trim() ?? "" };
    })
    .filter((item) => item.clean.length > 0);
}

export function matchesWishlist(
  catalogTitle: string,
  wishlist: Array<WishlistItem | PreparedWishlistItem>,
  options: MatchOptions,
): boolean {
  const catalogClean = cleanTitle(catalogTitle);
  if (!catalogClean) return false;
  const catalogSorted = tokenSort(catalogClean);
  const catalogYear = extractYear(catalogTitle);

  return wishlist.some((item) => {
    const wishClean = "clean" in item ? item.clean : cleanTitle(item.title);
    const wishSorted = "sorted" in item ? item.sorted : tokenSort(wishClean);
    let score = sortedRatio(wishSorted, catalogSorted);
    const wishYear = item.year?.trim() ?? "";
    if (wishYear && catalogYear) {
      score += wishYear === catalogYear ? options.yearBonus : -options.yearPenalty;
    }
    return Math.max(0, Math.min(100, score)) >= options.threshold;
  });
}

export function matchesSeries(catalogTitle: string, selectedSeries: string[]): boolean {
  const episodeMarker = /\b(?:s\d{1,2}\s*e\d{1,3}|\d{1,2}\s*x\s*\d{1,3}|season\s+\d+\s+episode\s+\d+)\b/i;
  const marker = episodeMarker.exec(catalogTitle);
  if (!marker) return false;
  const base = cleanTitle(catalogTitle.slice(0, marker.index));
  return selectedSeries.some((series) => cleanTitle(series) === base);
}
