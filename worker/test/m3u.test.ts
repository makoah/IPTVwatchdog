import { describe, expect, it } from "vitest";
import { matchesSeries, matchesWishlist } from "../src/matching";
import { parseM3u, selectionReason, withGroup } from "../src/m3u";
import type { Selection } from "../src/types";

function byteStream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("M3U parsing and filtering", () => {
  it("line-parses chunked playlists and preserves provider stream URLs", async () => {
    const stream = byteStream([
      '#EXTM3U\n#EXTINF:-1 tvg-id="news.nl" group-title="NL | Dutch',
      ' Channels",NL News\nhttp://stream.example/live/FAKE_USER/FAKE_PASSWORD/100.ts\n',
      '#EXTINF:-1 tvg-name="Dune Part Two (2024) 4K" group-title="VOD",Dune\n',
      "http://stream.example/movie/FAKE_USER/FAKE_PASSWORD/200.ts\n",
    ]);

    const entries = [];
    for await (const entry of parseM3u(stream)) entries.push(entry);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ tvgId: "news.nl", group: "NL | Dutch Channels", title: "NL News" });
    expect(entries[1].url).toBe("http://stream.example/movie/FAKE_USER/FAKE_PASSWORD/200.ts");
  });

  it("selects exact categories, fuzzy wishlist movies, and complete named series", () => {
    const selection: Selection = {
      keep_categories: ["NL | Dutch Channels"],
      wishlist: [{ title: "Dune Part Two", year: "2024" }],
      series: ["Slow Horses"],
    };
    const options = { threshold: 78, yearBonus: 12, yearPenalty: 5 };
    const categories = new Set(selection.keep_categories);

    expect(
      selectionReason(
        {
          extinf: "",
          url: "",
          title: "Any channel",
          group: "NL | Dutch Channels",
          tvgId: "nl.1",
        },
        selection,
        categories,
        options,
      ),
    ).toBe("category");
    expect(matchesWishlist("Dune.Part.Two.2024.2160p.WEB-DL", selection.wishlist, options)).toBe(true);
    expect(matchesSeries("Slow Horses S02E03 - Drinking Games 1080p", selection.series)).toBe(true);
    expect(matchesSeries("Slow Horses Trailer", selection.series)).toBe(false);
  });

  it("applies year penalties and rewrites only the watchlist group", () => {
    expect(
      matchesWishlist("Inception (2010) 4K", [{ title: "Inception", year: "2024" }], {
        threshold: 98,
        yearBonus: 12,
        yearPenalty: 5,
      }),
    ).toBe(false);
    expect(withGroup('#EXTINF:-1 tvg-id="movie.1" group-title="VOD",Dune', "🎬 Watchlist")).toBe(
      '#EXTINF:-1 tvg-id="movie.1" group-title="🎬 Watchlist",Dune',
    );
  });
});
