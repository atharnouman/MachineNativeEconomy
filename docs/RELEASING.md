# Releasing to npm

Two packages are published: `@spendmarshal/core` (types, policy evaluator, evidence verifier) and `@spendmarshal/cli`
(`spendmarshal verify`, `spendmarshal audit-logs`). The CLI depends on core at the same version, so core goes first.
Everything else in the monorepo stays unpublished for now.

The maintainer runs every command below personally. No assistant or automation logs in to npm, and nothing is ever written
to the user-level `~/.npmrc`: the token lives in one git-ignored file that only the maintainer writes.

## Once

1. An npm account with two-factor authentication, and an npm organisation named `spendmarshal`: a scoped package can only
   be published under a scope that belongs to the publisher, and organisations are free for public packages.
   Sign in with the passkey or security key, never with a recovery code: a recovery-code sign-in puts the account on a
   72-hour security hold during which npm refuses to create organisations or tokens and to publish.
2. A granular access token on npmjs.com (Access Tokens, Generate New Token, Granular): read and write on packages and
   scopes, limited to the `@spendmarshal` scope, with two-factor required for publishing, and an expiry.
3. The token goes into `local\.npmrc` in the project folder (`local/` is git-ignored), as one line:

   ```
   //registry.npmjs.org/:_authToken=<the token>
   ```

   Nothing else reads that file; it is passed to npm by path, never printed.

## Each release

```bash
pnpm install
pnpm build
pnpm test
```

Bump the version in both `packages/core/package.json` and `packages/cli/package.json` to the same number and commit.
Then pack with pnpm, which rewrites the CLI's `workspace:*` dependency to the published version and runs
`prepack` (a rebuild, so a stale `dist` cannot ship), and publish each tarball with npm and the token file:

```bash
cd packages/core && pnpm pack && npm publish spendmarshal-core-0.0.1.tgz --access public --userconfig ../../local/.npmrc && rm spendmarshal-core-0.0.1.tgz
```

```bash
cd packages/cli && pnpm pack && npm publish spendmarshal-cli-0.0.1.tgz --access public --userconfig ../../local/.npmrc && rm spendmarshal-cli-0.0.1.tgz
```

Replace `0.0.1` with the version being released. A dry run that uploads nothing: add `--dry-run` to the `npm publish`
command; `pnpm pack` alone shows the tarball's contents.

Afterwards, anyone can run the diagnostic on their own machine without installing anything:

```bash
npx @spendmarshal/cli audit-logs spend-logs.json
```
