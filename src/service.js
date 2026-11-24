import { spawnSync } from 'node:child_process';
import { mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { constants, access } from 'node:fs/promises';
import { hash } from './store.js';

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function findExecutable(binary) {
  const candidates = binary.includes('/') ? [resolve(binary)] : (process.env.PATH ?? '').split(delimiter).filter(Boolean)
    .map((directory) => resolve(directory, binary));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error('后台服务找不到 lark-cli，请在配置里使用它的绝对路径。');
}

export function launchAgentPlist({ label, node, entry, home, log, environment }) {
  const string = (value) => `<string>${xml(value)}</string>`;
  const argumentsXml = [node, entry, '--data-dir', home, 'run'].map(string).join('');
  const environmentXml = Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key>${string(value)}`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${argumentsXml}</array>
<key>EnvironmentVariables</key><dict>${environmentXml}</dict>
<key>StandardOutPath</key>${string(log)}
<key>StandardErrorPath</key>${string(log)}
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer>
</dict></plist>
`;
}

export async function service(action, files, config, entry) {
  if (process.platform !== 'darwin') throw new Error('自动安装后台服务目前支持 macOS。可用 run 前台运行。');
  const label = `local.raft-lark-bridge.${hash([files.home]).slice(0, 12)}`;
  const directory = join(homedir(), 'Library', 'LaunchAgents');
  const plist = join(directory, `${label}.plist`);
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${label}`;
  const invoke = (args, optional = false) => {
    const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
    if (!optional && result.status !== 0) throw new Error(result.stderr?.trim() || 'launchctl 操作失败。');
    return result;
  };
  if (action === 'remove') {
    invoke(['bootout', target], true);
    await unlink(plist).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    console.log('已移除 macOS 后台服务，绑定和状态仍保留在本机。');
    return;
  }
  if (action === 'stop') {
    invoke(['bootout', target]);
    console.log('后台服务已停止。');
    return;
  }
  if (action === 'start') {
    await access(plist);
    if (invoke(['print', target], true).status !== 0) invoke(['bootstrap', domain, plist]);
    else invoke(['kickstart', target]);
    console.log(`后台服务已启动，日志在 ${files.log}`);
    return;
  }
  if (action !== 'install') throw new Error('用法：service install|start|stop|remove');
  const executable = await findExecutable(config.larkBinary);
  const path = [dirname(executable), process.env.PATH, '/usr/bin:/bin'].filter(Boolean).join(':');
  const environment = { PATH: path };
  if (process.env.LARKSUITE_CLI_CONFIG_DIR) environment.LARKSUITE_CLI_CONFIG_DIR = resolve(process.env.LARKSUITE_CLI_CONFIG_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const log = await open(files.log, 'a', 0o600);
  await log.close();
  const definition = launchAgentPlist({ label, node: process.execPath, entry, home: files.home, log: files.log, environment });
  invoke(['bootout', target], true);
  await writeFile(plist, definition, { mode: 0o600 });
  invoke(['bootstrap', domain, plist]);
  console.log(`后台服务已安装并启动，日志在 ${files.log}`);
}
