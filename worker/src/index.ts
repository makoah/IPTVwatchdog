import { refresh } from "./refresh";
import { isPublicationVersion, objectKey, readManifest } from "./storage";
import type { Env } from "./types";

async function secretEquals(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(actualHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

async function serveObject(env: Env, key: "playlist.m3u" | "epg.xml", request: Request): Promise<Response> {
  const url = new URL(request.url);
  const requestedVersion = key === "epg.xml" ? url.searchParams.get("v") : null;
  const manifest = await readManifest(env);
  const version =
    requestedVersion && isPublicationVersion(requestedVersion) ? requestedVersion : manifest?.version;
  if (!version) return notFound();

  const storageKey = objectKey(version, key);
  const object =
    request.method === "HEAD"
      ? await env.CURATOR_BUCKET.head(storageKey)
      : await env.CURATOR_BUCKET.get(storageKey);
  if (!object) return notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=300");
  if (key === "playlist.m3u") {
    headers.set("content-disposition", 'attachment; filename="playlist.m3u"');
  }
  return new Response(request.method === "HEAD" ? null : (object as R2ObjectBody).body, { headers });
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const playlistMatch = /^\/p\/([^/]+)\/(playlist\.m3u|epg\.xml)$/.exec(url.pathname);
  if (playlistMatch && (request.method === "GET" || request.method === "HEAD")) {
    let suppliedToken: string;
    try {
      suppliedToken = decodeURIComponent(playlistMatch[1]);
    } catch {
      return notFound();
    }
    if (!(await secretEquals(suppliedToken, env.PLAYLIST_TOKEN))) return notFound();
    return serveObject(env, playlistMatch[2] as "playlist.m3u" | "epg.xml", request);
  }

  if (url.pathname === "/admin/refresh" && request.method === "POST") {
    const authorization = request.headers.get("authorization") ?? "";
    const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!(await secretEquals(suppliedToken, env.ADMIN_TOKEN))) return notFound();
    try {
      const stats = await refresh(env);
      console.log(JSON.stringify({ event: "refresh_complete", ...stats }));
      return Response.json({ ok: true, ...stats });
    } catch (error) {
      console.error(JSON.stringify({ event: "refresh_failed", error: error instanceof Error ? error.name : "unknown" }));
      return Response.json({ ok: false, error: "Refresh failed" }, { status: 502 });
    }
  }

  return notFound();
}

export default {
  fetch: handleRequest,
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      const stats = await refresh(env);
      console.log(JSON.stringify({ event: "scheduled_refresh_complete", ...stats }));
    } catch (error) {
      console.error(
        JSON.stringify({ event: "scheduled_refresh_failed", error: error instanceof Error ? error.name : "unknown" }),
      );
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
