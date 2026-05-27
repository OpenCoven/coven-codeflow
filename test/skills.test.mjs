import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  repoRoot,
  covenCodeBin,
  covenCodeSdkBin,
  makeWorkspace,
  runCovenCode,
  runCovenCodeSdk,
  runGit,
  escapeRegExp,
  expectAvailable,
} from './_helpers.mjs';

test('skill management add and remove subcommands are removed', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const source = path.join(home, 'source-skill');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), `---
name: deploy-staging
description: Deploy the service to staging
---
`);

  const addResult = runCovenCode(['skill', 'add', source], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(addResult.status, 2);
  assert.match(addResult.stderr, /Unknown skill command: add/);

  const removeResult = runCovenCode(['skill', 'remove', 'deploy-staging'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(removeResult.status, 2);
  assert.match(removeResult.stderr, /Unknown skill command: remove/);
});

test('skill list and show inspect user-wide skills', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const skillDir = path.join(xdg, 'agents', 'skills', 'deploy-staging');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), `---
name: deploy-staging
description: Deploy the service to staging
---

# Deploy Staging

Run the staging deploy checklist.
`);

  const listResult = runCovenCode(['skill', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /deploy-staging\s+user\s+Deploy the service to staging/);

  const showResult = runCovenCode(['skill', 'show', 'deploy-staging'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(showResult.status, 0, showResult.stderr);
  assert.match(showResult.stdout, /# Deploy Staging/);
});

test('skill discovery follows Coven Code manual precedence for duplicate names', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(xdg, 'agents', 'skills', 'deploy'), { recursive: true });
  await mkdir(path.join(xdg, 'coven-code', 'skills', 'deploy'), { recursive: true });
  await mkdir(path.join(workspace, '.agents', 'skills', 'deploy'), { recursive: true });
  await writeFile(path.join(xdg, 'agents', 'skills', 'deploy', 'SKILL.md'), `---
name: deploy
description: Top user deploy skill
---

Top user skill.
`);
  await writeFile(path.join(xdg, 'coven-code', 'skills', 'deploy', 'SKILL.md'), `---
name: deploy
description: User deploy skill
---

User skill.
`);
  await writeFile(path.join(workspace, '.agents', 'skills', 'deploy', 'SKILL.md'), `---
name: deploy
description: Project deploy skill
---

Project skill.
`);

  const result = runCovenCode(['skill', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deploy\s+user\s+Top user deploy skill/);
  assert.doesNotMatch(result.stdout, /Project deploy skill/);
  assert.doesNotMatch(result.stdout, /User deploy skill/);
});

test('skill discovery includes parent project skills from nested directories', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const nested = path.join(workspace, 'packages', 'app');
  await mkdir(path.join(workspace, '.agents', 'skills', 'release-check'), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(workspace, '.agents', 'skills', 'release-check', 'SKILL.md'), `---
name: release-check
description: Run the repository release checks
---

Release checks.
`);

  const result = runCovenCode(['skill', 'list'], {
    cwd: nested,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-check\s+project\s+Run the repository release checks/);
});

test('skill discovery includes the built-in building-skills skill', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const listResult = runCovenCode(['skill', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /building-skills\s+built-in\s+Create Coven Code skills for a codebase or workflow/);

  const showResult = runCovenCode(['skill', 'show', 'building-skills'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(showResult.status, 0, showResult.stderr);
  assert.match(showResult.stdout, /# Building Skills/);
});

test('covenCode.skills.path adds colon-separated skill search roots with home expansion', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const firstRoot = path.join(home, 'team-skills');
  const secondRoot = path.join(home, 'personal-skills');
  await mkdir(path.join(firstRoot, 'release'), { recursive: true });
  await mkdir(path.join(secondRoot, 'notes'), { recursive: true });
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(firstRoot, 'release', 'SKILL.md'), `---
name: release
description: Run the team release workflow
---

Release skill.
`);
  await writeFile(path.join(secondRoot, 'notes', 'SKILL.md'), `---
name: notes
description: Prepare personal notes
---

Notes skill.
`);
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.skills.path': `${firstRoot}:~/personal-skills`,
  }));

  const result = runCovenCode(['skill', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release\s+user\s+Run the team release workflow/);
  assert.match(result.stdout, /notes\s+user\s+Prepare personal notes/);
});

test('covenCode.skills.disableLegacySkillRoots hides legacy skill directories only', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.agents', 'skills', 'coven-code-native'), { recursive: true });
  await mkdir(path.join(workspace, '.claude', 'skills', 'project-legacy'), { recursive: true });
  await mkdir(path.join(home, '.claude', 'skills', 'user-legacy'), { recursive: true });
  await writeFile(path.join(workspace, '.agents', 'skills', 'coven-code-native', 'SKILL.md'), `---
name: coven-code-native
description: Coven Code native project skill
---

Coven Code native skill.
`);
  await writeFile(path.join(workspace, '.claude', 'skills', 'project-legacy', 'SKILL.md'), `---
name: project-legacy
description: Project legacy skill
---

Project legacy skill.
`);
  await writeFile(path.join(home, '.claude', 'skills', 'user-legacy', 'SKILL.md'), `---
name: user-legacy
description: User legacy skill
---

User legacy skill.
`);
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.skills.disableLegacySkillRoots': true,
  }));

  const result = runCovenCode(['skill', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /coven-code-native\s+project\s+Coven Code native project skill/);
  assert.doesNotMatch(result.stdout, /project-legacy/);
  assert.doesNotMatch(result.stdout, /user-legacy/);
});

test('skill-bundled mcp tools stay hidden until the skill is referenced', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const skillDir = path.join(workspace, '.agents', 'skills', 'ui-preview');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), `---
name: ui-preview
description: Preview local UI changes
---

Use browser tools for UI previews.
`);
  await writeFile(path.join(skillDir, 'mcp.json'), JSON.stringify({
    browser: {
      command: 'fake-browser-mcp',
      includeTools: ['navigate_page', 'take_screenshot'],
    },
  }));

  const base = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(base.status, 0, base.stderr);
  assert.deepEqual(JSON.parse(base.stdout.split('\n')[0]).mcp_servers, []);

  const withSkill = runCovenCode(['--execute', 'use the ui-preview skill to inspect the page', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(withSkill.status, 0, withSkill.stderr);
  const init = JSON.parse(withSkill.stdout.split('\n')[0]);
  assert.deepEqual(init.mcp_servers, [{ name: 'browser', status: 'connected' }]);
  assert.ok(init.tools.includes('mcp__browser__navigate_page'));
  assert.ok(init.tools.includes('mcp__browser__take_screenshot'));
});

test('--skills adds a one-run skill root for execute-mode skill MCP activation', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const skillsRoot = path.join(home, 'extra-skills');
  const skillDir = path.join(skillsRoot, 'data-map');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), `---
name: data-map
description: Map project data flows
---

Use data tools for map prompts.
`);
  await writeFile(path.join(skillDir, 'mcp.json'), JSON.stringify({
    mapper: {
      command: 'fake-mapper-mcp',
      includeTools: ['draw_graph'],
    },
  }));

  const base = runCovenCode(['--execute', 'use the data-map skill to draw a graph', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(base.status, 0, base.stderr);
  assert.deepEqual(JSON.parse(base.stdout.split('\n')[0]).mcp_servers, []);

  const withSkill = runCovenCode(['--skills', skillsRoot, '--execute', 'use the data-map skill to draw a graph', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(withSkill.status, 0, withSkill.stderr);
  const init = JSON.parse(withSkill.stdout.split('\n')[0]);
  assert.deepEqual(init.mcp_servers, [{ name: 'mapper', status: 'connected' }]);
  assert.ok(init.tools.includes('mcp__mapper__draw_graph'));
});
