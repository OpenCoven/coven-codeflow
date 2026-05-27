# Coven Code Release Runbook

This package publishes as `@opencoven/coven-code`.

## One-time setup

1. Make `OpenCoven/coven-code` public before provenance-backed publishing.
2. Publish the first public package version manually if npm does not yet have the package. npm trusted publishing can be configured only after the package exists.
3. Configure npm trusted publishing for GitHub Actions:
   - Package: `@opencoven/coven-code`
   - Repository: `OpenCoven/coven-code`
   - Workflow filename: `release-npm.yml`
   - Allowed action: `npm publish`
4. Add the GitHub repository variable `NPM_RELEASE_ALLOWED_SIGNERS`.

The signer variable must contain one or more SSH allowed-signers lines. For the current release key, use the Git commit signing principal and public key:

```text
68980965+BunsDev@users.noreply.github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILs6nKUsP+OVzoTXNYcZ98IePpd4j+aeuweVS/cozV8D
```

## Release

1. Bump `package.json` and `package-lock.json` to the next semver version.
2. Commit the verified release changes on the default branch.
3. Create a signed annotated tag that matches the package version:

```bash
git tag -s v0.0.1 -m "v0.0.1"
git push origin v0.0.1
```

The tag workflow refuses lightweight tags, unsigned tags, `v0.0.0`, mismatched package versions, tags whose target commit is not on the repository default branch, and package contents containing `.github/`, `.superpowers/`, or `test/`.
