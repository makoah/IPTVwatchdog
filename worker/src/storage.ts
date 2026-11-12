import type { Env } from "./types";

export interface PublicationManifest {
  version: string;
  previousVersion?: string;
}

const MANIFEST_KEY = "current.json";
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
