import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, constants, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureDirectory } from './config.js';
import { acquireLock, hash } from './store.js';

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

async function readDefinition(path) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function writeDefinition(path, definition) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, definition, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function rollback(error, restore) {
  try { await restore(); } catch (failure) {
    throw new Error(`${error.message}。恢复原服务失败：${failure.message}`, { cause: error });
  }
  throw error;
}

async function restoreDefinition(path, previous) {
  if (previous === null) await unlink(path);
  else await writeDefinition(path, previous);
}

async function prepareLog(files, verifyIdle) {
  await ensureDirectory(files);
  if (verifyIdle) {
    const unlock = acquireLock(files.lock);
    unlock();
  }
  const log = await open(files.log, 'a', 0o600);
  await log.close();
}

export function launchAgentPlist({ label, node, entry, home, environment, debug }) {
  const string = (value) => `<string>${xml(value)}</string>`;
  const argumentsXml = [node, entry, '--data-dir', home, 'run', '--managed', ...(debug ? ['--debug'] : [])].map(string).join('');
  const environmentXml = Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key>${string(value)}`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${argumentsXml}</array>
<key>EnvironmentVariables</key><dict>${environmentXml}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer>
<key>ExitTimeOut</key><integer>60</integer>
</dict></plist>
`;
}

export async function service(action, files, config, entry, debug = false) {
  if (!['install', 'start', 'stop', 'stop-if-running', 'remove'].includes(action)) throw new Error('用法：service install|start|stop|remove');
  if (process.platform === 'linux') return systemdService(action, files, config, entry, process.env, debug);
  if (action === 'stop-if-running' && process.platform !== 'darwin') return;
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
  const isLoaded = () => invoke(['print', target], true).status === 0;
  const unload = async () => {
    invoke(['bootout', target]);
    const deadline = Date.now() + 65_000;
    while (isLoaded()) {
      if (Date.now() >= deadline) throw new Error('等待 macOS 后台服务退出超时。');
      await delay(100);
    }
  };
  if (action === 'remove') {
    if (isLoaded()) await unload();
    await unlink(plist).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    console.log('已移除 macOS 后台服务，绑定和状态仍保留在本机。');
    return;
  }
  if (action === 'stop' || action === 'stop-if-running') {
    const loaded = isLoaded();
    if (!loaded && action === 'stop-if-running') return;
    if (loaded) await unload();
    console.log('后台服务已停止。');
    return;
  }
  if (action === 'start') {
    await access(plist);
    if (!isLoaded()) invoke(['bootstrap', domain, plist]);
    else invoke(['kickstart', target]);
    console.log(`后台服务已启动，日志在 ${files.log}`);
    return;
  }
  const environment = await serviceEnvironment(config, process.env);
  const definition = launchAgentPlist({ label, node: process.execPath, entry, home: files.home, environment, debug });
  const existing = await readDefinition(plist);
  const loaded = isLoaded();
  await prepareLog(files, !loaded);
  if (definition !== existing) {
    await writeDefinition(plist, definition);
    let unloaded = false;
    try {
      if (loaded) {
        await unload();
        unloaded = true;
      }
      invoke(['bootstrap', domain, plist]);
    } catch (error) {
      await rollback(error, async () => {
        await restoreDefinition(plist, existing);
        if (unloaded && existing !== null) {
          if (isLoaded()) await unload();
          invoke(['bootstrap', domain, plist]);
        }
      });
    }
  } else if (!loaded) {
    invoke(['bootstrap', domain, plist]);
  }
  console.log(`后台服务已启动，日志在 ${files.log}`);
}

function systemdQuote(value) {
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')
    .replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t') + '"';
}

export async function systemdService(action, files, config, entry, env = process.env, debug = false) {
  const unit = `raft-lark-bridge-${hash([files.home]).slice(0, 12)}.service`;
  const configHome = isAbsolute(env.XDG_CONFIG_HOME ?? '') ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  const path = join(configHome, 'systemd', 'user', unit);
  const systemctl = (args) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', env, timeout: 90_000 });
  const invoke = (...args) => {
    const result = systemctl(args);
    if (result.status !== 0) {
      const detail = result.stderr?.trim() || result.error?.message || `退出状态 ${result.status}`;
      throw new Error(`systemctl --user ${args[0]} 失败：${detail}`);
    }
  };
  if (action === 'stop-if-running') {
    const status = systemctl(['is-active', unit]);
    const state = status.stdout?.trim();
    const managerUnavailable = !state && (status.error || status.stderr?.trim());
    if (status.status === 0 || ['activating', 'reloading', 'deactivating'].includes(state) ||
        (managerUnavailable && await readDefinition(path) !== null)) {
      invoke('stop', unit);
      console.log('后台服务已停止。');
    }
    return;
  }
  if (action === 'start' || action === 'stop') {
    invoke(action, unit);
    console.log(action === 'start' ? `后台服务已启动，日志在 ${files.log}` : '后台服务已停止。');
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
  const command = [`:${process.execPath}`, entry, '--data-dir', files.home, 'run', '--managed', ...(debug ? ['--debug'] : [])].map(systemdQuote).join(' ');
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
  const existing = await readDefinition(path);
  const wasActive = existing !== null && systemctl(['is-active', '--quiet', unit]).status === 0;
  await prepareLog(files, !wasActive);
  const changed = definition !== existing;
  if (changed) {
    const wasEnabled = existing !== null && systemctl(['is-enabled', '--quiet', unit]).status === 0;
    await writeDefinition(path, definition);
    let enabling = false;
    let restarting = false;
    try {
      invoke('daemon-reload');
      enabling = true;
      invoke('enable', unit);
      restarting = true;
      invoke('restart', unit);
    } catch (error) {
      await rollback(error, async () => {
        try {
          if (enabling && !wasEnabled) invoke('disable', ...(existing === null ? ['--now'] : []), unit);
        } finally {
          await restoreDefinition(path, existing);
          invoke('daemon-reload');
          if (restarting && existing !== null) invoke(wasActive ? 'start' : 'stop', unit);
        }
      });
    }
  } else {
    invoke('enable', unit);
    invoke('start', unit);
  }
  console.log(`后台服务已启动，日志在 ${files.log}`);
}
