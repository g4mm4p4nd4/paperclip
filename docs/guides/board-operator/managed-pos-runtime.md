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
- the tracked-tree digest includes the exact Git mode, path, and object ID for
  regular `100644`/`100755` blobs and `160000 commit` gitlinks only; every
  gitlink checkout path is an empty, non-symlink, mode-`0555` directory, so it
  cannot conceal executable or mutable content;
- the exact entrypoint, lock, registry, and schema-generation-specific
  contract allowlist agree with their source commit, including the byte-pinned
  managed-runtime schemas;
- a v2 package descriptor and runtime manifest bind the same immutable
  `provider_policy_authority` artifact; its canonical mode-`0444` descriptor
  identifies one exact D7 policy path/hash and policy-schema path/hash;
- the interpreter binary, Python identity, dependency versions, and installed
  dependency file aggregates agree with the immutable package descriptor;
- cache and output are distinct, canonical, trusted, writable directories
  outside the immutable package;
- the reconstructed closure SHA-256, package descriptor, and consumer runtime
  manifest agree exactly.

Validation is read-only. It does not build, promote, roll back, delete, or
repair a runtime.

Legacy v1 packages remain parseable only for a retained rollback target. They
have no provider-policy-authority binding, resolve with
`migrationOnly: true`, and are never eligible to launch a managed consumer. A
v2 selector is permitted to name a retained v1 pointer set after a rollback;
that state is reported as migration-only rather than being silently upgraded
or treated as a current v2 launch authority.

The resolver admits only these generation combinations:

| Selector | Pointer set | Current package | Previous package | Result |
| --- | --- | --- | --- | --- |
| v1 | v1 | v1 | v1 or absent | Migration-only |
| v2 | v2 | v2 | v1, v2, or absent | Authority-bound current runtime |
| v2 | v1 | v1 | v1 or absent | Exact retained-v1 rollback; migration-only |

Every other combination is rejected. In particular, a v1 pointer cannot gain
authority by selecting a v2 current or previous package, and a v2 pointer
cannot relabel a v1 package as its current authority.

## Narrow launch integration

Resolve immediately before the existing fenced attempt launch, and pass only
the resolver-selected manifest to the consumer runner:

```ts
import { resolveManagedPortfolioOsRuntime } from
  "../../services/managed-pos-runtime.js";
import { runPosConsumerAttempt } from "../../services/pos-consumer-runner.js";

const managed = await resolveManagedPortfolioOsRuntime({ runtimeRoot });

if (managed.migrationOnly || !managed.providerPolicyAuthority) {
  throw new Error("A legacy POS runtime is rollback-only and cannot launch a managed consumer");
}

const result = await runPosConsumerAttempt({
  ...attempt,
  runtimeManifestPath: managed.command.runtimeManifestPath,
  providerPolicyAuthorityPath: managed.providerPolicyAuthority.path,
});
```

The complete invocation binding is available for launch-authority and receipt
evidence:

```ts
managed.generation;
managed.selector;       // exact selector path and SHA-256
managed.pointerSet;     // exact content-addressed pointer set
managed.providerPolicyAuthority; // exact immutable D7 binding, or null for migration-only v1
managed.migrationOnly;  // true only for a legacy rollback-only v1 closure
managed.current;        // exact current package and manifest bindings
managed.previous;       // fully verified rollback target, or null
managed.command;        // executablePath, cwd, runtimeManifestPath and args
managed.writableRoots;  // separate cache and output roots
managed.toolchain;      // interpreter and dependency identity
```

Do not replace `managed.command.runtimeManifestPath` with a configuration value
or replace `managed.providerPolicyAuthority.path` with a configuration value
after resolution. If the selector changes concurrently, the returned selector,
pointer-set, and provider-policy-authority bindings identify the exact snapshot
used for that attempt.

## D7-to-D6 provider-policy handoff

Before building a new POS D6 package, publish the active immutable D7 policy
descriptor from the promoted Paperclip runtime:

```bash
pnpm ops:provider-policy-authority
```

It emits only non-secret binding data:

```json
{
  "schema_version": "paperclip.provider_policy_authority_publish.v1",
  "provider_policy_authority": {
    "path": "/absolute/managed-paperclip-runtime/authorities/provider-policy/<sha256>.json",
    "sha256": "<lowercase-64>"
  }
}
```

The active D7 policy must already have an immutable history copy at
`<policy-config-directory>/provider-policy-history/<active-policy-sha256>.json`.
The history copy must be mode `0444` and byte-identical to the active policy.
The publisher verifies that archive before emitting a descriptor and refuses a
missing or mismatched archive. The D7 package builder installs the archive
before sealing its immutable closure; Paperclip never creates or repairs it at
runtime.

Copy that exact pair into both the D6 package descriptor and D6 runtime
manifest as `provider_policy_authority`. Do not scan the D7 runtime directory,
read an environment variable, or retain a mutable `active.json` pointer. A POS
automation resolves its own active D6 selector, extracts this already-bound
pair from the verified runtime manifest, passes only `path` with
`--provider-policy-authority`, and validates its SHA-256 and the four policy
map fields before dispatch.

Resolver validity alone does not mean that a descriptor still names the
currently active policy. Factory health, live launch admission, proposal
creation, and proposal verification call `verifyProviderPolicyAuthority` with
the resolver-returned path and binding. That comparison is path- and
SHA-sensitive; a well-formed descriptor for a superseded policy fails closed
without consuming an approval.

## Verification

```bash
pnpm exec vitest run server/src/__tests__/managed-pos-runtime.test.ts
pnpm exec vitest run server/src/__tests__/provider-policy-authority.test.ts
pnpm --filter @paperclipai/server typecheck
```

The focused suite builds two producer-compatible packages entirely under a
temporary directory and covers selector symlinks, pointer authority/hash drift,
forged selector/pointer/package generation combinations, current and previous
permission drift, real Git commit entries, populated/writable/symlinked gitlink
paths, interpreter drift, manifest drift, hidden closure symlinks, and
writable-root symlinks. It never touches a live runtime selector.
