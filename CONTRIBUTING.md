# Contributing

Parley is a protocol first. The most valuable contributions right now are:

1. **Spec feedback.** Open an issue quoting the SPEC.md section. Ambiguities are bugs.
2. **New implementations.** Go, Rust, Swift, Kotlin. `conformance/*.json` is the contract:
   pass every vector, then interoperate with `examples/serve.ts` (TS) or
   `python/examples/serve.py`.
3. **Services.** Wrap something real and tell us where the protocol got in your way.

## How work is tracked

Every change starts as a GitHub issue, and every issue ends in a pull request or a note on why it closed.

1. **Open an issue** with a form: *Task* for planned work, *Feature* for a proposal, *Bug*, or *Spec feedback*.
   New issues get `status/triage`.
2. **Triage** adds an `area/*` label, a priority (`priority/P0` now, `P1` next, `P2` later) and a milestone,
   then moves it to `status/ready`. A task is ready when its *Done when* list can be checked by running something.
3. **Claim it** by assigning yourself, switching to `status/in-progress`, and commenting that you've started.
4. **Open a pull request** from a branch named `<issue>-<slug>` (for example `42-rename-cli`), with
   `Closes #42` in the description. `main` only changes through pull requests, and CI must pass.
   PRs are squash-merged, so the PR title becomes the commit message: write it in the repo's style
   (`area: what changed`).
5. **Blocked?** Use `status/blocked` and say on what. Anything only a maintainer can do (a decision,
   credentials, publishing, spending money) gets `status/needs-james`.

Big pieces of work get a tracking issue whose body is a checklist of sub-issues, plus a milestone.

## Changing the protocol

Any change to SPEC.md that affects bytes on the wire or Lens output must:

- update the TypeScript reference in `ts/src`,
- regenerate vectors with `cd ts && npm run build && node scripts/vectors.mjs`,
- keep the Python implementation passing (`cd python && uv run pytest`), which runs both interop directions.

CI fails if the committed vectors don't match the reference implementation.

## Dev loop

```sh
npm install && npm run build && npm test     # TypeScript
cd python && uv run pytest                   # Python
npm run demo && npm run bench
npm run lint && npm run lint:style           # the checks CI runs
```

## Code style

TypeScript and JavaScript are formatted by [Biome](https://biomejs.dev) (80 columns, single
quotes) and linted by Biome plus [oxlint](https://oxc.rs) for spacing. `npm install` sets up a
pre-commit hook ([lefthook](https://lefthook.dev)) that fixes formatting and spacing in staged
files and blocks the commit on lint errors. `npm run format` and `npm run lint:style:fix` fix
everything by hand.

The rules exist to make the code easy for people to read:

- **Blank lines separate kinds of statements**: imports from declarations, declarations from
  logic, logic from `return`, and around every block. Runs of the same kind stay together, so
  a function's shape shows before you read it.
- **Small functions.** A function stays under 50 lines, under Biome's cognitive-complexity
  limit, and takes at most 4 parameters (use an options object beyond that). When one grows,
  extract a helper named for what it does.
- **Real types.** No `any` (use `unknown` and narrow), and no `!` non-null assertions (check,
  then throw a clear error or return early).
- **Comments say why, not what.** Document declarations with `/** */` so editors show it.
  Inside functions, `//` explains a constraint or a trade-off the code can't show.

Tests and benchmarks are exempt from the length, complexity and non-null rules.

The commit that first applied the formatting is listed in `.git-blame-ignore-revs`. GitHub
honors it; locally, run `git config blame.ignoreRevsFile .git-blame-ignore-revs`.
