import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { parseArgs } from 'node:util';
import { paths, readJson } from './config.js';
import { makeLark, runLark } from './lark.js';

const project = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', project), 'utf8'));

function problem(message) {
  process.exitCode = 1;
  console.error(message);
}

async function preflight() {
  const { values } = parseArgs({ options: {
    'node-only': { type: 'boolean' }, 'check-updates': { type: 'boolean' }, 'data-dir': { type: 'string' },
    'lark-cli': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return console.log('npm run preflight -- [--data-dir <目录>] [--lark-cli <路径>] [--check-updates]');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13) || !isBuiltin('node:sqlite')) {
    problem(`当前 Node.js ${process.version}。请安装支持 SQLite 的 Node.js ${manifest.engines.node}，然后重新打开终端。`);
    return;
  }
  console.log(`Node.js ${process.version} · 支持 SQLite`);
  if (values['node-only']) return;

  const dependency = '@botiverse/raft-sdk';
  const expected = manifest.dependencies[dependency];
  const installed = spawnSync('npm', ['ls', dependency, '--depth=0', '--json'], { cwd: project, encoding: 'utf8', timeout: 5000 });
  const sdk = installed.status === 0 ? JSON.parse(installed.stdout).dependencies?.[dependency] : null;
  if (sdk?.version === expected) console.log(`Raft SDK ${sdk.version} · 与项目锁定版本一致`);
  else problem(`Raft SDK 需要 ${expected}。请在项目目录运行 npm ci。`);

  const config = await readJson(paths(values['data-dir']).config, null);
  const binary = values['lark-cli'] || config?.larkBinary || 'lark-cli';
  const lark = makeLark(binary);
  try {
    console.log(await lark.requireReplySupport());
  } catch (error) {
    problem(error.code === 'LARK_START'
      ? '未找到可用的 lark-cli。初次安装请运行 npx @larksuite/cli@latest install，或用 --lark-cli 指定已安装的路径。'
      : error.message);
    return;
  }

  const profiles = await lark.profiles();
  if (!Array.isArray(profiles) || !profiles.length) {
    problem('尚无 Lark CLI profile。请先运行 lark-cli config init，再运行 lark-cli auth login --recommend。');
  } else {
    const authorized = profiles.filter((profile) => profile.tokenStatus === 'valid').length;
    if (authorized) console.log(`飞书 · ${authorized} 个已登录的 profile`);
    else problem('未发现已登录的飞书 profile。请运行 lark-cli auth login --recommend。');
  }

  if (values['check-updates']) {
    const result = await runLark(binary, ['update', '--check', '--json'], undefined, 10_000);
    if (result.action === 'already_up_to_date') console.log('Lark CLI 已是最新版本。');
    else if (/^\d+\.\d+\.\d+$/.test(result.latest_version ?? '')) {
      console.log(`Lark CLI 有可用版本 ${result.latest_version}。可运行 lark-cli update 升级。`);
    } else problem('未能确认 Lark CLI 的最新版本。可运行 lark-cli update --check 再查。');
  }
  if (!process.exitCode && !config?.bindings?.length) console.log('环境检查通过。运行 npm run setup 添加第一条绑定。');
}

preflight().catch((error) => problem(error.message));
