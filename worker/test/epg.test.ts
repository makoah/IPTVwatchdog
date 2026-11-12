import { describe, expect, it } from "vitest";
import { deriveEpgUrl, filterXmltv } from "../src/epg";

function byteStream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("XMLTV filtering", () => {
  it("keeps only selected channel definitions and programmes across chunks", async () => {
    const chunks: Uint8Array[] = [];
    const writer = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    }).getWriter();
    const input = byteStream([
      '<?xml version="1.0"?><tv><channel id="keep.1"><display-name>Keep</display-name></channel>',
      '<channel id="drop.1"><display-name>Drop</display-name></channel><programme start="20261112010000 +0000" ',
      'channel="keep.1"><title>Selected show</title></programme><programme channel="drop.1"><title>Other</title></programme></tv>',
    ]);

    const result = await filterXmltv(input, new Set(["keep.1"]), writer);
    await writer.close();
    const output = new TextDecoder().decode(
      chunks.reduce((all, chunk) => {
        const combined = new Uint8Array(all.length + chunk.length);
        combined.set(all);
        combined.set(chunk, all.length);
        return combined;
      }, new Uint8Array()),
    );

    expect(result).toEqual({ channels: 1, programmes: 1 });
    expect(output).toContain('channel id="keep.1"');
    expect(output).toContain('channel="keep.1"');
    expect(output).not.toContain("drop.1");
    expect(output.endsWith("</tv>\n")).toBe(true);
  });

  it("derives the Xtream XMLTV URL without unrelated playlist parameters", () => {
    const url = deriveEpgUrl(
      "http://provider.example/get.php?username=FAKE_USER&password=FAKE_PASSWORD&type=m3u_plus&output=ts",
    );
    expect(url).toBe(
      "http://provider.example/xmltv.php?username=FAKE_USER&password=FAKE_PASSWORD",
    );
    expect(deriveEpgUrl("https://provider.example/custom-playlist")).toBeUndefined();
  });
});
