import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEpg, buildPlaylist, buildStats } from "../src/build";
import type { ByteWriter, Selection } from "../src/types";

function collectingWriter(): { writer: ByteWriter; text(): string } {
  const chunks: Uint8Array[] = [];
  return {
    writer: {
      write(chunk) {
        chunks.push(chunk.slice());
      },
    },
    text() {
      const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const output = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(output);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Action build pipeline", () => {
  it("builds a versioned playlist and matching EPG with shared filters", async () => {
    const m3u = [
      "#EXTM3U",
      '#EXTINF:-1 tvg-id="keep.1" group-title="Keep",Kept channel',
      "http://stream.example/live/FAKE_USER/FAKE_PASSWORD/1.ts",
      '#EXTINF:-1 tvg-id="drop.1" group-title="Drop",Dropped channel',
      "http://stream.example/live/FAKE_USER/FAKE_PASSWORD/2.ts",
    ].join("\n");
    const xml = [
      '<?xml version="1.0"?><tv>',
      '<channel id="keep.1"><display-name>Keep</display-name></channel>',
      '<channel id="drop.1"><display-name>Drop</display-name></channel>',
      '<programme channel="keep.1"><title>Selected</title></programme>',
      '<programme channel="drop.1"><title>Other</title></programme>',
      "</tv>",
    ].join("");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(m3u, { status: 200 }))
        .mockResolvedValueOnce(new Response(xml, { status: 200 })),
    );

    const selection: Selection = { keep_categories: ["Keep"], wishlist: [], series: [] };
    const playlistOutput = collectingWriter();
    const playlist = await buildPlaylist({
      m3uUrl:
        "http://provider.example/get.php?username=FAKE_USER&password=FAKE_PASSWORD&type=m3u_plus&output=ts",
      publicBaseUrl: "https://curator.example.workers.dev",
      playlistToken: "FAKE_PLAYLIST_TOKEN",
      version: "123e4567-e89b-42d3-a456-426614174000",
      selection,
      writer: playlistOutput.writer,
    });
    const epgOutput = collectingWriter();
    const epg = await buildEpg(
      "http://provider.example/get.php?username=FAKE_USER&password=FAKE_PASSWORD",
      undefined,
      playlist.channelIds,
      epgOutput.writer,
    );

    expect(playlistOutput.text()).toContain(
      'url-tvg="https://curator.example.workers.dev/p/FAKE_PLAYLIST_TOKEN/epg.xml?v=123e4567-e89b-42d3-a456-426614174000"',
    );
    expect(playlistOutput.text()).toContain("/FAKE_USER/FAKE_PASSWORD/1.ts");
    expect(playlistOutput.text()).not.toContain("/FAKE_USER/FAKE_PASSWORD/2.ts");
    expect(epgOutput.text()).toContain('channel="keep.1"');
    expect(epgOutput.text()).not.toContain("drop.1");
    expect(buildStats(playlist, epg)).toEqual({
      scanned: 2,
      selected: 1,
      channels: 1,
      epgProgrammes: 1,
      epgAvailable: true,
    });
  });

  it("rejects a successful provider response that is not an M3U playlist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Login failed</html>", { status: 200 })));
    const output = collectingWriter();

    await expect(
      buildPlaylist({
        m3uUrl: "http://provider.example/get.php?username=FAKE_USER&password=FAKE_PASSWORD",
        publicBaseUrl: "https://curator.example.workers.dev",
        playlistToken: "FAKE_PLAYLIST_TOKEN",
        version: "123e4567-e89b-42d3-a456-426614174000",
        selection: { keep_categories: [], wishlist: [], series: [] },
        writer: output.writer,
      }),
    ).rejects.toThrow("not an M3U");
  });
});
