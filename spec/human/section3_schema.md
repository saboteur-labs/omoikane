# Section 3 — Schema

> This section defines the five core data objects: the repo manifest, the
> document block, the claim block, the gap document, and the prompt entry.
> These objects are the persistent state of a knowledge repo. Every agent
> reads from and writes to instances of these objects.
>
> Machine-readable definitions: `spec/machine/schema/`

---

## 3.1 Overview

The schema has three layers of content plus a fifth object for the prompt library.

| Object | File pattern | Produced by | Read by |
|--------|-------------|-------------|---------|
| Repo manifest | `manifest.yaml` | Runner (init, all mutations) | All agents |
| Document block | `documents/<node-id>/<doc-id>.yaml` | Scribe | Critic, Auditor, Cartographer |
| Claim block | Embedded in document block | Scribe | Critic, Auditor, Cartographer |
| Gap document | `gaps/<gap-id>.yaml` | Scribe, Cartographer | Cartographer, researcher |
| Prompt entry | `prompts/<prompt-id>.yaml` | Runner (init), Methodologist (candidates) | Scribe (assigned prompt only), Methodologist |

**YAML is the canonical source of truth.** All of these objects are stored as
YAML files in the knowledge repo, tracked in git, and readable with a text
editor. The SQLite index (`.omoikane/omoikane.db`) is built from these files
and is always rebuildable. See section 6 for the persistence model.

**Schema versioning:** Every object carries a `schema_version` field. When
the schema changes, the runner migrates old objects on read or flags them as
requiring reindex. The SQLite index always reflects the current schema version.

---

## 3.2 The Repo Manifest

The manifest is the spine of the repo. There is exactly one manifest per
knowledge repo: `manifest.yaml`. It is the entry point for every agent run
and every CLI command.

### What the manifest tracks

**Identity fields:** `schema_version`, `subject`, `created_at`, `last_modified`.

**Learning brief reference:** Path to the learning brief file produced by
`omoikane repo init`. The manifest does not embed the learning brief — it
references it. This keeps the manifest compact and the learning brief
independently readable.

**Outline state:** `version` (integer, increments on each amendment),
`status` (`draft | approved | amended`), `approved_at` (date of last approval),
and `nodes` (array of outline node references with their status and any open
checkpoints).

**Document registry:** An array of all document references, including
superseded documents. Each entry records: document ID, outline node ID, status
(`active | superseded | stale | low-trust`), prompt ID and generation used,
and date. Documents are never removed from the registry. Superseded documents
remain referenced so lineage is preserved.

**Prompt library version:** Integer tracking which generation of the prompt
library is active. Used by the Scribe to confirm it received the correct
prompt version and by the Methodologist to identify which generation's
signals it is working with.

**Known gaps:** Array of gap document references. Each entry records gap ID,
nature, status, and the outline node it belongs to (if any).

**Open predictions:** Array of prediction references from the Methodologist.
Each entry records the prompt candidate ID, the prediction text, and its
status (`pending | confirmed | refuted`).

**Open checkpoints:** Array of all checkpoints that have not been resolved.
Each entry records checkpoint ID, type (`inform | review | block`), the agent
that produced it, the affected object, and the action it requires.

### Why the manifest exists separately from the document files

The manifest is the only file every agent is allowed to read as required
context (or explicitly required context for the Architect and Cartographer).
Having a single entry-point file means agents do not need to scan the full
repo to understand its state. The manifest is the index; the document files
are the content.

**Key invariant:** The manifest is the only source of truth for repo state.
No agent or CLI command may mutate repo state except through the runner's
state manager, which owns the manifest. Direct edits to document files without
a corresponding manifest update are inconsistent state.

---

## 3.3 The Document Block

A document block is the output of a single `gather` run. It contains
everything produced by the Scribe for one outline node at one point in time.

### Provenance fields

Every document block records exactly how it was produced:

- `prompt_id`: which prompt in the prompt library was used
- `prompt_generation`: the generation of that prompt at time of use
- `adapter`: which adapter produced this document
- `model`: which model the adapter used
- `source_tier_mix`: a summary count of how many claims came from each tier
  (e.g., `{tier_1: 2, tier_2: 4, tier_3: 1}`)
- `date`: ISO 8601 date of the gather run

**Rationale for recording adapter and model:** Document provenance enables
the signal aggregator to detect when a particular adapter/model combination
consistently produces outputs that get challenged or corrected. This feeds
back into adapter choice without requiring manual benchmarking.

### Status fields

- `status`: `draft | active | superseded | stale | low-trust`
- `staleness_flag`: boolean, set by the runner when a significant prompt
  revision means the document was gathered under materially different
  instructions
- `re_gather_candidate`: boolean, set by the Cartographer or Critic when
  the document's content is so significantly challenged that re-gathering
  is recommended

**Document status transitions:**

```
draft → active           (after first checkpoint is resolved or inform fires)
active → superseded      (when a new gather run produces a replacement document)
active → stale           (when staleness_flag is set)
active → low-trust       (when the producing adapter/model fails its smoke test after the fact)
stale → active           (after re-gather and replacement)
```

Documents never transition to a deleted state. The `superseded` status
preserves the lineage. A researcher can always retrieve the full history of
what was known about an outline node at any point in time.

### Signal history

`signal_history` is an append-only log attached to each document. Entries
are added by the runner when:

- The researcher corrects a claim (`omoikane claim correct`)
- The researcher retracts a claim (`omoikane claim retract`)
- A Critic finding is accepted by the researcher
- An Auditor verdict of `fail` is acknowledged
- A prediction about this document is checked

Each signal history entry records: entry ID, type, timestamp, the agent or
human who produced it, the affected claim ID (if any), and a description.
Signal history entries are never modified or deleted.

**Why append-only:** The signal history is the paper trail that the
Methodologist uses to improve prompts and the researcher uses to understand
how a document's content evolved. If entries could be modified, that trail
would be unreliable. The cost of append-only is a larger file over time;
this is acceptable given that documents are replaced (not indefinitely
mutated) and the SQLite index handles the query load.

### Content

The `claims` array contains the document's claim blocks. See section 3.4.

### Self-critique and follow-up prompts

`self_critique` is the Scribe's own assessment of the gather run:
`what_was_hard`, `confidence_floor`, and `unresolved_questions`. These are
produced by the Scribe and are not editable by the researcher (though they
are readable). They feed the signal aggregator.

`follow_up_prompts` is an optional array of prompt candidate strings the
Scribe surfaces as follow-up directions. These are not automatically added
to the prompt library — they require the Methodologist to evaluate them.

### Supersession

When a new gather run produces a document for a node that already has an
active document, the new document references the old one via `supersedes`:
the `supersedes` field contains the old document's ID. The old document's
status is updated to `superseded` in the manifest. Both documents remain
in the repo.

---

## 3.4 The Claim Block

The claim block is the atomic unit of knowledge. Every factual assertion in
the repo lives in a claim block. Claims are embedded in document blocks —
they are not stored as separate files.

### Claim types

| Type | Meaning |
|------|---------|
| `factual` | An assertion about how something is |
| `contested` | An assertion on which there is genuine expert disagreement |
| `definitional` | An assertion about how a term is used |
| `methodological` | An assertion about research methods or practices |
| `gap` | An inline acknowledgement that something is unknown (distinct from a gap document) |

**The `gap` claim type** is distinct from a gap document. A gap claim is an
inline marker within a document that says "this specific question was raised
here and is unresolved." A gap document is a first-class standalone finding
about a broader knowledge gap. The Scribe produces both; the Cartographer
aggregates gap documents and may upgrade gap claims to gap documents.

### Source fields

The source object records where a claim came from:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `tier` | enum | Always | `tier_1 \| tier_2 \| tier_3` |
| `citation` | string | When tier is tier_1 or tier_2 | Full citation string |
| `url` | string | Optional | Direct URL if available |
| `quote_basis` | string | Optional | The specific passage the claim is drawn from |
| `fidelity` | enum | Always | `direct \| paraphrase \| inferred` |

**`quote_basis`** is the specific passage from the source that the claim
is drawn from. It is optional because not all sources are quotable (e.g.
a physical reference copy), but it should be populated whenever possible.
It is the Auditor's primary reference when checking fidelity.

### Confidence fields

The confidence object records how confident the Scribe was and what that
confidence is based on:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `level` | enum | Always | `high \| medium \| low \| contested` |
| `basis` | string | Always | Explanation of why this confidence level |
| `corroborating_sources` | array | Optional | Citations that support the claim |
| `contradicting_sources` | array | Optional | Citations that challenge the claim |

**The `contested` confidence level** is not a low-confidence label. It
means: the evidence on both sides is serious, and the research should
surface this disagreement rather than resolve it. A `contested` claim that
cites both `corroborating_sources` and `contradicting_sources` is the
system working correctly — it is documenting a genuine scientific or scholarly
dispute.

### Claim status

| Status | Meaning | Set by |
|--------|---------|--------|
| `active` | Current, uncontested | Scribe (at creation) |
| `corrected` | Content updated by researcher | Researcher via `omoikane claim correct` |
| `retracted` | Withdrawn by researcher | Researcher via `omoikane claim retract` |
| `disputed` | A Critic finding is open and unresolved against this claim | Runner (after challenge) |

Status is set by the runner — not by agents directly. The Scribe always
creates claims with `status: active`. The Critic's findings can trigger a
`disputed` status update through the runner's checkpoint system.

### Operational fields

- `challenge_findings`: array of finding IDs from Critic challenge reports
  that reference this claim. Read-only from the Scribe's perspective;
  populated by the runner after a challenge run.
- `user_notes`: open text field, editable by the researcher via `omoikane resolve`
- `prediction_check`: optional reference to a Methodologist prediction made
  about this claim. Records the prediction ID, text, and outcome if checked.

---

## 3.5 The Gap Document

Gap documents are first-class outputs. A gap document is not a placeholder
for content that will arrive later — it is a finding in its own right. A
repo with well-described gap documents is a more honest and useful knowledge
base than one where gap content is silently absent or filled with low-confidence
claims.

### Gap types

| Type | Meaning | Researcher response |
|------|---------|---------------------|
| `knowledge_ceiling` | The information does not exist or cannot be retrieved regardless of approach | Acknowledge; do not continue prompting |
| `source_absence` | Information likely exists but was not found in this run | Retry with different sources or search strategies |
| `contested_foundation` | Genuine expert disagreement on a claim that appears foundational | Document the disagreement; do not resolve it artificially |

**These distinctions are structurally enforced.** The `nature` field is a
required enumeration. A gap document that does not classify its type is
invalid. The distinctions matter because they suggest entirely different
next steps.

### Gap document fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | Always | Unique within the repo |
| `nature` | enum | Always | `knowledge_ceiling \| source_absence \| contested_foundation` |
| `description` | string | Always | What is known about this gap |
| `partial_knowledge` | array | Optional | Claim IDs for what is known at the edges of this gap |
| `prompt_attempts` | array | Optional | Prompt IDs that attempted and hit this ceiling |
| `outline_node_id` | string | Optional | The node this gap belongs to, if any |
| `status` | enum | Always | `open \| externally_resolved \| user_closed` |
| `created_at` | string | Always | ISO 8601 date |
| `produced_by` | string | Always | Agent role that produced this gap document |

**`partial_knowledge`** is critical for the Cartographer. It allows gap
documents to record not just what is unknown, but what is known around the
edges. A knowledge ceiling with well-described partial knowledge is much more
useful to a researcher than a bare "we don't know."

**`externally_resolved` vs `user_closed`:** A gap can be resolved because
new external information has become available (`externally_resolved`) or
because the researcher has decided to close it out of scope (`user_closed`).
These are different decisions with different implications for the knowledge
base's completeness claims.

### Gap documents are produced by two agents

The Scribe can produce a gap document when ceiling detection fires during a
gather run. The Cartographer produces and updates gap documents during a
gaps run, where it has the panoramic view to identify gaps that no single
Scribe run would see.

When the Cartographer updates a gap document produced by the Scribe, it
does not replace it — it appends to the `prompt_attempts` field and may
upgrade the `nature` classification if the panoramic view reveals it is a
knowledge ceiling rather than a source absence. The gap document's
`produced_by` field records who created it; changes are logged to the
manifest's signal history.

---

## 3.6 The Prompt Entry

The prompt entry is the unit of the prompt library. It is a structured
object, not a plain string. Prompts evolve through generations, maintaining
lineage across refinements.

Full treatment of the prompt library and the refinement lifecycle is in
section 4. This section covers only the prompt entry schema.

### Prompt entry fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | Always | Unique within the library |
| `type` | enum | Always | `gather \| challenge \| verify \| gaps \| refine \| init \| outline` |
| `target` | string | Optional | Outline node ID or topic scope |
| `status` | enum | Always | `active \| candidate \| deprecated` |
| `origin` | enum | Always | `system \| user \| refine-generated` |
| `generation` | integer | Always | 1 for bootstrap prompts; increments each refinement cycle |
| `parent` | string | Optional | Prompt ID this evolved from; null for generation-1 prompts |
| `question` | string | Always | The actual prompt text |
| `rationale` | string | Always | Why this framing — treated as a hypothesis, not a conclusion |
| `performance` | object | Always | `last_used`, `produced_sources`, `confidence_delta`, `user_rating` |
| `prediction` | string | Optional | What better results would look like if this prompt works |
| `prediction_outcome` | enum | Optional | `pending \| confirmed \| refuted`; null until checked |
| `created_at` | string | Always | ISO 8601 date |

**Why `rationale` is required:** The rationale is the hypothesis the prompt
is testing. Without it, the Methodologist cannot evaluate whether the prompt
succeeded on its own terms — only whether it produced more or fewer sources,
which is a weaker signal. A rationale that makes a testable prediction
(recorded in `prediction`) is a stronger signal still.

**Why `generation` is an integer rather than a version string:** Generations
need to be comparable. The Methodologist uses generation count to identify
when a lineage is growing long and may be encoding accumulated small errors.
An integer is sortable; a version string is not.

**Deprecated vs candidate:** A `candidate` prompt has been proposed by the
Methodologist but not yet approved by the researcher. A `deprecated` prompt
was once active but has been superseded and is preserved for lineage purposes.
Neither is deleted.

---

## 3.7 Cross-Schema Relationships

The objects reference each other by ID. The SQLite index maintains these
relationships as foreign keys so the runner can efficiently query them.
The YAML files maintain them as string fields — the runner validates ID
references on read.

Key relationships:

| Source field | References |
|-------------|-----------|
| `manifest.documents[].document_id` | Document block file |
| `manifest.known_gaps[].gap_id` | Gap document file |
| `document.supersedes` | Document block file (previous version) |
| `document.claims[].challenge_findings[]` | Finding ID in a challenge report |
| `claim.prediction_check.prediction_id` | Prompt entry file |
| `gap_document.partial_knowledge[]` | Claim ID in a document block |
| `gap_document.prompt_attempts[]` | Prompt entry file |
| `prompt_entry.parent` | Prompt entry file |

**ID reference validation:** The runner validates ID references when loading
objects. A dangling reference (a claim ID in `challenge_findings` that does
not exist in any document) is logged as an integrity warning and surfaced in
`omoikane status`. It does not block operations but should be investigated.

---

## 3.8 Design Decisions and Rationale

### Claims are embedded in documents, not stored separately

Claims are not stored as separate YAML files. They live inside their parent
document block. This keeps the Scribe's output atomic — a single gather run
produces a single file, and a single file can be inspected, versioned, and
superseded as a unit. The SQLite index provides claim-level querying when
needed.

**Alternative considered:** Separate claim files to allow finer-grained
versioning. Rejected because the unit of production is the document (one
gather run), not the individual claim. Finer-grained versioning of individual
claims would make supersession and lineage significantly more complex without
clear benefit.

### Documents are never deleted

Superseded documents retain their file and their manifest reference. This is
a deliberate departure from "keep the repo clean." The deliberation principle
requires that the history of what was known and when be preserved. A
researcher who wants to understand why the current document looks the way it
does should be able to read its ancestors.

**The cost:** The repo grows over time and does not self-prune. This is
acceptable. The SQLite index does not load superseded documents by default;
they are available but not in the active query path.

### Signal history is append-only

Signal history entries are never modified or deleted. This preserves the
integrity of the record the Methodologist uses for refinement. An editable
signal history could be used to suppress inconvenient corrections, which
would corrupt the refinement feedback loop.

### Gap documents are separate files, not embedded in documents

Gap documents are stored as separate files under `gaps/`. This is because
they are not always produced in the context of a single gather run — the
Cartographer produces them at the repo level. Embedding them in a single
document would misrepresent their scope. Separate files also allow the
Cartographer to update them without touching the original document.

---

*Next section: `spec/human/section4_prompt_library.md`*
