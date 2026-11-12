const PART_SIZE = 5 * 1024 * 1024;

export interface MultipartObjectWriter {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  abort(reason?: unknown): Promise<void>;
}

export async function createMultipartObjectWriter(
  bucket: R2Bucket,
  key: string,
  contentType: string,
): Promise<MultipartObjectWriter> {
  const upload = await bucket.createMultipartUpload(key, {
    httpMetadata: { contentType },
  });
  const chunks: Uint8Array[] = [];
  const uploadedParts: R2UploadedPart[] = [];
  let bufferedBytes = 0;
  let chunkIndex = 0;
  let partNumber = 1;
  let aborted = false;

  const takeBytes = (length: number): Uint8Array => {
    const output = new Uint8Array(length);
    let outputOffset = 0;
    while (outputOffset < length) {
      const chunk = chunks[chunkIndex];
      const needed = length - outputOffset;
      const copied = Math.min(needed, chunk.byteLength);
      output.set(chunk.subarray(0, copied), outputOffset);
      outputOffset += copied;
      if (copied === chunk.byteLength) chunkIndex += 1;
      else chunks[chunkIndex] = chunk.subarray(copied);
    }
    if (chunkIndex > 1024) {
      chunks.splice(0, chunkIndex);
      chunkIndex = 0;
    }
    bufferedBytes -= length;
    return output;
  };

  const uploadBufferedPart = async (length: number): Promise<void> => {
    uploadedParts.push(await upload.uploadPart(partNumber, takeBytes(length)));
    partNumber += 1;
  };

  const stream = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (chunk.byteLength === 0) return;
      chunks.push(chunk.slice());
      bufferedBytes += chunk.byteLength;
      while (bufferedBytes >= PART_SIZE) await uploadBufferedPart(PART_SIZE);
    },
    async close() {
      if (bufferedBytes > 0) await uploadBufferedPart(bufferedBytes);
      await upload.complete(uploadedParts);
    },
    async abort() {
      if (aborted) return;
      aborted = true;
      await upload.abort();
    },
  });
  const writer = stream.getWriter();

  return {
    writer,
    async abort(reason?: unknown) {
      if (aborted) return;
      aborted = true;
      await upload.abort().catch(() => undefined);
      await writer.abort(reason).catch(() => undefined);
    },
  };
}
