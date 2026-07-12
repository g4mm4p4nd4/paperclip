# Profit Flywheel work-bearing canary

This runbook covers the live fixture cycle after fleet migration and before
normal unattended schedules are restored. It separates three authorities:

1. Paperclip creates the run-bound project/workspace and resumes only
   Engineer-1.
2. Portfolio OS generates the built-in fixture/profit-canary dispatch, and the
   secure promotion operator publishes it.
3. Paperclip's read-only closeout operator proves the completed cycle and next
   bounded research iteration from canonical rows and immutable artifacts.

Each provider-owned stage transition is a distinct execution epoch. If the
next stage is authorized while the prior heartbeat is still finalizing,
Paperclip queues a deferred issue execution keyed by the new
`profitFlywheelStageRunId`; it must never merge QA or release authority into
the finishing implementation run.

The v2 implementation issue has no generic issue execution policy. The
Profit Flywheel contract already owns independent QA and release; adding the
normal board review/approval policy would create a second workflow authority,
reassign the issue to possibly paused participants, and race the stage runner.

None of these commands accepts a database URL, bearer token, API key, password,
or connection string on argv. Setup and closeout require the selected
PAPERCLIP_HOME / PAPERCLIP_INSTANCE_ID to use embedded PostgreSQL. Pre-create
the receipt directory as owner-controlled and non-group/world-writable. The
operators verify and fsync its complete trusted hierarchy before installing a
receipt.

## 1. Set up the exact fixture project

Choose a safe, unique RUN_ID. Project and workspace UUIDs are deterministically
derived from (company_id, run_id), so replay is idempotent and conflicts fail
closed.

    export PAPERCLIP_HOME=/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit
    export PAPERCLIP_INSTANCE_ID=default
    RUN_ID="profit-flywheel-e2e-$(date -u +%Y%m%dT%H%M%SZ)"
    COMPANY_ID=216897d4-0f94-4736-9b6b-a20c8e48d694
    ENGINEER_ID=35014584-00ed-4dd1-a822-f6119db5af1d
    RECEIPT_DIR="$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID/data/ops/flywheel-repair/runs"

    pnpm ops:profit-flywheel-canary-fixture -- setup \
      --company-id "$COMPANY_ID" \
      --engineer-agent-id "$ENGINEER_ID" \
      --run-id "$RUN_ID" \
      --portfolio-os-root /Users/mnm/Documents/Github/portfolio-os \
      --receipt-dir "$RECEIPT_DIR"

The operator requires exactly the supplied agent id, company id, and name
Engineer-1. Only paused to idle is changed. It records the original status,
creates or verifies the deterministic project and exact primary workspace
under data/canary_runs/RUN_ID/target/profit-canary, and writes a mode-0444
receipt. It does not contact the API server or read credentials.

Before changing any database row, setup durably installs a mode-0444
`RUN_ID-fixture-setup-intent.json` that pins the complete mutation plan and
final receipt path. If the process exits after the transaction commits but
before the final receipt is installed, rerun the identical setup command: it
verifies the intent and exact rows, installs the same final receipt, and does
not duplicate the resume activity. A conflicting final receipt fails before
project, workspace, or agent state can be changed.

Use the returned projectId when generating the POS fixture. Promotion uses the
separately documented secure broker:
[Profit Flywheel fixture promotion](./profit-flywheel-fixture-promotion.md).

## 2. Canonical implementation artifact hash

The immutable implementation execution manifest includes
target_artifact_hash_authority and explicit implementation completion
requirements. The agent must first commit every declared change on
`manifest.workspace.run_branch`, verify that `git rev-parse HEAD` is that
commit, and leave `git status --porcelain` empty outside `.paperclip`. A tree
written from the index, staged-but-uncommitted files, or a patch object is not
a valid target. After the implementation commit exists, replace
only the target_git_object placeholder in the pinned helper argv:

    /usr/bin/env TMPDIR=/tmp pnpm --dir /Users/mnm/Documents/Github/paperclip ops:git-object-sha256 -- \
      --repo /absolute/canonical/target/workspace \
      --object '<full-target-commit-id>'

Copy the JSON sha256 field into workspace.target_artifact_hash. The hash is
SHA-256 over the raw bytes:

    <git-object-type> <body-byte-length>\0<body>

The pinned `/tmp` override keeps `tsx`'s local IPC socket below Unix-domain
path-length limits even when the provider runtime home is deeply nested. The
length is the raw body byte length. The Git object id, rendered git-show
text, patch bytes, and SHA-256(body-only) are not equivalent. The helper
supports blob, tree, commit, and annotated-tag objects without text
transcoding. The manifest pins Paperclip's absolute repository directory in
argv, so the command is executable from the target workspace without guessing
or changing directory. The frozen paperclip.profit_flywheel_stage_work_result.v1
schema is unchanged.

## 3. Close out the completed cycle

Read exact IDs from workflow/stage records; do not select latest. Closeout
requires every identity explicitly:

    pnpm ops:profit-flywheel-canary-closeout -- \
      --company-id "$COMPANY_ID" \
      --run-id "$RUN_ID" \
      --correlation-id "profit-canary:$RUN_ID" \
      --project-id '<fixture-project-uuid>' \
      --workflow-id '<workflow-uuid>' \
      --issue-id '<completed-implementation-issue-uuid>' \
      --implementation-stage-run-id '<implementation-uuid>' \
      --qa-stage-run-id '<qa-uuid>' \
      --release-stage-run-id '<release-uuid>' \
      --observation-stage-run-id '<commercial-observation-uuid>' \
      --learning-stage-run-id '<learning-uuid>' \
      --next-research-stage-run-id '<next-research-intake-uuid>' \
      --setup-receipt "$RECEIPT_DIR/$RUN_ID-fixture-setup.json" \
      --promotion-receipt '<exact-promotion-aggregate-receipt-path>' \
      --receipt-dir "$RECEIPT_DIR"

The setup and promotion paths are explicit authority inputs. Never select a
`latest` symlink, newest directory entry, or glob result. The operator reads
each authority artifact once through a no-follow file descriptor, pins those
exact bytes and hashes in the closeout, and rejects an unsafe owner/mode anywhere
in the parent hierarchy.

The operator performs database reads plus local Git reads only. The fixture
release origin must be the exact credential-free `file:` URL from setup and
promotion; arbitrary network release origins are rejected before the shared
completion validator runs. It fails
closed unless:

- company/run/correlation/project/workflow/issue identities match exactly;
- setup, Portfolio OS canary, source dispatch, promotion, observation, workflow,
  project, and primary-workspace identities and hashes form one exact baseline;
- the persisted contract path/hash/snapshot equals the freshly loaded pinned
  contract and every stage retains its canonical owner, input, retry,
  concurrency, receipt, and completion-evidence definition;
- the issue is done;
- implementation, QA, release, observation, and learning succeeded and form
  one exact transition chain;
- each stage-required receipt has one canonical, unexpired database body and a
  currently immutable hash-matching artifact;
- implementation and QA test results explicitly pass and every test result
  artifact is independently reverified;
- QA is a passed review from a provider family different from the builder, and
  the QA review binding equals the verified review receipt;
- the implementation base and target are distinct commits, the target descends
  from the exact dispatch base, and the nonempty base-to-target changed-file set
  exactly equals the implementation receipt with Git replacement objects and
  ambient system/global Git config disabled;
- the exact local release origin and `refs/heads/main` each resolve through one
  `ls-remote` row to the implementation object;
- observation and learning bind measured evidence;
- the full owner-controlled next-research authority file matches learning,
  its frozen schema and source registry, and remains unexpired at the final
  closeout clock; and
- exactly one unprocessed, pending research_intake stage/event follows learning
  at the authority not-before time.

The successful mode-0444 receipt reports
work_bearing_cycle_closed_next_research_pending. This is deliberately not a
terminal workflow state. Correct control-plane state is running with
current_stage research_intake because learning opened the next bounded
research iteration.

## 4. Restore the pre-canary agent status

After closeout, use the immutable setup receipt rollback argv. Rollback
re-verifies the exact project/workspace and refuses while Engineer-1 is outside
idle or paused. If setup changed paused to idle, it restores paused; a
pre-existing idle status stays idle. Project/workspace evidence is preserved.

    pnpm ops:profit-flywheel-canary-fixture -- rollback \
      --setup-receipt "$RECEIPT_DIR/$RUN_ID-fixture-setup.json" \
      --receipt-dir "$RECEIPT_DIR"

Setup/resume and rollback/re-pause write company-scoped activity entries.
Closeout remains read-only apart from installing its immutable receipt.

## Focused verification

    RUN_LOG_BASE_PATH="$(mktemp -d)" pnpm exec vitest run \
      server/src/__tests__/profit-flywheel-canary-fixture.test.ts \
      server/src/__tests__/profit-flywheel-canary-completeness.test.ts
    pnpm --filter @paperclipai/server typecheck
    git diff --check
