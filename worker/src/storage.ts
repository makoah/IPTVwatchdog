import type { Env } from "./types";

export interface PublicationManifest {
  version: string;
  previousVersion?: string;
}

const MANIFEST_KEY = "current.json";
const BUILD_RETENTION_MS = 24 * 60 * 60 * 1000;
const VERSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPublicationVersion(value: string): boolean {
  return VERSION_PATTERN.test(value);
}

export function objectKey(version: string, filename: "playlist.m3u" | "epg.xml"): string {
  return `builds/${version}/${filename}`;
}

export async function readManifest(env: Env): Promise<PublicationManifest | undefined> {
  const object = await env.CURATOR_BUCKET.get(MANIFEST_KEY);
  if (!object) return undefined;
  try {
    const value = await object.json<PublicationManifest>();
    return isPublicationVersion(value.version) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function publishVersion(env: Env, version: string): Promise<void> {
  const oldManifest = await readManifest(env);
  const manifest: PublicationManifest = {
    version,
    ...(oldManifest ? { previousVersion: oldManifest.version } : {}),
  };
  await env.CURATOR_BUCKET.put(MANIFEST_KEY, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

export async function cleanupOldBuilds(env: Env): Promise<void> {
  const manifest = await readManifest(env);
  const retained = new Set(
    [manifest?.version, manifest?.previousVersion].filter((value): value is string => Boolean(value)),
  );
  const cutoff = Date.now() - BUILD_RETENTION_MS;
  const expiredKeys: string[] = [];
  let cursor: string | undefined;

  do {
    const result = await env.CURATOR_BUCKET.list({ prefix: "builds/", cursor });
    for (const object of result.objects) {
      const version = object.key.split("/")[1] ?? "";
      if (!retained.has(version) && object.uploaded.getTime() < cutoff) expiredKeys.push(object.key);
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  for (let index = 0; index < expiredKeys.length; index += 1000) {
    await env.CURATOR_BUCKET.delete(expiredKeys.slice(index, index + 1000));
  }
}
