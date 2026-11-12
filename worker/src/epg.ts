import type { ByteWriter } from "./types";

export interface EpgFilterResult {
  channels: number;
  programmes: number;
}

function xmlAttribute(element: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escapedName}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(element)?.[2] ?? "";
}

export async function filterXmltv(
  input: ReadableStream<Uint8Array>,
  selectedIds: ReadonlySet<string>,
  writer: ByteWriter,
): Promise<EpgFilterResult> {
  const reader = input.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let channels = 0;
  let programmes = 0;
  let completed = false;

  await writer.write(encoder.encode('<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n'));
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      const blockPattern = /<(channel|programme)\b[\s\S]*?<\/\1\s*>/gi;
      let consumed = 0;
      for (let match = blockPattern.exec(buffer); match; match = blockPattern.exec(buffer)) {
        consumed = blockPattern.lastIndex;
        const [block, kind] = match;
        const id = xmlAttribute(block, kind.toLowerCase() === "channel" ? "id" : "channel");
        if (!selectedIds.has(id)) continue;
        await writer.write(encoder.encode(`${block}\n`));
        if (kind.toLowerCase() === "channel") channels += 1;
        else programmes += 1;
      }

      if (consumed > 0) {
        buffer = buffer.slice(consumed);
      } else {
        const start = buffer.search(/<(?:channel|programme)\b/i);
        if (start > 0) buffer = buffer.slice(start);
      }
      if (done) {
        completed = true;
        break;
      }
    }
    await writer.write(encoder.encode("</tv>\n"));
    return { channels, programmes };
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function deriveEpgUrl(m3uUrl: string): string | undefined {
  try {
    const url = new URL(m3uUrl);
    if (!/\/get\.php$/i.test(url.pathname)) return undefined;
    const username = url.searchParams.get("username");
    const password = url.searchParams.get("password");
    if (!username || !password) return undefined;
    url.pathname = url.pathname.replace(/get\.php$/i, "xmltv.php");
    url.search = "";
    url.searchParams.set("username", username);
    url.searchParams.set("password", password);
    return url.toString();
  } catch {
    return undefined;
  }
}
