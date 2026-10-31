# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in **`phamtruonghung/gemba`**. Use the `gh` CLI
for all operations. Run it from inside the clone: `gh` infers the repo from `git remote -v`, so
`-R phamtruonghung/gemba` is only needed when you are outside the tree.

The issue list is the record. A change that only exists as a chat message or a commit message did
not happen as far as the next person (or agent) is concerned.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc
  (`--body-file`) for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`
  with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or
  `gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+). Older `gh`:
  `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`
  (database id, as in **Blocking** below). Without sub-issues, put `Part of #<parent>` at the top of
  the child body.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add
  an edge with `gh issue create --blocked-by <n>,<n> ...` or `gh issue edit <child> --add-blocked-by <blocker>`
  (`gh` 2.94+). Older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`,
  where `<blocker-db-id>` is the blocker's numeric **database id**
  (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). Where
  dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child
  body. A ticket is unblocked when every blocker is closed.
- **Count open blockers**: `gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`
  (open blockers only; 0 means startable). `gh issue view <n> --json blockedBy` also lists closed
  blockers, so filter it: `--jq '[.blockedBy.nodes[] | select(.state == "OPEN")] | length'`.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: post the explanation with `gh issue comment <number> --body "..."`, then
  `gh issue close <number>`. On an already-closed issue, `gh issue close --comment` drops the comment
  and still exits 0.

File issues only into `phamtruonghung/gemba`. Never file into `mattpocock/skills` (the repo the skill
set comes from).

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests;
`/triage` reads this flag.)_

This is a single-maintainer repo and its pull requests are our own work in flight, already attached to
an issue — they are not an inbox to be triaged. To triage a pull request anyway, resolve it as usual
(`gh pr view <n>`) and use the `gh pr` equivalents of the verbs above.

When this flag is set to `yes`, PRs run through the same labels and states as issues:

- **Read a PR**: `gh pr view <number>`, then `gh pr view <number> --comments`, and `gh pr diff <number>`
  for the diff.
- **List external PRs for triage**: `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`,
  `gh pr close`.

## Labels this tracker already uses

Categorise with the vocabulary that exists; do not invent a near-synonym for a label below.

| Kind | Labels |
| --- | --- |
| category | `bug`, `enhancement` |
| state | `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` (see `docs/agents/triage-labels.md`) |
| subject | `docs`, `security`, `product`, `mobile`, `ops`, `retrieval`, `legal`, `money`, `accessibility` |

Every triaged issue carries exactly one category role and one state role.

## How work lands (issue → PR → merged)

1. Open an issue that carries the *why*, not just the what.
2. One branch off current `origin/main`, one pull request, body ending `Closes #<n>`.
3. A pull request is done when every required check on the exact head is green and it is
   **squash-merged** — an open PR with green checks is not done work.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
  `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (see **Make an issue a sub-issue
  of a parent**). Where sub-issues aren't enabled, add the child to a task list in the map body and put
  `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>`
  (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: see **Blocking** under Conventions.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's
  sub-issues / task list), drop any with an open blocker (see **Count open blockers**) or an assignee;
  first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a
  context pointer (gist + link) to the map's Decisions-so-far.
