# Releasing to npm

Two packages are published: `@spendmarshal/core` (types, policy evaluator, evidence verifier) and `@spendmarshal/cli`
(`spendmarshal verify`, `spendmarshal audit-logs`). The CLI depends on core at the same version, so core goes first.
Everything else in the monorepo stays unpublished for now.

## Once

- An npm account with two-factor authentication, and an npm organisation named `spendmarshal`: a scoped package can only be
  published under a scope that belongs to the publisher, and organisations are free for public packages.
- `npm login` in a terminal (it opens the browser). Never paste a token anywhere.

## Each release

```bash
pnpm install
pnpm build
pnpm test
```

Bump the version in both `packages/core/package.json` and `packages/cli/package.json` to the same number, commit, then:

```bash
pnpm --filter @spendmarshal/core publish --no-git-checks
```

```bash
pnpm --filter @spendmarshal/cli publish --no-git-checks
```

`pnpm publish` rewrites the CLI's `workspace:*` dependency to the published version and runs `prepublishOnly`, which
rebuilds, so a stale `dist` cannot ship. `--no-git-checks` is needed only when publishing from a branch other than the
repository's default; drop it on `main`. A dry run that uploads nothing:

```bash
pnpm --filter @spendmarshal/cli publish --dry-run --no-git-checks
```

Afterwards, anyone can run the diagnostic on their own machine without installing anything:

```bash
npx @spendmarshal/cli audit-logs spend-logs.json
```
