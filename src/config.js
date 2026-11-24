import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MODES = { dm: '指定单聊', group: '指定群聊', mention: '指定群聊 @我' };
export const CHAT_ID = /^oc_[\w-]+$/;
export const USER_ID = /^ou_[\w-]+$/;
export const MESSAGE_ID = /^om_[\w-]+$/;
export const HANDLE = /^[\p{L}\p{N}_.-]+$/u;

export function paths(directory = process.env.RAFT_LARK_BRIDGE_HOME) {
  const home = resolve(directory || join(homedir(), '.raft-lark-bridge'));
  return {
    home,
    config: join(home, 'config.json'),
    credential: join(home, 'raft-credential.json'),
    database: join(home, 'bridge.sqlite'),
    lock: join(home, 'run-lock.sqlite'),
    log: join(home, 'bridge.log'),
  };
}

export function raftOrigin(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('请输入 Raft API 地址，例如 https://api.raft.build。'); }
  if (url.origin === 'https://app.raft.build') return 'https://api.raft.build';
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('Raft API 地址应为 HTTPS 站点根地址。本机测试允许 HTTP。');
  }
  return url.origin;
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    if (error instanceof SyntaxError) throw new Error(`配置文件格式错误：${file}`);
    throw error;
  }
}

export async function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function ensureDirectory(files) {
  await mkdir(files.home, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && ((await stat(files.home)).mode & 0o077)) {
    throw new Error('桥接数据目录可被其他系统用户访问。请指定一个权限为 700 的目录。');
  }
}

function validBinding(binding) {
  return binding && /^[a-f0-9-]{36}$/.test(binding.id) &&
    typeof binding.name === 'string' && binding.name.trim() &&
    typeof binding.profile === 'string' && binding.profile.trim() && typeof binding.appId === 'string' &&
    USER_ID.test(binding.userId) && ['lark', 'feishu'].includes(binding.brand) &&
    typeof binding.agentId === 'string' && binding.agentId.length > 0 && HANDLE.test(binding.agentHandle) &&
    CHAT_ID.test(binding.chatId) && Object.hasOwn(MODES, binding.mode) &&
    Number.isSafeInteger(binding.enabledAt) && binding.enabledAt > 0 && typeof binding.enabled === 'boolean';
}

export function validateConfig(config) {
  if (!config || config.version !== 1 || typeof config.larkBinary !== 'string' || !config.larkBinary ||
      !config.raft || raftOrigin(config.raft.url) !== config.raft.url ||
      typeof config.raft.serverId !== 'string' || !config.raft.serverId ||
      typeof config.raft.bridgeId !== 'string' || !config.raft.bridgeId ||
      !Number.isSafeInteger(config.pollSeconds) || config.pollSeconds < 5 || config.pollSeconds > 3600 ||
      !Array.isArray(config.bindings) || !config.bindings.every(validBinding)) {
    throw new Error('桥接配置不完整或包含无效字段。请运行 setup 检查。');
  }
  const ids = new Set();
  const routes = new Set();
  for (const binding of config.bindings) {
    const route = [binding.brand, binding.appId, binding.userId, binding.chatId].join(':');
    if (ids.has(binding.id) || routes.has(route)) {
      throw new Error('同一飞书身份和会话只能配置一条绑定，请移除冲突规则。');
    }
    ids.add(binding.id);
    routes.add(route);
  }
  return config;
}

export async function loadConfig(files) {
  const config = await readJson(files.config, null);
  if (!config) throw new Error('还没有配置。请先运行 setup。');
  return validateConfig(config);
}

export async function loadCredential(files) {
  const info = await stat(files.credential);
  if (process.platform !== 'win32' && (info.mode & 0o077)) {
    throw new Error('Raft 凭证文件权限过宽。请将文件权限设为 600。');
  }
  const { token } = await readJson(files.credential);
  if (typeof token !== 'string' || !/^sk_agent_[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Raft 凭证无效。');
  }
  return token;
}

export function findBinding(config, query) {
  const matches = config.bindings.filter((binding) => binding.id.startsWith(query) || binding.name === query);
  if (matches.length !== 1) throw new Error('绑定不存在或有重名，请使用 status 显示的绑定 ID。');
  return matches[0];
}
