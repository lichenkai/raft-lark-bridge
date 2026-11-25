import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, constants, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { hash } from './store.js';

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function findExecutable(binary, path) {
  const candidates = binary.includes('/') ? [resolve(binary)] : (path ?? '').split(delimiter).filter(Boolean)
    .map((directory) => resolve(directory, binary));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error('后台服务找不到 lark-cli，请在配置里使用它的绝对路径。');
}

async function serviceEnvironment(config, env, ...extraPaths) {
  const executable = await findExecutable(config.larkBinary, env.PATH);
  const environment = {
    PATH: [dirname(executable), ...extraPaths, env.PATH, '/usr/local/bin:/usr/bin:/bin'].filter(Boolean).join(delimiter),
  };
  for (const name of ['LARKSUITE_CLI_CONFIG_DIR', 'LARKSUITE_CLI_DATA_DIR']) {
    if (env[name]) environment[name] = resolve(env[name]);
  }
  return environment;
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
  if (!['install', 'start', 'stop', 'remove'].includes(action)) throw new Error('用法：service install|start|stop|remove');
  if (process.platform === 'linux') return systemdService(action, files, config, entry);
  if (process.platform !== 'darwin') throw new Error('后台服务支持 macOS 和使用 systemd 的 Linux。可用 run 前台运行。');
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
  const environment = await serviceEnvironment(config, process.env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const log = await open(files.log, 'a', 0o600);
  await log.close();
  const definition = launchAgentPlist({ label, node: process.execPath, entry, home: files.home, log: files.log, environment });
  invoke(['bootout', target], true);
  await writeFile(plist, definition, { mode: 0o600 });
  invoke(['bootstrap', domain, plist]);
  console.log(`后台服务已安装并启动，日志在 ${files.log}`);
}

function systemdQuote(value) {
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')
    .replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t') + '"';
}

export async function systemdService(action, files, config, entry, env = process.env) {
  const unit = `raft-lark-bridge-${hash([files.home]).slice(0, 12)}.service`;
  const configHome = isAbsolute(env.XDG_CONFIG_HOME ?? '') ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  const path = join(configHome, 'systemd', 'user', unit);
  const invoke = (...args) => {
    const result = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', env, timeout: 90_000 });
    if (result.status !== 0) {
      const detail = result.stderr?.trim() || result.error?.message || `退出状态 ${result.status}`;
      throw new Error(`systemctl --user ${args[0]} 失败：${detail}`);
    }
  };
  const logHint = `journalctl --user -u ${unit}`;

  if (action === 'start' || action === 'stop') {
    invoke(action, unit);
    console.log(action === 'start' ? `后台服务已启动。查看日志：${logHint}` : '后台服务已停止。');
    return;
  }
  if (action === 'remove') {
    const installed = await access(path).then(() => true, (error) => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    if (installed) {
      invoke('disable', '--now', unit);
      await unlink(path);
    }
    invoke('daemon-reload');
    console.log('已移除 systemd 后台服务，绑定和状态仍保留在本机。');
    return;
  }

  invoke('show-environment');
  const environment = await serviceEnvironment(config, env, dirname(process.execPath));
  // The colon prefix disables variable substitution so dollar signs in paths stay literal.
  const command = [`:${process.execPath}`, entry, '--data-dir', files.home, 'run'].map(systemdQuote).join(' ');
  const assignments = Object.entries(environment).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join('\n');
  const definition = `[Unit]
Description=Raft Lark Bridge

[Service]
Type=exec
ExecStart=${command}
${assignments}
Restart=on-failure
RestartSec=15s
KillMode=mixed
TimeoutStopSec=60s
UMask=0077

[Install]
WantedBy=default.target
`;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, definition, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  invoke('daemon-reload');
  invoke('enable', unit);
  invoke('restart', unit);
  console.log(`后台服务已安装并启动。查看日志：${logHint}`);
}
