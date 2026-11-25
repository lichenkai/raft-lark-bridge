import { createRaftClient } from '@botiverse/raft-sdk';
import { createRaftAgent } from '@botiverse/raft-sdk/agent';
import { HANDLE } from './config.js';
import { BridgeError } from './lark.js';

function usable(result, label) {
  if (result.ok) return result.data;
  const error = result.error ?? {};
  const code = error.errorCode ?? error.serverCode ?? error.code ?? error.reason ?? 'RAFT_ERROR';
  const safeCode = /^[\w.-]{1,90}$/.test(code) ? code : 'RAFT_ERROR';
  const status = result.status ?? error.status;
  const retryable = status === 429 || status >= 500 || error.kind === 'transport' || code === 'TRANSPORT_ERROR';
  throw new BridgeError(`Raft ${label}失败。`, safeCode, retryable);
}

function forwardReceipt(data) {
  if (!['sent', 'committed'].includes(data.state) || !/^[a-f0-9]{8}/i.test(data.messageId ?? '')) {
    throw new BridgeError('Raft 没有确认消息已经发送。', 'RAFT_FORWARD_UNCONFIRMED', true);
  }
  return data.messageId;
}

export function makeRaft(serverUrl, credential, fetch = globalThis.fetch) {
  const fetchWithTimeout = (input, options = {}) => fetch(input, {
    ...options,
    redirect: 'error',
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  const options = { serverUrl, credential, fetch: fetchWithTimeout, retry: { attempts: 1 } };
  const client = createRaftClient(options);
  const reader = createRaftAgent(options);
  return {
    async context() {
      const data = usable(await client.agent.context(), '身份检查');
      if (!data.agent.external || !['send', 'read'].every((scope) => data.capabilities.includes(scope))) {
        throw new BridgeError('请使用有 send 和 read 权限的 Raft External Agent 凭证。', 'RAFT_BRIDGE_CREDENTIAL');
      }
      return { serverId: data.server.id, serverName: data.server.name, bridgeId: data.agent.id, bridgeName: data.agent.name };
    },
    async agent(handle) {
      if (!HANDLE.test(handle)) throw new BridgeError('请输入有效的 Raft Agent handle。', 'RAFT_INVALID_HANDLE');
      let result = await client.profile.show({ target: `@${handle}` });
      if ((result.ok && result.data.kind === 'human') || (!result.ok && result.status === 404)) {
        result = await client.profile.show({ target: `@${handle}~agent` });
      }
      const data = usable(result, '查询 Agent');
      if (data.kind !== 'agent' || data.isSelf || data.deletedAt || !HANDLE.test(data.name)) {
        throw new BridgeError('目标应是另一个可见的 Raft Agent。', 'RAFT_INVALID_AGENT');
      }
      return { id: data.id, handle: data.name, name: data.displayName ?? data.name };
    },
    async forward(binding, content, key) {
      const request = { target: `dm:@${binding.agentHandle}~agent`, content, idempotencyKey: key };
      let data = usable(await client.messages.send(request), '转发');
      if (data.state === 'held' && (data.subtype === 'freshness' || !data.subtype)) {
        data = usable(await client.messages.send({ ...request, continueAnyway: true }), '继续转发');
      }
      return forwardReceipt(data);
    },
    async reconcileForward(binding, key) {
      const request = { target: `dm:@${binding.agentHandle}~agent`, idempotencyKey: key, reconcileOnly: true };
      const data = usable(await client.messages.send(request), '核对转发回执');
      return data.state === 'not_found' ? null : forwardReceipt(data);
    },
    async inbox(since) {
      const data = usable(await reader.inbox.check({ ...(since == null ? {} : { since }), ack: 'cursor', limit: 100 }), '读取收件箱');
      if (data.ackMode !== 'cursor') {
        throw new BridgeError('该 Raft 服务器没有返回游标确认模式，请更新 Raft 后再启用桥接。', 'RAFT_CURSOR_UNAVAILABLE');
      }
      return data;
    },
  };
}

export function threadKey(target) {
  const parts = /^dm:@([^:\s~]+)(?:~agent)?:([a-f0-9]{8})$/i.exec(target);
  return parts ? `${parts[1].toLowerCase()}:${parts[2].toLowerCase()}` : null;
}

export function threadReply(message) {
  const thread = threadKey(message.target);
  if (!thread || message.sender.type !== 'agent' || !message.id || typeof message.content !== 'string') return null;
  if (message.raw?.posted_by || message.raw?.voiceCallId || message.raw?.delegated_by || message.raw?.delegatedBy) return null;
  if (message.raw?.message_card || message.raw?.messageCard) return null;
  const marked = /^\/lark-reply(?:[ \t]*\r?\n|$)([\s\S]*)$/.exec(message.content.trim());
  const text = marked ? marked[1].trim() : message.content;
  if (!text.trim()) return null;
  return { thread, text, senderId: message.raw?.sender_id ?? message.raw?.senderId ?? null };
}
