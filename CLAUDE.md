# gemba

What this repo is, and how to run it: `README.md`.

## Start from the current `main`

Before you read or change anything, prove your tree is current:

```
git fetch origin
git rev-list --count HEAD..origin/main
```

That must print `0`. If it prints anything else, catch up first — `git merge --ff-only origin/main`,
or rebase your own commits onto `origin/main` — and only then open a file.

Why: a worktree forked from a stale checkout makes "this file does not exist" true of the wrong
tree, and a green CI on such a branch compiled code your change never touches.

To prove that a path you cite exists in **your** tree and not merely in `main`:

```
git cat-file -e HEAD:<path>
```

## Agent skills

The engineering skills (`to-spec`, `to-tickets`, `triage`, `implement`, `pr`, `code-review`,
`domain-modeling`) read their per-repo config from `docs/agents/`. Read those files before using a
skill that touches the tracker, labels or the domain vocabulary.

### Issue tracker

Issues and specs live as GitHub issues in `phamtruonghung/gemba`, created and driven with the `gh`
CLI; pull requests are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their canonical strings — `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix` — alongside the existing `bug`/`enhancement`
categories. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` plus `docs/adr/`; read both before exploring, and use the
glossary's vocabulary in issue titles and test names. See `docs/agents/domain.md`.
