// Transparent chunk envelopes for the JSON-line editor companion protocol.
// PocketJS caps portable service control lines at 8 KiB, while a large map
// shard can be hundreds of KiB. Logical messages stay JSON; only transport
// framing is split and reassembled here.

export const SERVICE_CHUNK_CHARS = 1024;
export const SERVICE_MAX_CHUNKS = 8192;
export const SERVICE_MAX_MESSAGE_CHARS = 8 * 1024 * 1024;

interface ChunkStart {
  t: "chunk-start";
  transfer: number;
  chunks: number;
}

interface ChunkPart {
  t: "chunk";
  transfer: number;
  index: number;
  text: string;
}

interface IncomingChunks {
  chunks: number;
  length: number;
  parts: string[];
}

const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Split a logical JSON message into control lines that stay below every
 * PocketJS service transport's 8 KiB control-line ceiling. */
export function chunkServiceMessage(value: unknown, transfer: number): string[] {
  const raw = JSON.stringify(value);
  if (raw.length <= SERVICE_CHUNK_CHARS) return [raw];
  const chunks = Math.ceil(raw.length / SERVICE_CHUNK_CHARS);
  if (!safeInteger(transfer) || chunks > SERVICE_MAX_CHUNKS || raw.length > SERVICE_MAX_MESSAGE_CHARS) {
    throw new Error("editor service message exceeds the chunk transport limit");
  }
  const lines = [JSON.stringify({ t: "chunk-start", transfer, chunks } satisfies ChunkStart)];
  for (let index = 0; index < chunks; index++) {
    lines.push(JSON.stringify({
      t: "chunk",
      transfer,
      index,
      text: raw.slice(index * SERVICE_CHUNK_CHARS, (index + 1) * SERVICE_CHUNK_CHARS),
    } satisfies ChunkPart));
  }
  return lines;
}

/** Reassemble chunk envelopes into their original parsed JSON value. Bad,
 * duplicate, or out-of-order streams are discarded without retaining bytes. */
export class ServiceMessageAssembler {
  private readonly incoming = new Map<number, IncomingChunks>();

  push(value: unknown): unknown | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const message = value as Record<string, unknown>;
    if (message.t === "chunk-start") {
      if (!safeInteger(message.transfer) || !safeInteger(message.chunks) ||
        message.chunks < 1 || message.chunks > SERVICE_MAX_CHUNKS) return undefined;
      if (!this.incoming.has(message.transfer) && this.incoming.size >= 4) this.incoming.clear();
      this.incoming.set(message.transfer, { chunks: message.chunks, length: 0, parts: [] });
      return undefined;
    }
    if (message.t !== "chunk") return value;
    if (!safeInteger(message.transfer) || !safeInteger(message.index) || typeof message.text !== "string") {
      return undefined;
    }
    const pending = this.incoming.get(message.transfer);
    if (!pending || message.index !== pending.parts.length || message.text.length > SERVICE_CHUNK_CHARS) {
      this.incoming.delete(message.transfer);
      return undefined;
    }
    pending.length += message.text.length;
    if (pending.length > SERVICE_MAX_MESSAGE_CHARS || pending.parts.length >= pending.chunks) {
      this.incoming.delete(message.transfer);
      return undefined;
    }
    pending.parts.push(message.text);
    if (pending.parts.length !== pending.chunks) return undefined;
    this.incoming.delete(message.transfer);
    try {
      return JSON.parse(pending.parts.join("")) as unknown;
    } catch {
      return undefined;
    }
  }
}
