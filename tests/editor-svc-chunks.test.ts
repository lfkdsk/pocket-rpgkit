import { describe, expect, test } from "bun:test";
import {
  SERVICE_CHUNK_CHARS,
  ServiceMessageAssembler,
  chunkServiceMessage,
} from "../editor/engine/service-chunks.ts";

describe("editor service message chunks", () => {
  test("round-trips a Tuxemon-sized logical message through bounded lines", () => {
    const message = {
      t: "map-data",
      request: 17,
      entry: "maps/large.json",
      text: "x".repeat(300_000),
    };
    const lines = chunkServiceMessage(message, 9);
    expect(lines.length).toBeGreaterThan(2);
    expect(Math.max(...lines.map((line) => new TextEncoder().encode(line).length))).toBeLessThan(8192);

    const assembler = new ServiceMessageAssembler();
    let result: unknown;
    for (const line of lines) result = assembler.push(JSON.parse(line));
    expect(result).toEqual(message);
  });

  test("passes small messages through and drops malformed streams", () => {
    const assembler = new ServiceMessageAssembler();
    const direct = { t: "map-error", request: 1, entry: "maps/a.json", error: "missing" };
    expect(assembler.push(direct)).toBe(direct);

    expect(assembler.push({ t: "chunk-start", transfer: 2, chunks: 2 })).toBeUndefined();
    expect(assembler.push({ t: "chunk", transfer: 2, index: 1, text: "late" })).toBeUndefined();
    expect(assembler.push({ t: "chunk", transfer: 2, index: 0, text: "{}" })).toBeUndefined();

    expect(assembler.push({ t: "chunk-start", transfer: 3, chunks: 1 })).toBeUndefined();
    expect(assembler.push({
      t: "chunk",
      transfer: 3,
      index: 0,
      text: "x".repeat(SERVICE_CHUNK_CHARS + 1),
    })).toBeUndefined();
  });
});
