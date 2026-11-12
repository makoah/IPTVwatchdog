import type { Selection } from "./types";

function optionalScore(value: unknown, name: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be a finite number from 0 to 100`);
  }
}

export function validateSelection(value: unknown): Selection {
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
