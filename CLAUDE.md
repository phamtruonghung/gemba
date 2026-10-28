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
