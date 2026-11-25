import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { paths } from '../src/config.js';
import { systemdService } from '../src/service.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'raft-lark-systemd-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = join(directory, 'calls.jsonl');
  await writeFile(join(directory, 'systemctl'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n');
if (args.includes(process.env.TEST_FAIL_COMMAND)) {
  console.error('mock systemctl failure');
  process.exitCode = 1;
}
`, { mode: 0o700 });
  await writeFile(join(directory, 'lark-cli'), '', { mode: 0o700 });
  const env = {
    PATH: directory,
    XDG_CONFIG_HOME: join(directory, 'config home'),
    LARKSUITE_CLI_CONFIG_DIR: join(directory, 'lark config %u'),
    LARKSUITE_CLI_DATA_DIR: join(directory, 'lark data ${HOME}'),
    TEST_CALLS: calls,
  };
  const files = paths(join(directory, 'data %h ${HOME} "quote" \\path'));
  const entry = join(directory, 'checkout', 'cli.js');
  const config = { larkBinary: 'lark-cli' };
  const readCalls = async () => (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  const run = (action) => systemdService(action, files, config, entry, env);
  const manage = (action) => process.platform === 'linux'
    ? exec(process.execPath, [cli, '--data-dir', files.home, 'service', action], { env })
    : run(action);
  return { env, readCalls, run, manage };
}

test('systemd installs, manages and removes a user service for the configured data directory', async (t) => {
  const { env, run, readCalls, manage } = await fixture(t);
  await run('install');
  const calls = await readCalls();
  const unit = calls[2][2];
  assert.match(unit, /^raft-lark-bridge-[a-f0-9]{12}\.service$/);
  const path = join(env.XDG_CONFIG_HOME, 'systemd', 'user', unit);
  const definition = await readFile(path, 'utf8');
  assert.match(definition, /ExecStart=":\/[^"]+" "[^"]+" "--data-dir" "[^\n]+ %%h \$\{HOME\} \\"quote\\" \\\\path" "run"/);
  assert.ok(definition.includes('Environment="LARKSUITE_CLI_CONFIG_DIR=' + env.LARKSUITE_CLI_CONFIG_DIR.replace('%', '%%') + '"'));
  assert.ok(definition.includes('Environment="LARKSUITE_CLI_DATA_DIR=' + env.LARKSUITE_CLI_DATA_DIR + '"'));
  assert.ok(definition.includes(`Environment="PATH=${env.PATH}:${dirname(process.execPath)}:`));
  assert.match(definition, /Restart=on-failure\nRestartSec=15s/);
  assert.match(definition, /KillMode=mixed\nTimeoutStopSec=60s/);
  assert.match(definition, /WantedBy=default.target/);
  // The CLI can still manage an installed service when the data directory is unavailable.
  await manage('start');
  await manage('stop');
  await manage('remove');
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  assert.deepEqual(await readCalls(), [
    ['--user', 'show-environment'],
    ['--user', 'daemon-reload'],
    ['--user', 'enable', unit],
    ['--user', 'restart', unit],
    ['--user', 'start', unit],
    ['--user', 'stop', unit],
    ['--user', 'disable', '--now', unit],
    ['--user', 'daemon-reload'],
  ]);
});

test('systemd reports an unavailable user manager before attempting installation', async (t) => {
  const { env, run, readCalls } = await fixture(t);
  env.TEST_FAIL_COMMAND = 'show-environment';
  await assert.rejects(run('install'), /systemctl --user.*mock systemctl failure/);
  assert.deepEqual(await readCalls(), [['--user', 'show-environment']]);
});
