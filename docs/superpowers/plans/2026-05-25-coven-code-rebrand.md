# Coven Code Rebrand And Move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the rebuilt Amp-compatible CLI from `/Users/buns/Documents/Projects/ampcode-cli` to `/Users/buns/Documents/GitHub/OpenCoven/coven-code` and comprehensively rename public and internal surfaces from Amp/Ampcode to Coven Code.

**Architecture:** Treat `/Users/buns/Documents/Projects/ampcode-cli` as the source checkout and create `/Users/buns/Documents/GitHub/OpenCoven/coven-code` as the new canonical OpenCoven checkout, preserving current worktree contents and git history. Rename public package, executable, SDK, config, env, plugin, docs, tests, and help surfaces together so the target tree does not ship mixed Amp/Coven Code identity except in an explicit migration note if Val requests one.

**Tech Stack:** Node.js 20+ ESM CLI, `node --test`, npm package metadata/bin shims, filesystem-backed settings/plugins/threads, OpenCoven repo conventions.

---

## Current Evidence

- Source checkout exists: `/Users/buns/Documents/Projects/ampcode-cli`.
- Target checkout does not exist yet: `/Users/buns/Documents/GitHub/OpenCoven/coven-code`.
- Source package identity is still Amp: package name `@ampcode/cli`, bins `amp` and `amp-sdk`.
- Source worktree is dirty with the active CLI recreation work; preserve it instead of cloning from `HEAD`.
- OpenCoven already has `/Users/buns/Documents/GitHub/OpenCoven/coven`, a separate Rust Coven CLI/runtime. Avoid reusing the `coven` binary name in this JS CLI to prevent local/package collision.

## Rename Policy

- Product display name: `Coven Code`.
- Package name: `@opencoven/coven-code`.
- Primary executable: `coven-code`.
- SDK executable: `coven-code-sdk`.
- Config directory: `coven-code`.
- Project-local directory: `.coven-code`.
- Env prefix: `COVEN_CODE_`.
- Settings prefix: `covenCode.`.
- Do not keep `amp`, `Amp`, `AMP_`, `@ampcode`, `ampcode.com`, `.amp`, or `amp.*` references unless a task creates a single explicit migration note and the final audit allowlist lists it.

## File Structure

- Move/copy source tree to: `/Users/buns/Documents/GitHub/OpenCoven/coven-code`.
- Rename:
  - `bin/amp.mjs` -> `bin/coven-code.mjs`
  - `bin/amp-sdk.mjs` -> `bin/coven-code-sdk.mjs`
- Modify:
  - `package.json`
  - `package-lock.json`
  - `README.md`
  - `src/constants.mjs`
  - `src/main.mjs`
  - `src/sdk.mjs`
  - `src/sdk-install.mjs`
  - `src/cli/*.mjs`
  - `src/commands/*.mjs`
  - `src/settings/*.mjs`
  - `src/plugins/discover.mjs`
  - `src/skills/discover.mjs`
  - `src/threads/store.mjs`
  - `test/cli.test.mjs`
- Create:
  - `docs/MIGRATION-FROM-AMP.md` only if Val wants documented compatibility/migration language.

## Task 1: Create The OpenCoven Target Checkout

**Files:**
- Create directory: `/Users/buns/Documents/GitHub/OpenCoven/coven-code`
- Preserve source: `/Users/buns/Documents/Projects/ampcode-cli`

- [ ] **Step 1: Verify source and target state**

Run:

```bash
pwd
test -d /Users/buns/Documents/Projects/ampcode-cli
test ! -e /Users/buns/Documents/GitHub/OpenCoven/coven-code
git -C /Users/buns/Documents/Projects/ampcode-cli status --short
```

Expected:

```text
/Users/buns
```

`test` commands exit 0, and `git status --short` prints the current dirty Amp recreation changes.

- [ ] **Step 2: Copy the full dirty checkout without generated dependencies**

Run:

```bash
rsync -a \
  --exclude node_modules \
  --exclude .DS_Store \
  /Users/buns/Documents/Projects/ampcode-cli/ \
  /Users/buns/Documents/GitHub/OpenCoven/coven-code/
```

Expected: command exits 0.

- [ ] **Step 3: Verify target has git history and working files**

Run:

```bash
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-code status --short
test -f /Users/buns/Documents/GitHub/OpenCoven/coven-code/package.json
test -f /Users/buns/Documents/GitHub/OpenCoven/coven-code/bin/amp.mjs
```

Expected: status matches the source dirty state, and both files exist.

## Task 2: Rename Package And Binary Entrypoints

**Files:**
- Modify: `/Users/buns/Documents/GitHub/OpenCoven/coven-code/package.json`
- Modify: `/Users/buns/Documents/GitHub/OpenCoven/coven-code/package-lock.json`
- Move: `/Users/buns/Documents/GitHub/OpenCoven/coven-code/bin/amp.mjs`
- Move: `/Users/buns/Documents/GitHub/OpenCoven/coven-code/bin/amp-sdk.mjs`
- Test: `/Users/buns/Documents/GitHub/OpenCoven/coven-code/test/cli.test.mjs`

- [ ] **Step 1: Write failing package/bin identity tests**

Add tests asserting:

```js
test('package metadata uses the Coven Code npm package and binaries', async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, '@opencoven/coven-code');
  assert.deepEqual(packageJson.bin, {
    'coven-code': './bin/coven-code.mjs',
    'coven-code-sdk': './bin/coven-code-sdk.mjs',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-code
npm test -- --test-name-pattern "package metadata uses the Coven Code npm package and binaries"
```

Expected: FAIL because package name is still `@ampcode/cli` and bins are still `amp`/`amp-sdk`.

- [ ] **Step 3: Rename bin files and package metadata**

Run:

```bash
mv bin/amp.mjs bin/coven-code.mjs
mv bin/amp-sdk.mjs bin/coven-code-sdk.mjs
```

Edit `package.json` to:

```json
{
  "name": "@opencoven/coven-code",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/sdk.mjs"
  },
  "bin": {
    "coven-code": "./bin/coven-code.mjs",
    "coven-code-sdk": "./bin/coven-code-sdk.mjs"
  },
  "scripts": {
    "test": "node --test",
    "start": "node ./bin/coven-code.mjs",
    "coven-code": "node ./bin/coven-code.mjs"
  },
  "engines": {
    "node": ">=20"
  }
}
```

Update `package-lock.json` package names and bin paths to match.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- --test-name-pattern "package metadata uses the Coven Code npm package and binaries"
```

Expected: PASS.

## Task 3: Rename CLI Runtime Constants, Help, And Dispatch

**Files:**
- Modify: `src/constants.mjs`
- Modify: `src/main.mjs`
- Modify: `src/cli/help.mjs`
- Modify: `src/cli/dispatch.mjs`
- Modify: `src/cli/parse.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Write failing help/runtime identity tests**

Add tests asserting:

```js
test('prints a Coven Code help screen with renamed binary', () => {
  const result = runCovenCode(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Coven Code/);
  assert.match(result.stdout, /Usage:\s+coven-code/);
  assert.doesNotMatch(result.stdout, /\bAmp\b|ampcode|Usage:\s+amp\b/);
});
```

Define `runCovenCode` beside the existing runner:

```js
function runCovenCode(args = [], options = {}) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'coven-code.mjs'), ...args], {
    cwd: options.cwd ?? repoRoot,
    input: options.input,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- --test-name-pattern "prints a Coven Code help screen with renamed binary"
```

Expected: FAIL while help still says Amp or the new bin path is not wired.

- [ ] **Step 3: Rename runtime identity constants and help text**

Replace user-facing strings:

```js
export const PRODUCT_NAME = 'Coven Code';
export const CLI_NAME = 'coven-code';
export const PACKAGE_NAME = '@opencoven/coven-code';
export const SUPPORT_URL = 'https://opencoven.com';
```

Update help usage strings to use `coven-code`, not `amp`.

- [ ] **Step 4: Run focused help tests**

Run:

```bash
npm test -- --test-name-pattern "Coven Code help|top-level help"
```

Expected: PASS.

## Task 4: Rename Config, Project Directories, Settings, And Env Vars

**Files:**
- Modify: `src/settings/paths.mjs`
- Modify: `src/settings/load.mjs`
- Modify: `src/cli/execute.mjs`
- Modify: `src/cli/notifications.mjs`
- Modify: `src/commands/config.mjs`
- Modify: `src/commands/login.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Write failing config/env tests**

Add tests for:

```js
test('Coven Code stores auth under COVEN_CODE_API_KEY and coven-code config paths', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const result = runCovenCode(['login', '--api-key', 'ck-test-secret'], {
    env: { HOME: home, XDG_CONFIG_HOME: xdg },
  });
  assert.equal(result.status, 0, result.stderr);
  const settings = await readFile(path.join(xdg, 'coven-code', 'settings.jsonc'), 'utf8');
  assert.match(settings, /COVEN_CODE_API_KEY|ck-test-secret/);
});

test('Coven Code discovers project plugins under .coven-code not .amp', async () => {
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'probe.ts'), 'export default function probe() {}\\n');
  const result = runCovenCode(['plugins', 'list'], { cwd: workspace });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /probe/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- --test-name-pattern "Coven Code stores auth|Coven Code discovers project plugins"
```

Expected: FAIL because code still uses `AMP_*`, `amp`, and `.amp`.

- [ ] **Step 3: Rename configuration surfaces**

Replace:

```text
AMP_API_KEY -> COVEN_CODE_API_KEY
AMP_CLI_PATH -> COVEN_CODE_CLI_PATH
AMP_HOME -> COVEN_CODE_HOME
AMP_FORCE_BEL -> COVEN_CODE_FORCE_BEL
AMP_TOOLBOX -> COVEN_CODE_TOOLBOX
AMP_PLUGIN_* -> COVEN_CODE_PLUGIN_*
~/.config/amp -> ~/.config/coven-code
.amp -> .coven-code
amp.* settings keys -> covenCode.*
```

- [ ] **Step 4: Run focused config/env tests**

Run:

```bash
npm test -- --test-name-pattern "Coven Code stores auth|Coven Code discovers project plugins|settings|config|login"
```

Expected: PASS.

## Task 5: Rename SDK And Installer Surfaces

**Files:**
- Modify: `src/sdk.mjs`
- Modify: `src/sdk-install.mjs`
- Modify: `bin/coven-code-sdk.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Write failing SDK identity tests**

Add tests asserting:

```js
test('SDK package installs a Coven Code managed command', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-sdk-home-'));
  const result = runCovenCode(['--help'], { env: { HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /coven-code/);
});
```

Update existing SDK tests to use `coven-code-sdk`, `COVEN_CODE_CLI_PATH`, and `@opencoven/coven-code`.

- [ ] **Step 2: Run SDK tests to verify failure**

Run:

```bash
npm test -- --test-name-pattern "SDK .*Coven Code|SDK package"
```

Expected: FAIL until SDK installer paths and names are renamed.

- [ ] **Step 3: Rename SDK installer internals**

Replace package/binary/env references:

```text
amp-sdk -> coven-code-sdk
amp -> coven-code
@ampcode/cli -> @opencoven/coven-code
AMP_CLI_PATH -> COVEN_CODE_CLI_PATH
AMP_HOME -> COVEN_CODE_HOME
```

- [ ] **Step 4: Run SDK tests**

Run:

```bash
npm test -- --test-name-pattern "SDK"
```

Expected: PASS.

## Task 6: Rename Plugin And Tooling Surfaces

**Files:**
- Modify: `src/plugins/discover.mjs`
- Modify: `src/commands/plugins.mjs`
- Modify: `src/tools/toolbox.mjs`
- Modify: `src/skills/discover.mjs`
- Modify: `src/skills/builtin/building-skills/SKILL.md`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Write failing plugin path and docs tests**

Add tests asserting:

```js
test('plugins list reports Coven Code project and user plugin files', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code', 'plugins'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'project-status.ts'), 'export default function projectStatus() {}\\n');
  await writeFile(path.join(xdg, 'coven-code', 'plugins', 'notify.ts'), 'export default function notify() {}\\n');

  const result = runCovenCode(['plugins', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /project-status/);
  assert.match(result.stdout, /notify/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- --test-name-pattern "Coven Code project and user plugin files"
```

Expected: FAIL until plugin paths are renamed.

- [ ] **Step 3: Rename plugin paths and examples**

Replace plugin examples and discovery paths:

```text
.amp/plugins -> .coven-code/plugins
~/.config/amp/plugins -> ~/.config/coven-code/plugins
@ampcode/plugin -> @opencoven/coven-code-plugin
Amp Plugin API -> Coven Code Plugin API
```

- [ ] **Step 4: Run focused plugin tests**

Run:

```bash
npm test -- --test-name-pattern "plugin|plugins|tool.call|tool.result"
```

Expected: PASS.

## Task 7: Rename Tests And Remove Amp Identity Drift

**Files:**
- Modify: `test/cli.test.mjs`
- Modify: all source/docs containing Amp identity

- [ ] **Step 1: Add an identity drift audit test**

Add a test that scans tracked source/docs/package files:

```js
test('repository does not contain unapproved Amp identity strings', async () => {
  const allowed = new Set([
    'docs/MIGRATION-FROM-AMP.md',
  ]);
  const files = listRepoTextFiles(repoRoot).filter((file) => !allowed.has(path.relative(repoRoot, file)));
  const pattern = /@ampcode|ampcode\\.com|\\bAmp\\b|\\bAMP_[A-Z0-9_]+|\\.amp\\b|\\bamp\\./;
  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (pattern.test(text)) offenders.push(path.relative(repoRoot, file));
  }
  assert.deepEqual(offenders.sort(), []);
});
```

- [ ] **Step 2: Run audit test to verify it fails**

Run:

```bash
npm test -- --test-name-pattern "repository does not contain unapproved Amp identity strings"
```

Expected: FAIL with a concrete offender list.

- [ ] **Step 3: Rename offenders or move intentional legacy text into the migration allowlist**

Run:

```bash
rg -n "@ampcode|ampcode\\.com|\\bAmp\\b|\\bAMP_[A-Z0-9_]+|\\.amp\\b|\\bamp\\." .
```

For each result:

```text
rename current product/runtime surface -> Coven Code equivalent
delete stale upstream marketing/docs text
move intentional one-time compatibility notes -> docs/MIGRATION-FROM-AMP.md
```

- [ ] **Step 4: Run audit test to verify it passes**

Run:

```bash
npm test -- --test-name-pattern "repository does not contain unapproved Amp identity strings"
```

Expected: PASS.

## Task 8: Update README And Operator Docs

**Files:**
- Modify: `README.md`
- Create optional: `docs/MIGRATION-FROM-AMP.md`

- [ ] **Step 1: Write README smoke assertions**

Add tests or a small script assertion:

```bash
node - <<'NODE'
const fs = require('fs')
const readme = fs.readFileSync('README.md', 'utf8')
if (!readme.includes('Coven Code')) throw new Error('README missing Coven Code')
if (/@ampcode|ampcode\.com|\bAmp\b/.test(readme)) throw new Error('README still contains Amp identity')
NODE
```

- [ ] **Step 2: Rewrite README around Coven Code**

Required sections:

```markdown
# Coven Code

Coven Code is an OpenCoven CLI for local coding-agent workflows.

## Install

```bash
npm install -g @opencoven/coven-code
coven-code --help
```

## Configuration

- User settings: `~/.config/coven-code/settings.jsonc`
- Project plugins: `.coven-code/plugins/*.ts`
- API key env: `COVEN_CODE_API_KEY`
```
```

- [ ] **Step 3: Run docs smoke assertion**

Run the Node assertion from Step 1.

Expected: exit 0.

## Task 9: Full Verification And Packaging

**Files:**
- Verify entire target checkout.

- [ ] **Step 1: Install dependencies in target checkout**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-code
npm install
```

Expected: exit 0 and `package-lock.json` matches `@opencoven/coven-code`.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected:

```text
fail 0
```

- [ ] **Step 3: Run package dry run**

Run:

```bash
npm pack --dry-run
```

Expected: tarball is named for `@opencoven/coven-code`, includes `bin/coven-code.mjs` and `bin/coven-code-sdk.mjs`, and excludes `node_modules`.

- [ ] **Step 4: Run executable smoke tests**

Run:

```bash
node ./bin/coven-code.mjs --help
node ./bin/coven-code.mjs plugins list
node ./bin/coven-code-sdk.mjs --help
```

Expected: commands exit 0 and do not print Amp identity.

- [ ] **Step 5: Run final identity scan**

Run:

```bash
rg -n "@ampcode|ampcode\\.com|\\bAmp\\b|\\bAMP_[A-Z0-9_]+|\\.amp\\b|\\bamp\\." .
```

Expected: no output, or only `docs/MIGRATION-FROM-AMP.md` if that file was intentionally created.

## Task 10: Git Hygiene And Handoff

**Files:**
- Verify target repo only.

- [ ] **Step 1: Confirm source repo was not destroyed**

Run:

```bash
test -d /Users/buns/Documents/Projects/ampcode-cli
test -d /Users/buns/Documents/GitHub/OpenCoven/coven-code
```

Expected: both exit 0.

- [ ] **Step 2: Review final target diff**

Run:

```bash
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-code status --short
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-code diff --stat
```

Expected: changes are limited to the copied/rebranded Coven Code tree.

- [ ] **Step 3: Commit only after verification**

Run only after Tasks 1-9 pass:

```bash
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-code add .
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-code commit -m "chore: rebrand cli as coven code"
```

Expected: one squashable local commit in `OpenCoven/coven-code`.

## Self-Review

- Spec coverage: The plan covers move, package/bin rename, CLI runtime strings, config/env/settings, SDK, plugins, docs, tests, packaging, and final identity audit.
- Placeholder scan: No banned placeholder markers remain.
- Type/name consistency: The plan consistently uses `Coven Code`, `coven-code`, `coven-code-sdk`, `@opencoven/coven-code`, `COVEN_CODE_*`, `.coven-code`, and `covenCode.*`.
- OpenCoven policy: No AI/model/vendor attribution language is introduced.
