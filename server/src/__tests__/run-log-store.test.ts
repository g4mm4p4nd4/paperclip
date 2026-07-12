import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRunLogStore, resetRunLogStoreForTests } from "../services/run-log-store.ts";

describe("run log store", () => {
  const tempDirs = new Set<string>();

  afterEach(async () => {
    resetRunLogStoreForTests();
    delete process.env.RUN_LOG_BASE_PATH;
    await Promise.all(Array.from(tempDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
  });

  async function createStore() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-store-"));
    tempDirs.add(dir);
    process.env.RUN_LOG_BASE_PATH = dir;
    resetRunLogStoreForTests();
    return { store: getRunLogStore(), dir };
  }

  it("compacts repeated message_update snapshots while preserving the final snapshot", async () => {
    const { store } = await createStore();
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    const base = "Planning ".repeat(700);
    const snapshots = [
      base,
      `${base}\nReading files`,
      `${base}\nReading files\nApplying patch`,
      `${base}\nReading files\nApplying patch\nTests pass`,
    ].map((text) => JSON.stringify({ type: "message_update", message: { role: "assistant", content: text } }));

    for (const [index, chunk] of snapshots.entries()) {
      await store.append(handle, {
        ts: `2026-06-03T12:00:0${index}.000Z`,
        stream: "stdout",
        chunk,
      });
    }
    const rawBytes = snapshots.reduce((sum, snapshot) => sum + Buffer.byteLength(`${JSON.stringify({
      ts: "2026-06-03T12:00:00.000Z",
      stream: "stdout",
      chunk: snapshot,
    })}\n`, "utf8"), 0);

    const summary = await store.finalize(handle);
    const read = await store.read(handle, { limitBytes: 1_000_000 });
    const lines = read.content.trim().split("\n").map((line) => JSON.parse(line));

    expect(summary.compaction).toMatchObject({
      compactedSnapshots: 3,
      finalSnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(summary.compaction?.originalBytes).toBeGreaterThan(summary.bytes);
    expect(summary.bytes).toBeLessThan(rawBytes);
    expect(lines.some((line) => line.compaction?.type === "message_update_delta")).toBe(true);
    expect(lines.at(-1)).toMatchObject({
      chunk: snapshots.at(-1),
      compaction: {
        type: "message_update_final_snapshot",
        compactedSnapshots: 3,
      },
    });
  });

  it("redacts recognized credential shapes at the final persistence boundary", async () => {
    const { store } = await createStore();
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-secret-sink",
    });
    const syntheticJwt = [`eyJ${"a".repeat(12)}`, "b".repeat(12), "c".repeat(12)].join(".");

    await store.append(handle, {
      ts: "2026-07-12T08:30:00.000Z",
      stream: "stderr",
      chunk: `provider rejected Bearer ${syntheticJwt}`,
    });

    await store.finalize(handle);
    const read = await store.read(handle, { limitBytes: 1_000_000 });
    expect(read.content).not.toContain(syntheticJwt);
    expect(read.content).toContain("***REDACTED***");
  });
});
