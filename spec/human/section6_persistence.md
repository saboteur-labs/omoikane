# Section 6 — Persistence Model

> This section specifies the hybrid YAML + SQLite persistence model: what
> lives where, why, and the contract that keeps the two representations in
> sync. The rendering layer is also covered — it reads YAML directly and
> has no database dependency.
>
> Machine-readable definitions: `spec/machine/persistence/model.yaml`

---

## 6.1 The Decision: Hybrid YAML + SQLite

Omoikane uses two storage layers. They are not redundant — each does something
the other cannot do well.

**YAML is the canonical source of truth.** Every document, gap file, prompt
entry, learning brief, and outline is a YAML file tracked in git. If the
SQLite database is deleted, corrupted, or simply absent, nothing is lost.
The database is rebuilt from YAML.

**SQLite is the working index.** It is built from YAML and used for operations
that would be slow or awkward as full-directory scans: cross-document signal
aggregation, gap analysis across the full repo, the Cartographer's
multi-document queries, and the two-signal threshold calculation for refine.

Neither layer replaces the other. Together they give git-friendliness,
human readability, and efficient query performance.

### Why not pure SQLite

SQLite produces binary files. Binary diffs are meaningless in git. Merge
conflicts are unresolvable. The collaboration model (phase 4) requires that
researchers can fork repos, pull from each other, and diff their work in a
standard git interface. A binary database breaks all of this.

SQLite also prevents the external rendering layer from working without
tooling. Any application that wants to read an Omoikane knowledge base
should be able to open YAML files directly — it should not need to install
Omoikane or run a server.

### Why not pure YAML

Pure YAML is insufficient at scale for relational queries. The signal
aggregator must count independent signal events per prompt across all
documents in the repo. The Cartographer must find all claims that contradict
each other across all documents. The checkpoint registry must efficiently
query all open checkpoints. These are naturally SQL queries. Implementing
them as full-directory scans of YAML files is possible for small repos,
but degrades poorly as the repo grows and would make refine and gaps
prohibitively slow on a repo with dozens of gathered nodes.

Atomic writes are a second reason. A `resolve` action that corrects a claim
must update the claim status in the document file, append to signal history,
update the checkpoint registry in the manifest, and potentially flag a
document as stale. These changes should succeed or fail together — not leave
the repo in a partially-updated state if interrupted. SQLite transactions
provide this guarantee; a sequence of YAML file writes does not.

---

## 6.2 YAML as the Canonical Source of Truth

Every persistent object is a YAML file. The YAML is always authoritative.
When the SQLite index and the YAML files disagree, the YAML is correct and
the index must be rebuilt.

**What this means in practice:**

- Researchers can inspect any repo object with a text editor. No tooling
  required to read the knowledge base.
- Git tracks all changes. Every gather run, correction, and gap document
  is in version history.
- Merge conflicts are resolvable with standard git tooling. YAML diffs
  are human-readable.
- The database is always throwaway. `omoikane repo reindex` recreates it
  from scratch from the YAML files.

**What YAML does not do:**

YAML does not enforce referential integrity between files at write time.
A document file that references a claim ID that does not exist will not
cause a write-time error — it will cause a `reindex` warning. The runner
validates references when loading objects (see `manifest.yaml` validation
rules), but the YAML files themselves have no enforcement mechanism. This
is a known limitation; the SQLite index enforces referential integrity at
query time.

---

## 6.3 SQLite as the Working Index

The SQLite database lives at `.omoikane/omoikane.db` within each knowledge
repo. It is gitignored — it is never committed or shared. Each researcher
builds it from YAML when they need it.

**What the index stores:**

The index is not a mirror of the full YAML content. It stores the subset
of data needed for efficient queries:

- **Claim index**: claim IDs, document IDs, claim type, source tier, confidence
  level, status. Used by the Cartographer for cross-document analysis and by
  the Auditor for full-repo claim lookups.
- **Signal history index**: signal events keyed by prompt ID, type, and date.
  Used by the signal aggregator to compute per-prompt signal counts and the
  two-signal threshold.
- **Checkpoint index**: open checkpoints keyed by type, affected object, and
  date. Used by `omoikane review` for fast retrieval and ordering.
- **Document metadata index**: document IDs, node IDs, status, prompt ID,
  generation, adapter, date. Used by the runner for status queries and by
  the Cartographer for provenance analysis.
- **Gap document index**: gap IDs, nature, status, node ID. Used by the
  Cartographer for gap analysis and ceiling detection.
- **Prompt library index**: prompt IDs, type, target, status, generation,
  parent. Used by the Methodologist for lineage traversal.

**What the index does not store:**

- Full claim content (the `content` field of claims)
- Full document text
- Prompt question text
- User notes

These fields are read directly from YAML when needed. The index stores
references and metadata, not content.

**Atomic writes via transactions:**

Every multi-step state mutation is executed as a SQLite transaction. If any
step fails, the transaction rolls back and the YAML files are not written.
This ensures YAML and SQLite remain consistent. Examples of multi-step
mutations that use transactions:

- `omoikane claim correct`: update claim status → append signal history entry
  → update checkpoint registry → optionally flag document as stale
- Promote prompt: deprecate active prompt → activate candidate → record
  signal event → flag older documents as staleness candidates

**The database is not the source of truth for rendering.** Applications that
render Omoikane knowledge bases read YAML directly. The SQLite index is
an internal runner tool and is not part of the public interface.

---

## 6.4 The Reindex Contract

`omoikane repo reindex` rebuilds the SQLite index from scratch from the YAML
files. It is always safe to run — it cannot lose data (data lives in YAML).

**When to run reindex:**

- After pulling changes from a remote repo
- After resolving a git merge conflict
- After suspecting database corruption (e.g. a crash mid-write)
- After manually editing YAML files outside the CLI (the index will be stale)
- On a fresh clone (the database is gitignored and will not be present)

**What reindex does:**

1. Drops all existing index tables
2. Reads all YAML files in the knowledge repo in defined order
3. Validates all ID references (dangling references are logged as warnings,
   not errors — they do not block reindex)
4. Populates all index tables
5. Runs integrity checks (single active document per node, monotonic version
   counters, etc.)
6. Reports a summary: files read, records indexed, warnings produced

**Reindex is idempotent.** Running it twice produces the same result as
running it once.

**Reindex does not repair YAML.** If a YAML file contains invalid data
(a claim missing `source.tier`, for example), reindex logs the error and
skips that record. It does not modify the YAML file. Repair requires manual
correction or re-running the command that produced the bad file.

---

## 6.5 Knowledge Repo File Layout

A fully-populated knowledge repo has this structure:

```
<knowledge-repo>/
  manifest.yaml                  # spine of the repo — one file, always present
  outline.yaml                   # current outline
  learning_brief.yaml            # produced by omoikane repo init
  documents/
    <node-id>/
      <doc-id>.yaml              # one file per gather run
      <doc-id>.yaml              # superseded documents remain here
  gaps/
    <gap-id>.yaml                # one file per gap document
  prompts/
    <prompt-id>.yaml             # one file per prompt entry (all statuses)
  reports/
    challenge/
      <report-id>.yaml           # Critic challenge reports
    verification/
      <report-id>.yaml           # Auditor verification reports
    gaps/
      <report-id>.yaml           # Cartographer gaps reports
    refinement/
      <report-id>.yaml           # Methodologist refinement reports
  .omoikane/
    config.yaml                  # adapter + model selection per agent role
    omoikane.db                  # GITIGNORED — SQLite working index
    smoke_tests.yaml             # smoke test results with timestamps
    checkpoint_history.yaml      # resolved checkpoints (append-only)
```

**Naming conventions:**

- Document IDs: `doc-<node-id>-<YYYYMMDD>-<seq>` (e.g. `doc-node-003-20260118-01`)
- Gap IDs: `gap-<YYYYMMDD>-<seq>` (e.g. `gap-20260118-01`)
- Prompt IDs: `p-<type>-<generation>-<seq>` (e.g. `p-gather-003-01`)
- Report IDs: `<role>-<YYYYMMDD>-<seq>` (e.g. `critic-20260118-01`)

These are conventions, not enforced formats. Any unique string is valid.
Conventions aid human inspection; the runner operates on IDs, not names.

**What is gitignored:**

- `.omoikane/omoikane.db` — always rebuildable
- `spec/dist/` — rendered docx files (Omoikane project repo only)

Everything else is git-tracked.

---

## 6.6 Atomic Write Guarantee

Multi-step mutations must succeed or fail atomically. A mutation that
partially succeeds leaves the repo in inconsistent state.

**How atomicity is achieved:**

1. The SQLite transaction is prepared first (but not committed)
2. YAML files are written to temporary paths
3. The SQLite transaction is committed
4. Temporary YAML files are renamed to their final paths (atomic on POSIX)
5. If any step fails before step 4, the transaction is rolled back and
   temporary files are deleted — no visible change to the repo

**Trade-off:** This approach writes YAML to temporary paths first, which
means a crash between step 3 (SQLite committed) and step 4 (YAML renamed)
would leave the SQLite index ahead of the YAML files. `omoikane repo reindex`
detects and resolves this — it is the defined recovery mechanism for this
failure mode. The alternative (writing YAML first) would leave YAML ahead
of the index on failure, which is also recoverable via reindex. Both orderings
are recoverable; YAML-after-SQLite was chosen because SQLite transaction commit
is the harder guarantee to achieve.

**Single-writer constraint:** The state manager holds a file lock on
`manifest.yaml` during any write operation (see section 5.2.2). This prevents
concurrent CLI invocations on the same repo from producing interleaved writes.
The lock is advisory — a process that ignores it can still write. This is
acceptable because the CLI is the only intended writer; raw file edits outside
the CLI are a researcher's deliberate choice and documented as requiring a
subsequent `reindex`.

---

## 6.7 Git-Friendliness as a Design Constraint

Git-friendliness is not a preference — it is a hard constraint that the
persistence model was designed around. The collaboration model (section 7)
requires it.

**What git-friendliness requires:**

- All canonical data is in text files with human-readable diffs
- Binary files (SQLite) are gitignored
- Merge conflicts are resolvable by a developer familiar with the schema
- The repo can be cloned, forked, and pulled without any Omoikane-specific
  merge tooling

**How the current design achieves this:**

YAML files produce meaningful diffs. A `git diff` on a corrected claim shows
exactly which field changed and what the old and new values were. A `git log`
on a document file shows the full history of gather runs on that node.

The one area where git merges require care: the manifest. Because the manifest
is a single file tracking all repo state, two researchers working in parallel
will produce conflicting manifest updates. This is a known limitation that
phase 4 (collaboration) addresses with explicit conflict resolution tooling.
For single-researcher use (phases 1–3), the manifest is written by one person
and this conflict does not arise.

---

## 6.8 External Rendering Layer

Applications that render or consume Omoikane knowledge bases read YAML
directly. They have no dependency on the SQLite index and no dependency on
the Omoikane CLI being installed.

**What this enables:**

- A docx generator reads `documents/` and `gaps/` YAML and produces a
  structured document. It does not need the runner.
- An IDE plugin can display claim provenance by reading the YAML directly.
- A researcher can write a custom script to query the knowledge base using
  any YAML library.
- Phase 4 collaboration tools can operate on YAML without reimplementing
  the Omoikane runner.

**The rendering contract:** The YAML schema is the public interface of an
Omoikane knowledge repo. Schema version fields on every object allow
consuming applications to handle multiple schema versions. The runner's
`omoikane repo reindex` command is the migration tool for existing repos
when the schema changes.

---

*Next section: `spec/human/section7_roadmap.md`*
