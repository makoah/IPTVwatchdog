import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { buildEpg, buildPlaylist, buildStats, writeEmptyEpg } from "./build";
import { deriveEpgUrl } from "./epg";
import { isPublicationVersion, objectKey, type PublicationManifest } from "./storage";
import { validateSelection } from "./selection";
import type { ByteWriter, Selection } from "./types";

const MANIFEST_KEY = "current.json";
const BUILD_RETENTION_MS = 24 * 60 * 60 * 1000;
const FIVE_MIB = 5 * 1024 * 1024;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function mask(value: string | undefined): void {
  if (value) process.stdout.write(`::add-mask::${value}\n`);
}

function fileWriter(path: string): WritableStreamDefaultWriter<Uint8Array> {
  const stream = createWriteStream(path, { flags: "wx" });
  return (Writable.toWeb(stream) as WritableStream<Uint8Array>).getWriter();
}

async function readSelection(accountId: string, namespaceId: string, apiToken: string): Promise<Selection> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/selection`,
    { headers: { authorization: `Bearer ${apiToken}` } },
  );
  if (!response.ok) throw new Error(`Cloudflare KV selection read failed with status ${response.status}`);
  return validateSelection(await response.json());
}

async function getManifest(client: S3Client, bucket: string): Promise<PublicationManifest | undefined> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: MANIFEST_KEY }));
    const parsed = JSON.parse((await response.Body?.transformToString()) ?? "") as PublicationManifest;
    return isPublicationVersion(parsed.version) ? parsed : undefined;
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "NoSuchKey") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function uploadFile(
  client: S3Client,
  bucket: string,
  key: string,
  path: string,
  contentType: string,
): Promise<void> {
  const upload = new Upload({
    client,
    params: { Bucket: bucket, Key: key, Body: createReadStream(path), ContentType: contentType },
    partSize: FIVE_MIB,
    queueSize: 2,
    leavePartsOnError: false,
  });
  await upload.done();
}

async function publishManifest(
  client: S3Client,
  bucket: string,
  version: string,
): Promise<PublicationManifest> {
  const oldManifest = await getManifest(client, bucket);
  const manifest: PublicationManifest = {
    version,
    ...(oldManifest ? { previousVersion: oldManifest.version } : {}),
  };
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: MANIFEST_KEY,
      Body: JSON.stringify(manifest),
      ContentType: "application/json; charset=utf-8",
    }),
  );
  return manifest;
}

async function cleanupOldBuilds(client: S3Client, bucket: string, manifest: PublicationManifest): Promise<void> {
  const retained = new Set([manifest.version, manifest.previousVersion].filter(Boolean));
  const cutoff = Date.now() - BUILD_RETENTION_MS;
  const expired: string[] = [];
  let continuationToken: string | undefined;

  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "builds/", ContinuationToken: continuationToken }),
    );
    for (const object of page.Contents ?? []) {
      const key = object.Key;
      if (!key || !object.LastModified) continue;
      const version = key.split("/")[1] ?? "";
      if (!retained.has(version) && object.LastModified.getTime() < cutoff) expired.push(key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  for (let index = 0; index < expired.length; index += 1000) {
    const result = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: expired.slice(index, index + 1000).map((Key) => ({ Key })), Quiet: true },
      }),
    );
    if (result.Errors?.length) throw new Error("R2 cleanup did not delete every expired object");
  }
}

async function main(): Promise<void> {
  const m3uUrl = requiredEnv("M3U_URL");
  const epgUrl = process.env.EPG_URL?.trim() || undefined;
  const playlistToken = requiredEnv("PLAYLIST_TOKEN");
  const publicBaseUrl = requiredEnv("PUBLIC_BASE_URL");
  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requiredEnv("CLOUDFLARE_API_TOKEN");
  const namespaceId = requiredEnv("CURATOR_CONFIG_NAMESPACE_ID");
  const bucket = requiredEnv("R2_BUCKET");
  const accessKeyId = requiredEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("R2_SECRET_ACCESS_KEY");

  mask(m3uUrl);
  mask(epgUrl);
  mask(playlistToken);
  mask(apiToken);
  mask(accessKeyId);
  mask(secretAccessKey);
  mask(deriveEpgUrl(m3uUrl));
  const version = randomUUID();
  const versionedEpgUrl = new URL(
    `p/${encodeURIComponent(playlistToken)}/epg.xml?v=${encodeURIComponent(version)}`,
    publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`,
  ).toString();
  mask(versionedEpgUrl);

  const selection = await readSelection(accountId, namespaceId, apiToken);
  const directory = await mkdtemp(join(tmpdir(), "iptvwatchdog-"));
  const playlistPath = join(directory, "playlist.m3u");
  const epgPath = join(directory, "epg.xml");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  try {
    const playlistWriter = fileWriter(playlistPath);
    let playlist: Awaited<ReturnType<typeof buildPlaylist>>;
    try {
      playlist = await buildPlaylist({
        m3uUrl,
        publicBaseUrl,
        playlistToken,
        version,
        selection,
        writer: playlistWriter,
      });
      await playlistWriter.close();
    } catch (error) {
      await playlistWriter.abort(error).catch(() => undefined);
      throw error;
    }

    let epg: { available: boolean; programmes: number };
    let epgWriter: (ByteWriter & { close(): Promise<void>; abort(reason?: unknown): Promise<void> }) | undefined;
    try {
      epgWriter = fileWriter(epgPath);
      epg = await buildEpg(m3uUrl, epgUrl, playlist.channelIds, epgWriter);
      await epgWriter.close();
    } catch {
      await epgWriter?.abort().catch(() => undefined);
      await rm(epgPath, { force: true });
      const emptyWriter = fileWriter(epgPath);
      await writeEmptyEpg(emptyWriter);
      await emptyWriter.close();
      epg = { available: false, programmes: 0 };
    }

    const uploads = await Promise.allSettled([
      uploadFile(
        client,
        bucket,
        objectKey(version, "playlist.m3u"),
        playlistPath,
        "audio/x-mpegurl; charset=utf-8",
      ),
      uploadFile(client, bucket, objectKey(version, "epg.xml"), epgPath, "application/xml; charset=utf-8"),
    ]);
    if (uploads.some((upload) => upload.status === "rejected")) {
      throw new Error("One or more R2 uploads failed");
    }
    const manifest = await publishManifest(client, bucket, version);
    await cleanupOldBuilds(client, bucket, manifest);

    const stats = buildStats(playlist, epg);
    console.log(
      `Refresh complete: ${stats.scanned} entries scanned, ${stats.selected} selected, ` +
        `${stats.channels} EPG channels, ${stats.epgProgrammes} programmes.`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    client.destroy();
  }
}

main().catch(() => {
  console.error("Refresh failed. Check the workflow configuration and upstream service availability.");
  process.exitCode = 1;
});
