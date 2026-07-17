# Managed Portfolio OS runtime resolution

Paperclip must resolve a managed Portfolio OS runtime from the runtime store's
atomic selector. A caller-supplied executable or manifest is not runtime
authority.

## Trust boundary

`resolveManagedPortfolioOsRuntime({ runtimeRoot })` derives exactly one entry
point:

```text
<runtimeRoot>/control/active.json
```

The resolver then fails closed unless all of the following remain true:

- the selector is canonical, mode `0444`, non-symlink JSON;
- its pointer-set binding resolves to
  `control/pointer-sets/<declared-sha256>.json` with matching bytes;
- current and previous targets, when present, resolve only to
  `packages/<closure-sha256>`;
- both packages have exact `0444`/`0555` permissions, no symlinks or special
  files, clean detached Git provenance, and only the three producer-owned
  ignored runtime files;
- the exact entrypoint, lock, registry, and 17-contract allowlist agree with
  their source commit, including the five byte-pinned managed-runtime schemas;
- the interpreter binary, Python identity, dependency versions, and installed
  dependency file aggregates agree with the immutable package descriptor;
- cache and output are distinct, canonical, trusted, writable directories
  outside the immutable package;
- the reconstructed closure SHA-256, package descriptor, and consumer runtime
  manifest agree exactly.

Validation is read-only. It does not build, promote, roll back, delete, or
repair a runtime.

## Narrow launch integration

Resolve immediately before the existing fenced attempt launch, and pass only
the resolver-selected manifest to the consumer runner:

```ts
import { resolveManagedPortfolioOsRuntime } from
  "../../services/managed-pos-runtime.js";
import { runPosConsumerAttempt } from "../../services/pos-consumer-runner.js";

const managed = await resolveManagedPortfolioOsRuntime({ runtimeRoot });

const result = await runPosConsumerAttempt({
  ...attempt,
  runtimeManifestPath: managed.command.runtimeManifestPath,
});
```

The complete invocation binding is available for launch-authority and receipt
evidence:

```ts
managed.generation;
managed.selector;       // exact selector path and SHA-256
managed.pointerSet;     // exact content-addressed pointer set
managed.current;        // exact current package and manifest bindings
managed.previous;       // fully verified rollback target, or null
managed.command;        // executablePath, cwd, runtimeManifestPath and args
managed.writableRoots;  // separate cache and output roots
managed.toolchain;      // interpreter and dependency identity
```

Do not replace `managed.command.runtimeManifestPath` with a configuration value
after resolution. If the selector changes concurrently, the returned selector
and pointer-set bindings identify the exact snapshot used for that attempt.

## Verification

```bash
pnpm exec vitest run server/src/__tests__/managed-pos-runtime.test.ts
pnpm --filter @paperclipai/server typecheck
```

The focused suite builds two producer-compatible packages entirely under a
temporary directory and covers selector symlinks, pointer authority/hash drift,
current and previous permission drift, interpreter drift, manifest drift,
hidden closure symlinks, and writable-root symlinks. It never touches a live
runtime selector.
