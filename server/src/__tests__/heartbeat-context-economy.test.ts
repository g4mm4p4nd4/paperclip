import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPaperclipContextEconomyHint,
  resolvePaperclipContextEconomyCwd,
} from "../services/heartbeat.ts";

describe("heartbeat context economy envelope", () => {
  const previousContextPacksDir = process.env.PAPERCLIP_CONTEXT_PACKS_DIR;
  const tempRoots: string[] = [];

  afterEach(async () => {
    if (previousContextPacksDir === undefined) delete process.env.PAPERCLIP_CONTEXT_PACKS_DIR;
    else process.env.PAPERCLIP_CONTEXT_PACKS_DIR = previousContextPacksDir;
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("uses configured cwd for context packs when the execution workspace is an agent_home fallback", () => {
    expect(
      resolvePaperclipContextEconomyCwd({
        executionWorkspace: {
          cwd: "/Users/mnm/.paperclip/instances/default/workspaces/agent-1",
          source: "agent_home",
        },
        resolvedConfig: {
          cwd: "/Users/mnm/Documents/Github/LeadForge",
        },
      }),
    ).toBe("/Users/mnm/Documents/Github/LeadForge");

    expect(
      resolvePaperclipContextEconomyCwd({
        executionWorkspace: {
          cwd: "/Users/mnm/.paperclip/instances/default/workspaces/agent-1",
          source: "agent_home",
        },
        resolvedConfig: {},
      }),
    ).toBe("/Users/mnm/.paperclip/instances/default/workspaces/agent-1");
  });

  it("builds hash-backed pack provenance from the context pack manifest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-context-packs-"));
    tempRoots.push(root);
    const repoRoot = path.join(root, "LeadForge");
    const packsDir = path.join(root, "packs");
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.mkdir(packsDir, { recursive: true });

    const manifestPath = path.join(root, "latest.json");
    const generatedAt = new Date().toISOString();
    const manifest = {
      generatedAt,
      repos: {
        leadforge: {
          slug: "leadforge",
          generatedAt,
          repoState: {
            cwd: repoRoot,
            branch: "main",
            head: "abc1234",
            statusShort: [" M client/src/lib/flywheel-canary.ts"],
          },
          profiles: {
            map: {
              latestPath: path.join(packsDir, "leadforge-map-latest.md"),
              estimatedTokens: 2734,
              sha256: "a".repeat(64),
            },
            delta: {
              latestPath: path.join(packsDir, "leadforge-delta-latest.md"),
              estimatedTokens: 4802,
              sha256: "b".repeat(64),
            },
            core: {
              latestPath: path.join(packsDir, "leadforge-core-latest.md"),
              estimatedTokens: 159424,
              sha256: "c".repeat(64),
            },
          },
        },
      },
    };
    const manifestContents = JSON.stringify(manifest);
    await fs.writeFile(manifestPath, manifestContents, "utf8");
    process.env.PAPERCLIP_CONTEXT_PACKS_DIR = root;

    const hint = await buildPaperclipContextEconomyHint(repoRoot);

    expect(hint).toMatchObject({
      mode: "map_first",
      repoKey: "leadforge",
      repoSlug: "leadforge",
      manifestPath,
      manifestSha: createHash("sha256").update(manifestContents).digest("hex"),
      packHead: "abc1234",
      packBranch: "main",
      dirtyCount: 1,
      freshnessStatus: "fresh",
      packs: {
        map: path.join(packsDir, "leadforge-map-latest.md"),
        delta: path.join(packsDir, "leadforge-delta-latest.md"),
        core: path.join(packsDir, "leadforge-core-latest.md"),
      },
      packShas: {
        map: "a".repeat(64),
        delta: "b".repeat(64),
        core: "c".repeat(64),
      },
      estimatedTokens: {
        map: 2734,
        delta: 4802,
        core: 159424,
      },
    });
  });
});
