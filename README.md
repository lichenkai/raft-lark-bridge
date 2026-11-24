<p align="center">
  <img src="./docs/assets/brand.svg" width="760" alt="Raft Lark Bridge · Your Lark account, connected to Raft">
</p>

<p align="center">
  <img src="./docs/assets/badge-node.svg" alt="Node.js 22.13+">
  <img src="./docs/assets/badge-lark.svg" alt="lark-cli 1.0.100">
  <img src="./docs/assets/badge-macos.svg" alt="macOS LaunchAgent">
</p>

<p align="center"><strong>选定会话，以你的身份原路回复。</strong></p>

<a name="language"></a>
<p align="center"><a href="#zh-cn">中文</a> · <a href="#english">English</a></p>

<a name="zh-cn"></a>

- **指定要转发的飞书消息。** 支持单聊、群聊，以及指定群里 @ 你的消息。
- **让 Raft Agent 处理，以你的飞书身份回复。** 正式答复会引用原消息，发回原会话。
- **为不同 Agent 分别配置规则。** 一个本地桥接服务可管理多条绑定，支持预览、暂停和恢复。

## 快速开始

### 1. 安装项目并检查飞书账号

需要 Node.js 22.13+ 和已授权的 `lark-cli`。桥接按 `lark-cli` 1.0.100 的命令与输出格式开发。先确认当前终端能找到两个命令，并能列出你想用的飞书账号。

```bash
node --version
lark-cli --version
lark-cli profile list

git clone https://github.com/lichenkai/raft-lark-bridge.git
cd raft-lark-bridge
npm ci
```

如果已在该目录中，从 `npm ci` 开始。首次使用 Lark CLI 时，先按官方指引配置应用和用户授权。选定的 profile 需要能以用户身份搜索并读取消息正文，也需要具备以用户身份回复的权限。团队账号的权限由所在组织管理。 [Lark CLI 安装与授权](https://github.com/larksuite/cli/blob/main/README.zh.md)

### 2. 在 Raft 创建桥接身份

在目标 Agent 所在的 Raft 服务器，打开 **Members → Connect an external agent → Build your own**，创建一个桥接身份，例如 `@lark-bridge`。复制它的 `sk_agent_…` 凭证，留给配置向导。桥接需要 `read` 和 `send` 权限。处理消息的目标 Agent 可以是已有的 `@helpdesk`。 [Raft External Agent 接入](https://docs.raft.build/developers/sdk/external-agents/)

### 3. 用向导添加第一条绑定

```bash
npm run setup
```

| 向导字段 | 怎么填 | 示例 |
| --- | --- | --- |
| `lark-cli` 路径与 profile | 路径在 `PATH` 里时直接回车，再选已登录的 profile | `lark-cli` · `work` |
| Raft API 地址 | Raft 托管版用默认地址。自托管环境填写 API 的 HTTPS 根地址 | `https://api.raft.build` |
| 桥接凭证 | 粘贴上一步创建的 `sk_agent_…`，输入会隐藏 | `@lark-bridge` 的凭证 |
| 目标 Agent | 输入负责处理消息的 Agent 的 `@handle` | `@helpdesk` |
| 转发规则与会话 | 选择单聊、群聊或群里 `@我`。从近期单聊选择，按群名搜索，或输入 `oc_…` | `指定群聊 @我` · `支持群` |
| 绑定名称与保存 | 用容易辨认的名称。预览命中情况后输入 `y` 启用 | `支持群 @我 → @helpdesk` |

三种规则的差别在于哪类消息会命中。

| 规则 | 转发范围 |
| --- | --- |
| 指定单聊 | 选定单聊里其他人发来的纯文本消息 |
| 指定群聊 | 选定群里其他人发来的纯文本消息 |
| 指定群聊 @我 | 选定群里 @ 当前 profile 登录账号的纯文本消息 |

新绑定从保存时开始，预览用来核对规则。再次运行 `setup` 可以绑定其他会话或 Agent，同一飞书身份下的同一会话只允许一条绑定。找不到会话时，可以在 Lark CLI 的群聊搜索或单聊消息搜索结果里找 `chat_id`。 [Lark CLI 群聊搜索](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-chat-search.md) · [Lark CLI 消息搜索](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-search.md)

### 4. 验证第一条回复

```bash
npm run doctor
npm start
```

1. 用另一个账号在选定会话发一条新的纯文本消息。如果选的是 `@我` 规则，请在消息里 @ 绑定的飞书账号。
2. 在 Raft 打开桥接身份与目标 Agent 的私聊。确认转发消息抵达后，在那条消息的线程里检查 Agent 的答复。它会收到回复约定，正式答复的首行必须单独写 `/lark-reply`，第二行起写正文。

   ```text
   /lark-reply
   收到，我来跟进这件事。
   ```

3. 回到飞书，确认回复引用的是原消息，发送者是绑定的飞书账号。在另一个终端运行 `npm run status`，对应绑定应出现「已回信」。

> [!TIP]
> `doctor` 只检查身份和读取权限。第一条真实回复最适合在测试会话验证。默认每 20 秒轮询一次，消息可见的时间也受飞书搜索索引影响。

## 让 Agent 引导配置

支持 [Agent Skills](https://vercel.com/docs/agent-resources/skills) 的客户端可以安装本仓库的 [raft-lark-bridge Skill](skills/raft-lark-bridge/SKILL.md)。Skills CLI 会引导选择安装到哪个 Agent。

```bash
npx skills add lichenkai/raft-lark-bridge --skill raft-lark-bridge
```

安装后可以对 Agent 说「帮我把飞书支持群里 @ 我的消息绑定到 Raft 的 `@helpdesk`」。Agent 会检查本机的 CLI 和登录状态，协助你选规则并解释检查结果。首次连接 Raft 时，在本机终端的隐藏提示中输入桥接凭证。Skill 和 npm 向导使用同一套本地配置。

## 管理绑定

再次运行 `npm run setup` 就能添加另一条绑定。命令中的 `<绑定>` 可以用绑定名称，也可以用 `status` 显示的 ID。

| 命令 | 用途 |
| --- | --- |
| `npm run status` | 查看绑定、队列和近期错误 |
| `npm run bridge -- preview <绑定>` | 预览命中的消息，无需转发 |
| `npm run bridge -- pause <绑定>` | 暂停绑定，已经提交的请求仍可能完成 |
| `npm run bridge -- resume <绑定>` | 继续处理待办消息，从保存的位置补读 |
| `npm run bridge -- unbind <绑定>` | 解除绑定 |
| `npm run bridge -- run --once` | 执行一轮实际转发和回复 |

同一飞书登录身份与会话的组合只允许一条绑定。更改规则时，先解除旧绑定，再运行 `setup`。配置、Raft 凭证和 SQLite 数据库默认存放在 `~/.raft-lark-bridge`。可以用 `--data-dir <目录>` 管理独立的配置，例如为另一台 Raft 服务器建立桥接。

## macOS 后台运行

先停止前台进程，再用运行 `lark-cli` 的同一个 macOS 账号安装并启动用户级 LaunchAgent。

```bash
npm run bridge -- service install
```

把命令末尾的 `install` 换成 `stop`、`start` 或 `remove` 管理后台服务。状态和错误代码写入数据目录中的 `bridge.log`。绑定修改在下一轮生效。移动安装位置后，重新运行 `service install`。需要前台运行时使用 `npm start`。

## 消息投递与数据

- **收消息。** 默认每 20 秒轮询飞书搜索，查询时间窗口会重叠，并按消息 ID 去重。新绑定从保存时开始处理。新消息查询的速度和覆盖范围取决于飞书搜索索引。
- **回复和重试。** 桥接先把回复保存到 SQLite，再推进 Raft 收件箱游标。重试会复用幂等键。标记为「待核对」的回复，需要先检查 Raft 线程和飞书原会话，再手动补发。
- **身份和可见范围。** 每条绑定都会在发送前核对飞书应用和登录用户。Lark 凭证由 `lark-cli` 管理，Raft 桥接凭证保存在本机仅当前用户可读的文件中。命中的消息会进入 Raft 私聊，参与的 Agent、其创建者以及服务器所有者或管理员可以查看。 [Raft 私聊可见性](https://docs.raft.build/features/messaging/channels/)

## 常见问题

| 现象 | 怎么检查 |
| --- | --- |
| 向导找不到 `lark-cli` 或已登录账号 | 在运行桥接的同一个系统账号下执行 `lark-cli profile list`。向导也接受 `lark-cli` 的绝对路径。 |
| 预览为空 | 检查选的是哪个 profile、会话和规则。用另一个账号发纯文本测试。如果选了 `@我`，发信人要明确 @ 绑定的账号。 |
| Raft 收到了消息，飞书没有回复 | 检查答复是否来自绑定的 Agent、是否在原转发消息的线程里，且首行是否为 `/lark-reply`。再用 `status` 查看回信阶段错误。 |
| `LARK_USER_AUTH` 或 `LARK_IDENTITY_CHANGED` | 检查原 profile 是否仍用同一个用户授权。如果要改用新账号，解除旧绑定后重新运行 `setup`。 |
| `LARK_DETAILS_UNAVAILABLE` 或「待核对」 | 前者表示搜索未拿到消息详情，请检查应用的消息读取权限。待核对的回信需要先查看原会话是否已经收到，再决定是否手动补发。 |

## 分享和开发

可以把项目目录或本地 npm 安装包发给同事。同事在自己的电脑上用本人的 Lark 登录和独立的 Raft External Agent 凭证运行 `setup`。绑定配置和运行数据也保留在各自的电脑上。

```bash
npm test
npm pack --dry-run
```

测试使用模拟的 Lark 和 Raft 服务，覆盖多身份、倒序回复、重启、身份变化、分页、重试和去重。本地试用期间包保留私有设置。公开项目时再选择许可证和发布渠道。

[飞书消息搜索](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-search.md) · [飞书原消息回复](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-reply.md) · [Raft External Agent 接入](https://docs.raft.build/developers/sdk/external-agents/)

[返回语言入口](#language)

---

## English

[中文](#zh-cn) · [Back to the top](#language)

- **Choose which Lark messages to forward.** Select a direct chat, a group chat, or messages that @mention you in a specific group.
- **Have a Raft agent respond as you.** Its final answer goes back to the original Lark message using your signed-in account.
- **Manage multiple bindings locally.** Preview, pause, and resume each agent's routing rules independently.

### Quick start

#### 1. Install and check your Lark account

You need Node.js 22.13+ and an authorized `lark-cli` profile. The bridge was built against the command and output formats of `lark-cli` 1.0.100. Check that both commands are on your `PATH` and the profile you intend to use appears in the list.

```bash
node --version
lark-cli --version
lark-cli profile list

git clone https://github.com/lichenkai/raft-lark-bridge.git
cd raft-lark-bridge
npm ci
```

If you already have the project directory, start with `npm ci`. For a first-time Lark CLI setup, follow the official instructions to configure an app and authorize the user account. The selected profile needs permission to search and read message bodies as the user and to reply as the same user. Your organization manages permissions for team accounts. [Lark CLI setup and authorization](https://github.com/larksuite/cli#installation)

#### 2. Create a bridge identity in Raft

On the Raft server that hosts the target agent, open **Members → Connect an external agent → Build your own**. Create a bridge identity, for example `@lark-bridge`, and copy its `sk_agent_…` credential for setup. The bridge needs `read` and `send` scopes. An existing agent such as `@helpdesk` can handle the messages. [Raft External Agents](https://docs.raft.build/developers/sdk/external-agents/)

#### 3. Add your first binding

```bash
npm run setup
```

| Wizard field | What to enter | Example |
| --- | --- | --- |
| `lark-cli` path and profile | Accept the default for a binary on `PATH`, then pick a signed-in profile | `lark-cli` · `work` |
| Raft API URL | Use the default for hosted Raft. For self-hosted Raft, enter the HTTPS API root | `https://api.raft.build` |
| Bridge credential | Paste the `sk_agent_…` credential from the previous step. The input is hidden | Credential for `@lark-bridge` |
| Target agent | Enter the `@handle` of the agent that will process messages | `@helpdesk` |
| Rule and chat | Select direct chat, group chat, or group mentions. Pick a recent DM, search by group name, or enter an `oc_…` chat ID | Group mentions · `Support` |
| Binding name and save | Give it a recognizable name, review the preview, then enter `y` to enable it | `Support mentions → @helpdesk` |

| Rule | Messages forwarded |
| --- | --- |
| Direct chat | Plain text from other participants in the selected DM |
| Group chat | Plain text from other participants in the selected group |
| Group mentions | Plain text in the selected group that @mentions the account signed in to the profile |

A new binding starts processing when it is saved. Run `setup` again to add another chat or agent. A Lark identity and chat pair can have one binding. If a chat is missing from the wizard, use the `chat_id` returned by Lark CLI chat or message search. [Lark CLI chat search](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-chat-search.md) · [Lark CLI message search](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-search.md)

#### 4. Verify the first reply

```bash
npm run doctor
npm start
```

1. Send a new plain-text message in the selected chat from another Lark account. For a mentions rule, @mention the account bound to the bridge.
2. Open the DM between the bridge identity and your target agent in Raft. Once the forwarded message arrives, check for the agent's response in that message's thread. It will receive instructions to put `/lark-reply` on its own first line, followed by the reply text.

   ```text
   /lark-reply
   Thanks, I’ll follow up on this.
   ```

3. In Lark, confirm that the reply quotes the original message and was sent by the bound account. Run `npm run status` in another terminal to confirm the binding shows a sent reply.

> [!TIP]
> `doctor` checks identity and read access. Verify the first actual reply in a test chat. The default polling interval is 20 seconds, and Lark search indexing also affects delivery time.

### Let an agent guide setup

Clients that support [Agent Skills](https://vercel.com/docs/agent-resources/skills) can install the [raft-lark-bridge skill](skills/raft-lark-bridge/SKILL.md) from this repository. The Skills CLI prompts you to select your agent.

```bash
npx skills add lichenkai/raft-lark-bridge --skill raft-lark-bridge
```

Ask your agent to “forward messages that @mention me in the Lark Support group to Raft’s `@helpdesk`.” It can check your local CLI and sign-in, help you choose a route, and explain diagnostic results. On the first connection, enter the Raft bridge credential in the masked prompt in your local terminal. The skill and npm wizard use the same local configuration.

### Manage bindings

Run `npm run setup` again to add a binding. Use a binding name or the ID shown by `status` for the commands that take `<binding>`.

| Command | What it does |
| --- | --- |
| `npm run status` | Show bindings, queue counts, and recent errors |
| `npm run bridge -- preview <binding>` | Preview matching messages without forwarding |
| `npm run bridge -- pause <binding>` | Pause a binding. Requests already submitted can still finish |
| `npm run bridge -- resume <binding>` | Resume pending work and catch up from the saved search position |
| `npm run bridge -- unbind <binding>` | Remove a binding |
| `npm run bridge -- run --once` | Run one cycle with forwarding and replies enabled |

Each Lark login and chat pair can have one binding. To change its rule, remove the existing binding and run `setup` again. Configuration, the Raft credential, and the SQLite database live in `~/.raft-lark-bridge` by default. Use `--data-dir <directory>` to manage an independent configuration, such as a bridge for a different Raft server.

### Run in the background on macOS

Stop the foreground process, then install and start the user-level LaunchAgent under the same macOS account that runs `lark-cli`.

```bash
npm run bridge -- service install
```

Replace `install` in the command above with `stop`, `start`, or `remove` to manage it. The service writes status and error codes to `bridge.log` in the data directory. Binding changes take effect on the next cycle. If you move the installation, run `service install` again. For foreground use, run `npm start`.

### Delivery and data

- **Incoming messages.** The bridge polls Lark search every 20 seconds by default, overlaps search windows, and deduplicates by message ID. A new binding starts when saved. Search indexing affects how quickly and how completely new messages are found.
- **Replies and retries.** Replies are saved in SQLite before the Raft inbox cursor advances. Retries reuse the same idempotency key. A reply marked for review needs a manual check in the Raft thread and the original Lark chat before you resend it.
- **Identity and visibility.** Each binding checks the selected Lark application and user before sending. Lark credentials stay managed by `lark-cli`, and the Raft bridge credential is stored locally with user-only permissions. Matching messages enter a Raft DM that the participating agents, their creators, and server owners or admins can access. [Raft DM visibility](https://docs.raft.build/features/messaging/channels/)

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| Setup cannot find `lark-cli` or a signed-in profile | Run `lark-cli profile list` under the OS account that runs the bridge. Setup also accepts an absolute path to `lark-cli`. |
| The preview is empty | Check the selected profile, chat, and rule. Send a fresh plain-text message from another account and @mention the bound account if the rule requires it. |
| Raft received the message, but Lark has no reply | Check that the bound agent answered in the forwarded message's thread and put `/lark-reply` on the first line. Then use `status` to see reply errors. |
| `LARK_USER_AUTH` or `LARK_IDENTITY_CHANGED` | Check whether the original profile is still authorized for the same user. To switch accounts, unbind and run `setup` again. |
| `LARK_DETAILS_UNAVAILABLE` or a reply needs review | The former means search did not return message details. Check the app's read permissions. For a reply that needs review, check the original chat before deciding whether to resend it manually. |

### Share and develop

To invite a teammate to try it, share the project folder or a local npm package. Each teammate runs `setup` on their own machine with their own Lark login and Raft External Agent credential. Binding configuration and runtime data stay on that machine.

```bash
npm test
npm pack --dry-run
```

Tests use simulated Lark and Raft services to cover multiple accounts, out-of-order replies, restarts, identity changes, pagination, retries, and deduplication. The package is marked private during the local trial. Choose a license and publishing channel before making the project public.

[Lark message search](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-search.md) · [Lark message replies](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-reply.md) · [Raft External Agents](https://docs.raft.build/developers/sdk/external-agents/)

[Back to the top](#language)
