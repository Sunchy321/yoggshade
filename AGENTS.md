# AGENTS.md

## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles are used as-is: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Conventional commits

All commits MUST follow the [Conventional Commits](https://www.conventionalcommits.org/) specification: `type(scope): subject`, e.g. `feat(renderer): add card node layout`.

- Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`
- `scope` is optional; use the module/area name when clear
- Subject in English, imperative mood, no trailing period; breaking changes use `!` after type/scope plus a `BREAKING CHANGE:` footer
