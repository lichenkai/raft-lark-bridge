#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CHAT_ID, HANDLE, MODES, ensureDirectory, findBinding, loadConfig, loadCredential, paths, raftOrigin, readJson, validateConfig, writeJson } from './config.js';
import { makeLark } from './lark.js';
import { makeRaft } from './raft.js';
import { bridgeCycle, previewBinding } from './bridge.js';
import { acquireLock, Store } from './store.js';
import { service } from './service.js';

process.umask(0o077);

const usage = `Raft ↔ Lark 本地桥接

  raft-lark-bridge setup                   添加一条身份、Agent、会话绑定
  raft-lark-bridge status                  查看绑定、队列和错误
  raft-lark-bridge doctor                  检查两端身份和消息读取
  raft-lark-bridge preview <绑定>           查看匹配预览
  raft-lark-bridge run [--once]            前台运行，或处理一轮
  raft-lark-bridge pause <绑定>             暂停绑定
  raft-lark-bridge resume <绑定>            恢复绑定
  raft-lark-bridge unbind <绑定>            解除绑定
  raft-lark-bridge service install|start|stop|remove  管理 macOS 后台服务

全局选项  --data-dir <目录>，默认 ~/.raft-lark-bridge
绑定参数可用名称或 status 显示的 ID。
`;

function clean(value) { return String(value ?? '').replace(/[\p{Cc}\u2028\u2029]/gu, ' '); }

function showError(error) { return `${clean(error.message)}${error.code ? ` [${clean(error.code)}]` : ''}`; }

function listOptions(rows) {
  rows.forEach((row, index) => console.log(`  ${index + 1}. ${clean(row)}`));
}

function indexOfAnswer(answer, count) {
  return /^\d+$/.test(answer) && Number(answer) >= 1 && Number(answer) <= count ? Number(answer) - 1 : -1;
}

async function selectOption(ask, prompt, options, { fallback, named = false } = {}) {
  for (;;) {
    const answer = (await ask(prompt)) || fallback;
    const selected = options[indexOfAnswer(answer, options.length)] ?? (named && options.find((row) => row.name === answer));
    if (selected) return selected;
    console.log('请选择列表中的有效选项。按 Ctrl+C 可退出配置。');
  }
}

function showPreview(samples) {
  if (!samples.length) return console.log('预览窗口内没有命中的文本消息。');
  for (const sample of samples) console.log(`  ${new Date(sample.sentAt).toLocaleString()}  ${clean(sample.content).slice(0, 120)}`);
}

function makeQuestions() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在终端中运行 setup。');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (muted) callback();
    else process.stdout.write(chunk, encoding, callback);
  } });
  output.columns = process.stdout.columns;
  const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const controller = new AbortController();
  rl.once('SIGINT', () => controller.abort());
  rl.once('close', () => controller.abort());
  const ask = (prompt) => rl.question(prompt, { signal: controller.signal }).then((answer) => answer.trim());
  return {
    ask,
    async secret(prompt) {
      process.stdout.write(prompt);
      muted = true;
      try { return await ask(''); } finally { muted = false; process.stdout.write('\n'); }
    },
    close: () => rl.close(),
  };
}

async function chooseChat(lark, profile, user, mode, ask) {
  let options = [];
  if (mode === 'dm') {
    try { options = await lark.recentDms(profile, user.userId); } catch (error) { console.log(showError(error)); }
  } else {
    const query = await ask('输入群名关键字查找，或直接输入 oc_ 会话 ID：');
    if (CHAT_ID.test(query)) return { id: query, name: query };
    if (query) options = await lark.groups(profile, query);
  }
  if (options.length) listOptions(options.map((chat) => `${chat.name} · ${chat.id}`));
  for (;;) {
    const choice = await ask(options.length ? '选择编号，或输入 oc_ 会话 ID：' : '输入 oc_ 会话 ID：');
    if (CHAT_ID.test(choice)) return { id: choice, name: choice };
    const index = indexOfAnswer(choice, options.length);
    if (index >= 0) return options[index];
    console.log('请选择列表中的会话，或输入以 oc_ 开头的会话 ID。');
  }
}

async function setup(files) {
  await ensureDirectory(files);
  const previous = await readJson(files.config, null);
  if (previous) validateConfig(previous);
  const questions = makeQuestions();
  const { ask } = questions;
  let token;
  try {
    console.log('\nRaft Lark Bridge · 绑定配置');
    console.log('配置会在你确认后保存。按 Ctrl+C 可随时退出。');
    console.log('\n1/4  选择飞书账号');
    const enteredBinary = previous?.larkBinary ?? ((await ask('lark-cli 路径 [lark-cli]：')) || 'lark-cli');
    const binary = /[/\\]/.test(enteredBinary) ? resolve(enteredBinary) : enteredBinary;
    const lark = makeLark(binary);
    const profiles = await lark.profiles();
    if (!Array.isArray(profiles) || !profiles.length) throw new Error('本机没有 Lark CLI profile，请先完成 lark-cli config init 和 auth login。');
    listOptions(profiles.map((row) => `${row.name} · ${row.user ?? '未登录'} · ${row.brand}`));
    const { name: profile } = await selectOption(ask, '选择飞书 profile [1]：', profiles, { fallback: '1', named: true });
    const user = await lark.identity(profile, true);
    console.log(`飞书身份  ${clean(user.userName)} · ${clean(user.brand)} · ${clean(user.userId)}`);

    console.log('\n2/4  连接 Raft');
    const url = previous?.raft.url ?? raftOrigin((await ask('Raft API 地址 [https://api.raft.build]：')) || 'https://api.raft.build');
    if (previous) token = await loadCredential(files);
    else {
      console.log('请在 Raft → Members → Connect an external agent 中创建桥接身份，选择 Build your own。');
      console.log('上面创建的身份负责转发消息。下一步会选择实际处理消息的 Agent。');
      token = await questions.secret('粘贴桥接用的 sk_agent_ 凭证（输入不会显示）：');
      if (!/^sk_agent_[A-Za-z0-9_-]+$/.test(token)) throw new Error('Raft 凭证格式无效。');
    }
    const raft = makeRaft(url, token);
    const context = await raft.context();
    if (previous && (context.serverId !== previous.raft.serverId || context.bridgeId !== previous.raft.bridgeId)) {
      throw new Error('当前凭证对应的 Raft 桥接身份与本地配置不同。');
    }
    console.log(`Raft 服务器  ${clean(context.serverName)} · 桥接身份 @${clean(context.bridgeName)}`);
    console.log('\n3/4  选择目标 Agent 和会话');
    const handle = (await ask('目标 Raft Agent 的 @handle：')).replace(/^@/, '');
    if (!HANDLE.test(handle)) throw new Error('请输入目标 Agent 的 @handle。');
    const agent = await raft.agent(handle);
    const modes = Object.entries(MODES);
    listOptions(modes.map(([, label]) => label));
    const [mode] = await selectOption(ask, '选择转发规则：', modes);
    const chat = await chooseChat(lark, profile, user, mode, ask);
    const name = (await ask(`给这条绑定命名 [${clean(chat.name)} → @${clean(agent.handle)}]：`)) || `${chat.name} → @${agent.handle}`;

    const binding = { id: randomUUID(), name, profile, ...user, agentId: agent.id, agentHandle: agent.handle,
      chatId: chat.id, mode, enabled: true, enabledAt: Date.now() };
    const config = validateConfig({
      version: 1, larkBinary: binary, raft: { url, serverId: context.serverId, bridgeId: context.bridgeId },
      pollSeconds: previous?.pollSeconds ?? 20, bindings: [...(previous?.bindings ?? []), binding],
    });
    console.log('\n4/4  预览并启用');
    console.log(`${MODES[mode]} ${clean(chat.name)} → @${clean(agent.handle)} → 以 ${clean(user.userName)} 身份回复原会话`);
    showPreview(await previewBinding(lark, binding));
    if (!/^(y|yes|是)$/i.test(await ask('保存并启用自动转发与本人身份回复？[y/N]：'))) {
      return console.log('未保存。');
    }
    binding.enabledAt = Date.now();
    if (!previous) await writeJson(files.credential, { token });
    await writeJson(files.config, config);
    const start = process.env.npm_lifecycle_event === 'setup' ? 'npm run doctor，然后运行 npm start' : 'raft-lark-bridge doctor，然后运行 raft-lark-bridge run';
    console.log(`已保存绑定 ${binding.id.slice(0, 8)}。运行 ${start}。`);
  } finally { questions.close(); }
}

async function doctor(config, lark, raft) {
  const context = await raft.context();
  assertRaftIdentity(config, context);
  console.log(`Raft 连接正常  ${clean(context.serverName)} · @${clean(context.bridgeName)}`);
  for (const binding of config.bindings) {
    try {
      const user = await lark.identity(binding.profile, true);
      const agent = await raft.agent(binding.agentHandle);
      if (agent.id !== binding.agentId) throw new Error('Raft Agent ID 已变化。');
      const samples = await previewBinding(lark, binding);
      console.log(`${clean(binding.name)}  ${clean(user.userName)} → @${clean(agent.handle)} · 读取检查通过，预览 ${samples.length} 条`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`${clean(binding.name)}  ${showError(error)}`);
    }
  }
  console.log('doctor 只检查身份与读取，没有发送消息。');
}

function assertRaftIdentity(config, context) {
  if (context.serverId !== config.raft.serverId || context.bridgeId !== config.raft.bridgeId) {
    throw new Error('Raft 凭证与本地绑定不匹配，请检查服务器和桥接身份。');
  }
}

function status(config, store) {
  console.log(`轮询间隔 ${config.pollSeconds} 秒`);
  for (const binding of config.bindings) {
    console.log(`\n${binding.id.slice(0, 8)}  ${binding.enabled ? '启用' : '暂停'}  ${clean(binding.name)}`);
    console.log(`  ${clean(binding.profile)} · ${MODES[binding.mode]} ${binding.chatId} → @${binding.agentHandle}`);
    const labels = { queued: '待转发', forwarded: '等回复', ready: '待回信', sent: '已回信', review: '待核对' };
    const counts = store.summary(binding.id).map(({ state, total }) => `${labels[state]} ${total}`).join(' · ');
    console.log(`  ${counts || '暂无处理记录'}`);
    for (const stage of ['scan', 'forward', 'reply']) {
      const health = store.get(`health:${binding.id}:${stage}`);
      if (health) console.log(`  ${{ scan: '读取', forward: '转发', reply: '回信' }[stage]} ${new Date(health.at).toLocaleString()}  ${health.code ?? '正常'}`);
    }
    for (const job of store.recentProblems(binding.id)) console.log(`  ${job.original_id}  ${labels[job.state]}  ${job.error}`);
  }
  const inbox = store.get('health:raft:inbox');
  if (inbox) console.log(`\nRaft 收件箱  ${new Date(inbox.at).toLocaleString()}  ${inbox.code ?? '正常'}`);
}

async function run(files, firstConfig, raft, once) {
  const unlock = acquireLock(files.lock);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let store;
  try {
    assertRaftIdentity(firstConfig, await raft.context());
    store = new Store(files.database);
    console.log('桥接正在运行。按 Ctrl+C 停止。');
    do {
      const config = await loadConfig(files);
      if (JSON.stringify(config.raft) !== JSON.stringify(firstConfig.raft)) throw new Error('Raft 配置已变化，请重启桥接。');
      const stats = await bridgeCycle({ config, store, raft, lark: makeLark(config.larkBinary), loadCurrentConfig: () => loadConfig(files),
        stopped: () => controller.signal.aborted,
        log: ({ stage, binding, code }) => console.error(`${new Date().toISOString()}  ${stage}  ${clean(binding)}  ${code}`),
      });
      if (once || Object.values(stats).some(Boolean)) {
        console.log(`本轮入队 ${stats.queued} · 转发 ${stats.forwarded} · 回复 ${stats.replied} · 错误 ${stats.errors}`);
      }
      if (once) { if (stats.errors) process.exitCode = 1; break; }
      if (!controller.signal.aborted) await delay(config.pollSeconds * 1000, undefined, { signal: controller.signal }).catch((error) => {
        if (error.name !== 'AbortError') throw error;
      });
    } while (!controller.signal.aborted);
  } finally {
    store?.close();
    unlock();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'data-dir': { type: 'string' }, once: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const [command, argument, ...extra] = positionals;
  if (!command || values.help || command === 'help') return console.log(usage);
  if (extra.length || (values.once && command !== 'run')) throw new Error('参数无效。请运行 --help。');
  const files = paths(values['data-dir']);
  if (command === 'setup' && !argument) return setup(files);
  await ensureDirectory(files);
  const config = await loadConfig(files);
  if (command === 'service') return service(argument, files, config, fileURLToPath(import.meta.url));
  if (command === 'status' && !argument) {
    const store = new Store(files.database);
    try { return status(config, store); } finally { store.close(); }
  }
  if (['pause', 'resume', 'unbind'].includes(command) && argument) {
    const binding = findBinding(config, argument);
    if (command === 'unbind') config.bindings = config.bindings.filter((row) => row.id !== binding.id);
    else binding.enabled = command === 'resume';
    await writeJson(files.config, config);
    console.log(`${clean(binding.name)}  ${{ pause: '已暂停', resume: '已恢复', unbind: '已解除绑定' }[command]}`);
    return;
  }
  const lark = makeLark(config.larkBinary);
  if (command === 'preview' && argument) return showPreview(await previewBinding(lark, findBinding(config, argument)));
  if (!['doctor', 'run'].includes(command) || argument) throw new Error('用法无效。请运行 --help。');
  const raft = makeRaft(config.raft.url, await loadCredential(files));
  if (command === 'doctor') return doctor(config, lark, raft);
  return run(files, config, raft, values.once);
}

main().catch((error) => {
  if (error.name === 'AbortError') { process.exitCode = 130; return; }
  console.error(showError(error));
  process.exitCode = 1;
});
