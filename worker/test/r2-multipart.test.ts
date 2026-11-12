import { describe, expect, it, vi } from "vitest";
import { createMultipartObjectWriter } from "../src/r2-multipart";

describe("R2 multipart output", () => {
  it("uploads uniform 5 MiB parts and a smaller final part", async () => {
    const uploaded: Array<{ number: number; size: number }> = [];
    const complete = vi.fn(async (_parts: R2UploadedPart[]) => ({}) as R2Object);
    const upload = {
      uploadPart: vi.fn(async (number: number, value: ArrayBufferView) => {
        uploaded.push({ number, size: value.byteLength });
        return { partNumber: number, etag: `part-${number}` };
      }),
      complete,
      abort: vi.fn(async () => undefined),
    } as unknown as R2MultipartUpload;
    const bucket = {
      createMultipartUpload: vi.fn(async () => upload),
    } as unknown as R2Bucket;

    const output = await createMultipartObjectWriter(bucket, "builds/fake/epg.xml", "application/xml");
    await output.writer.write(new Uint8Array(3 * 1024 * 1024));
    await output.writer.write(new Uint8Array(3 * 1024 * 1024));
    await output.writer.close();

    expect(uploaded).toEqual([
      { number: 1, size: 5 * 1024 * 1024 },
      { number: 2, size: 1 * 1024 * 1024 },
    ]);
    expect(complete).toHaveBeenCalledWith([
      { partNumber: 1, etag: "part-1" },
      { partNumber: 2, etag: "part-2" },
    ]);
  });
});
