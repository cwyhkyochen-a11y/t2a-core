# Contributing to t2a-core

Thanks for thinking about contributing. Quick rules below.

## Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — docs only
- `chore:` — tooling / housekeeping
- `test:` — tests only
- `refactor:` — code change that neither adds feature nor fixes bug

Subject in Chinese is fine; type prefix in English.

Example: `feat: 实现 EventBus 命名空间校验`

## Branch Strategy

- **v0.x stage**: push to `main` directly is OK. We're moving fast.
- **v1.0+**: feature branch + PR + review.

## Release Flow

1. `npm run typecheck && npm run test:coverage && npm run build`
2. Verify `dist/` contains ESM + CJS + .d.ts
3. Update `CHANGELOG.md` (top entry = new version)
4. Bump `package.json` version
5. `git commit -am "release: vX.Y.Z"`
6. `git tag vX.Y.Z`
7. `git push --follow-tags`
8. Create GitHub release with changelog excerpt
9. `npm publish` (after build verification)

## Package Contents

Only files listed in `package.json#files` ship to npm:

- `dist/`
- `README.md`
- `LICENSE`

Source, tests, configs do **not** ship. Verify with `npm pack --dry-run` before publish.

## SemVer Policy

While in `v0.x`:

- **MINOR** bumps may include breaking API changes (mark clearly in CHANGELOG)
- **PATCH** bumps are bug fixes only

After `v1.0.0` we follow strict SemVer.

## Code Style

- Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`)
- No runtime dependencies in core (only devDeps)
- Every public type / interface needs JSDoc with DESIGN.md section reference
- Tests live in `tests/` (vitest), coverage threshold 80%

## Questions

Open an issue, or ping kyo.
