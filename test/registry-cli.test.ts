import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cliPath, copyFixtureSource, editModuleJson, readText, writeText } from './registry-fixture.js';

function cli(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--root', root], { encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd: root,
    env: gitEnv,
    stdio: 'pipe',
  });
}

function committedRegistry(): string {
  const root = copyFixtureSource();
  assert.equal(cli(root, 'build').status, 0);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

describe('registry CLI', () => {
  it('builds, then check passes and a second build adds nothing', () => {
    const root = copyFixtureSource();
    const first = cli(root, 'build');
    assert.equal(first.status, 0);
    assert.match(first.stdout, /Added alpha-tools@1.0.0/);
    assert.equal(cli(root, 'check').status, 0);
    assert.match(cli(root, 'build').stdout, /Nothing to add/);
  });

  it('exits 1 and names the problem on stderr for a changed published version', () => {
    const root = committedRegistry();
    writeText(root, 'modules/alpha-tools/src/functions/alpha-helpers.js', 'export const changed = true;\n');
    const result = cli(root, 'build');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /alpha-tools@1\.0\.0 is already published and its content changed; bump "version"/);
  });

  it('exits 1 on usage errors', () => {
    assert.equal(spawnSync(process.execPath, [cliPath], { encoding: 'utf-8' }).status, 1);
  });

  it('check --base catches a hand-edited old version even when the sha256 is edited to match', () => {
    const root = committedRegistry();
    const file = 'registry/alpha-tools/1.0.0.json';
    const edited = readText(root, file).replace('Hello', 'Hi');
    writeText(root, file, edited);
    const manifest = JSON.parse(readText(root, 'registry/registry.json'));
    manifest.modules[0].versionDetails[0].sha256 = execFileSync('sha256sum', [`${root}/${file}`], { encoding: 'utf-8' }).split(' ')[0];
    writeText(root, 'registry/registry.json', JSON.stringify(manifest, null, 2) + '\n');

    assert.equal(cli(root, 'check').status, 1, 'without --base the source no longer matches either');
    const result = cli(root, 'check', '--base', 'HEAD');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /registry\/alpha-tools\/1\.0\.0\.json: published version file was modified/);
  });

  it('check --base passes after a clean bump and build', () => {
    const root = committedRegistry();
    writeText(root, 'modules/alpha-tools/src/functions/alpha-helpers.js', 'export const changed = true;\n');
    editModuleJson(root, 'alpha-tools', (json) => (json.version = '1.0.1'));
    assert.equal(cli(root, 'build').status, 0);
    const result = cli(root, 'check', '--base', 'HEAD');
    assert.equal(result.status, 0, result.stderr);
  });

  it('check --base passes when the base has no registry/', () => {
    const root = copyFixtureSource();
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'no registry yet');
    assert.equal(cli(root, 'build').status, 0);
    assert.equal(cli(root, 'check', '--base', 'HEAD').status, 0);
  });
});
