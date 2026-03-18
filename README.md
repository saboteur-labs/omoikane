# Omoikane 思兼

> A repository-backed, AI-augmented research and learning tool.

Omoikane helps researchers build structured, cited, validated knowledge bases
on specific subjects. Each repo is scoped to one focus. The output is a
textbook drawn from multiple sources, with uncertainty treated as a finding
rather than a failure.

Named after the Shinto deity of wisdom and deliberation.

---

## Status

**Pre-implementation — specification in progress.**

See `spec/human/` for the human-readable specification.
See `spec/machine/` for machine-readable agent and schema definitions.
See `CONTEXT.md` for the full design decision log with rationale.

## Repository Layout

```
spec/
  human/       # markdown — canonical human-readable spec
  machine/     # YAML — canonical machine-readable agent/schema config
  dist/        # gitignored — generated docx artifacts
CLAUDE.md      # project briefing for Claude Code sessions
CONTEXT.md     # full decision log
```

## Philosophy

The central commitment of this project is **deliberation over speed**.
It is better to surface a well-described gap than to fill it with a
plausible-sounding answer.

See `spec/human/section1_philosophy.md` for the full philosophy.
