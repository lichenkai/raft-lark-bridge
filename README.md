<p align="center">
  <img src="./docs/assets/brand.svg" width="760" alt="Raft Lark Bridge · Your Lark account, connected to Raft">
</p>

<p align="center">
  <img src="./docs/assets/badge-node.svg" alt="Node.js 22.13+">
  <img src="./docs/assets/badge-lark.svg" alt="lark-cli 1.0.97+">
</p>

<p align="center"><strong>选定会话，以你的身份原路回复。</strong></p>
<p align="center">macOS · Ubuntu · CentOS Stream</p>

<a name="language"></a>
<p align="center"><a href="#zh-cn">中文</a> · <a href="#english">English</a></p>

<a name="zh-cn"></a>

- **指定要转发的飞书消息。** 支持单聊、群聊，以及指定群里 @ 你的消息。
- **让 Raft Agent 处理，以你的飞书身份回复。** 正式答复会引用原消息，发回原会话。
- **为不同 Agent 分别配置规则。** 一个本地桥接服务可管理多条绑定，支持预览、暂停和恢复。

## 快速开始

### 1. 安装项目并检查飞书账号

需要 Node.js 22.13+。绑定前需要安装 `lark-cli` 1.0.97 或以上版本并登录飞书。下面的 `preflight` 会检查安装和授权的准备情况。

```bash
node --version
git clone https://github.com/lichenkai/raft-lark-bridge.git
cd raft-lark-bridge
npm ci
npm run preflight
```

如果已经下载项目，先进入项目目录，再运行 `npm ci`。`preflight` 检查 Node.js、项目依赖版本、Lark CLI 版本和本机 profile 登录状态，发现缺项时给出下一条命令。用 `npm run preflight -- --check-updates` 查询 Lark CLI 更新。安装和升级分别使用 `npx @larksuite/cli@latest install` 和 `lark-cli update`。选定的 profile 需要能以用户身份搜索、读取和回复消息。 [Lark CLI 安装与授权](https://github.com/larksuite/cli/blob/main/README.zh.md)

### 2. 在 Raft 创建桥接身份

在目标 Agent 所在的 Raft 服务器，打开 **Members → Connect an external agent → Build your own**，创建一个桥接身份，例如 `@lark-bridge`。复制它的 `sk_agent_…` 凭证，留给配置向导。桥接需要 `read` 和 `send` 权限。处理消息的目标 Agent 可以是已有的 `@helpdesk`。 [Raft External Agent 接入](https://docs.raft.build/developers/sdk/external-agents/)

### 3. 用向导添加第一条绑定

在项目目录，也就是 `package.json` 所在目录，运行向导。

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
2. 在 Raft 打开桥接身份与目标 Agent 的私聊，核对转发正文。飞书里真实点名绑定账号的 `@` 会显示为目标 Agent 的 `@handle`，其余正文按原文转发。桥接会把目标 Agent 在该消息线程里的第一条文本答复发回飞书。
3. 回到飞书，确认回复引用的是原消息，发送者是绑定的飞书账号。在另一个终端运行 `npm run status`，对应绑定应出现「已回信」。

> [!TIP]
> `doctor` 只检查身份和读取权限。第一条真实回复最适合在测试会话验证。默认每 3 秒检查 Lark 新消息。

## 让 Agent 引导配置

支持 [Agent Skills](https://vercel.com/docs/agent-resources/skills) 的客户端可以安装本仓库的 [raft-lark-bridge Skill](skills/raft-lark-bridge/SKILL.md)。Skills CLI 会引导选择安装到哪个 Agent。

```bash
npx skills add lichenkai/raft-lark-bridge --skill raft-lark-bridge
```

安装后可以对 Agent 说「帮我安装桥接，把飞书支持群里 @ 我的消息交给 Raft 的 `@helpdesk`」，或「把支持群绑定改成只收 @ 我的消息」。Agent 会检查环境、引导登录，并用下面的命令管理绑定。首次连接 Raft 时，在本机终端的隐藏提示中输入桥接凭证。Skill 和 npm 向导使用同一套本地配置。

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

同一飞书登录身份与会话的组合只允许一条绑定。更改规则时，先用 `status` 查看「待转发、等回复、待回信」。需要保留的待办处理完成后，解除旧绑定，再对同一个群运行 `setup`。从「群聊 @我」改为「群聊」会把转发范围扩大到该群的合格文本消息。

配置、Raft 凭证和 SQLite 数据库默认存放在 `~/.raft-lark-bridge`。如果有多个实例，每条命令都传同一个 `--data-dir`，例如 `npm run status -- --data-dir ~/work-bridge`。

飞书里的真实点名按绑定用户 ID 匹配。桥接发给 Raft 时会把命中的 `@` 换成目标 Agent 的 handle，飞书原消息和预览保留飞书显示的名称。

## 后台运行和排查

如已在前台运行，先按 Ctrl+C。用已授权 `lark-cli` 的同一个系统账号安装并启动后台服务：

```bash
npm start
tail -F ~/.raft-lark-bridge/bridge.log
```

- **macOS** 使用用户级 LaunchAgent。
- **Ubuntu、CentOS Stream 等 systemd Linux** 使用 `systemctl --user`。通过 SSH 登录运行账号后完成授权和配置。要在系统启动后自动运行，并在退出 SSH 后继续运行，请让管理员执行 `sudo loginctl enable-linger <运行账号>`。[systemd 用户服务与 linger](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html#enable-linger%20USER%E2%80%A6)

`npm stop` 停止后台服务。`npm run bridge -- service remove` 移除服务，保留绑定和 SQLite 状态。自定义 `--data-dir` 时，管理命令需传同一个目录，`bridge.log` 也在该目录内。绑定修改在下一轮生效。移动安装位置或更换 Node.js 路径后，再运行 `npm start`。

`npm start -- --debug` 开启后台调试，普通 `npm start` 恢复常态日志。前台联调用 `npm run foreground -- --debug`，如有后台进程先运行 `npm stop`。后台日志包含关键事件、时间、短 ID 和错误码。每达到 8 MiB 就轮转一次，保留一份 `bridge.log.1`。调试模式额外记录每轮处理、Lark 身份检查、会话历史、搜索和 Raft 收件箱耗时。

按同一个 `job` 串起 `lark.detected`、`raft.forwarded`、`raft.reply_observed` 和 `lark.replied`。转发和回信的 `durationMs` 是各自调用耗时。回信观测中的 `waitMs` 是桥接确认转发到发现回复的时间，`agentPathMs` 用 Raft 的发信时间估算 Agent 路径耗时，`inboxDelayMs` 是发布到被桥接发现的估计耗时。估算依赖 Raft 提供时间戳以及两端时钟同步。Agent 路径包含排队、模型与可能的工具调用，模型耗时需用 Agent 运行时的时间戳确认。`lark.detected` 中，`source=history` 的原消息时间来自会话历史接口，`source=search` 的时间通常只有分钟精度。

## 消息投递与数据

- **收消息。** 默认每 3 秒开始一轮，同一时间只跑一轮。桥接使用 Lark 用户身份读取绑定会话最近的历史，同时约每 15 秒用搜索补漏，包括会话历史接口未返回的线程回复。撞上新的历史命中时，定时搜索最多让出一个轮询周期。历史结果还有下一页时立即补搜。历史读取失败时，每轮用搜索接续，并在一分钟后重试历史。两种来源共用消息 ID 去重，搜索保留重叠窗口和可恢复的游标。
- **回复和重试。** 同一进程独立检查 Raft 收件箱。转发成功后立即触发检查，等待答复的前 60 秒以 1 秒为目标间隔，其余情况使用配置的轮询间隔。桥接先把回复保存到 SQLite，再推进 Raft 收件箱游标。重试会复用幂等键。标记为「待核对」的回复，需要先检查 Raft 线程和飞书原会话，再手动补发。
- **身份和可见范围。** 每条绑定都会在发送前核对飞书应用和登录用户。Lark 凭证由 `lark-cli` 管理，Raft 桥接凭证保存在本机仅当前用户可读的文件中。命中的消息会进入 Raft 私聊，参与的 Agent、其创建者以及服务器所有者或管理员可以查看。 [Raft 私聊可见性](https://docs.raft.build/features/messaging/channels/)

## 常见问题

| 现象 | 怎么检查 |
| --- | --- |
| `npm run setup` 报 `ENOENT`，找不到 `package.json` | 先 `cd` 到 `raft-lark-bridge` 项目目录再运行，或使用 `npm --prefix <项目目录> run setup`。 |
| `status` 或前台运行显示 SQLite `ExperimentalWarning` | 部分 Node.js 版本在打开 SQLite 时会打印提示。命令结果和桥接错误仍会正常输出。 |
| 向导找不到 `lark-cli` 或已登录账号 | 在运行桥接的同一个系统账号下执行 `lark-cli profile list`。向导也接受 `lark-cli` 的绝对路径。 |
| 预览为空 | 检查选的是哪个 profile、会话和规则。用另一个账号发纯文本测试。如果选了 `@我`，发信人要明确 @ 绑定的账号。 |
| Raft 收到了消息，飞书没有回复 | 检查文本答复是否由绑定的 Agent 发在原转发消息的线程里。再用 `status` 查看回信阶段错误。 |
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

You need Node.js 22.13+. Before creating a binding, install `lark-cli` 1.0.97 or later and sign in to Lark. The `preflight` command below checks your environment and local sign-in.

```bash
node --version
git clone https://github.com/lichenkai/raft-lark-bridge.git
cd raft-lark-bridge
npm ci
npm run preflight
```

If you already downloaded the project, enter its directory and start with `npm ci`. `preflight` checks Node.js, the project dependency version, the Lark CLI version, and local profile sign-in. It gives the next command when a check fails. Run `npm run preflight -- --check-updates` to check for Lark CLI updates. Use `npx @larksuite/cli@latest install` to install it and `lark-cli update` to upgrade it. The selected profile needs user permission to search, read, and reply to messages. [Lark CLI setup and authorization](https://github.com/larksuite/cli#installation)

#### 2. Create a bridge identity in Raft

On the Raft server that hosts the target agent, open **Members → Connect an external agent → Build your own**. Create a bridge identity, for example `@lark-bridge`, and copy its `sk_agent_…` credential for setup. The bridge needs `read` and `send` scopes. An existing agent such as `@helpdesk` can handle the messages. [Raft External Agents](https://docs.raft.build/developers/sdk/external-agents/)

#### 3. Add your first binding

Run the wizard from the project directory that contains `package.json`.

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
2. Open the DM between the bridge identity and your target agent in Raft and check the forwarded text. Genuine mentions of the bound Lark user use the target agent's `@handle`. The rest of the text is preserved. The bridge sends the target agent's first text reply in that message's thread back to Lark.
3. In Lark, confirm that the reply quotes the original message and was sent by the bound account. Run `npm run status` in another terminal to confirm the binding shows a sent reply.

> [!TIP]
> `doctor` checks identity and read access. Verify the first actual reply in a test chat. The bridge checks for incoming Lark messages every 3 seconds by default.

### Let an agent guide setup

Clients that support [Agent Skills](https://vercel.com/docs/agent-resources/skills) can install the [raft-lark-bridge skill](skills/raft-lark-bridge/SKILL.md) from this repository. The Skills CLI prompts you to select your agent.

```bash
npx skills add lichenkai/raft-lark-bridge --skill raft-lark-bridge
```

Ask your agent to “install the bridge and forward messages that @mention me in the Lark Support group to Raft's `@helpdesk`,” or “change the Support binding to forward only mentions.” The agent can check your environment, guide sign-in, and manage bindings with the commands below. On the first connection, enter the Raft bridge credential in the masked prompt in your local terminal. The skill and npm wizard use the same local configuration.

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

Each Lark login and chat pair can have one binding. To change its rule, check `status` for queued forwards, outstanding agent replies, and replies ready for Lark. Let wanted replies finish, remove the existing binding, then run `setup` for the same group. Switching from group mentions to group chat forwards all eligible text across that group.

Configuration, the Raft credential, and the SQLite database live in `~/.raft-lark-bridge` by default. If you run more than one instance, pass the same `--data-dir` to every command for that instance, for example `npm run status -- --data-dir ~/work-bridge`.

The bridge matches actual Lark mentions by the bound user ID. In Raft, those mentions use the target Agent's handle. The original Lark message and the preview show the Lark display name.

### Background service and diagnostics

Stop any foreground process with Ctrl+C. Use the same OS account that authorized `lark-cli` to install and start the background service.

```bash
npm start
tail -F ~/.raft-lark-bridge/bridge.log
```

- **macOS** uses a user-level LaunchAgent.
- **Ubuntu, CentOS Stream, and other Linux distributions with systemd** use `systemctl --user`. Sign in over SSH as the service account to authorize Lark CLI and configure the bridge. To run at boot and stay active after SSH logout, have an administrator run `sudo loginctl enable-linger <service-account>`. [systemd user lingering](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html#enable-linger%20USER%E2%80%A6)

Use `npm stop` to stop the background service and `npm run bridge -- service remove` to remove it while preserving bindings and SQLite state. If you use a custom `--data-dir`, pass it to every service command and look for `bridge.log` in that directory. Binding changes take effect on the next cycle. Run `npm start` again if you move the checkout or change the Node.js path.

Use `npm start -- --debug` for background diagnostics and `npm start` to return to normal logging. For a foreground test, stop the background service and run `npm run foreground -- --debug`. Background logs record key events, timestamps, short IDs, and error codes. Logs rotate at 8 MiB and retain one previous file, `bridge.log.1`. Debug mode adds cycle, Lark identity, chat history and search, and Raft inbox timings.

Follow a `job` across `lark.detected`, `raft.forwarded`, `raft.reply_observed`, and `lark.replied`. The forwarding and delivery events record API call duration in `durationMs`. The reply observation records total bridge wait in `waitMs`, estimated time on the Agent path in `agentPathMs`, and estimated time from Raft publication to bridge observation in `inboxDelayMs`. These estimates depend on Raft timestamps and synchronized clocks. The Agent path includes queuing, model execution, and any tool calls. Use Agent runtime timestamps to measure model time. In `lark.detected`, `source=history` records the original timestamp from chat history. `source=search` usually has minute precision.

### Delivery and data

- **Incoming messages.** The bridge starts a cycle every 3 seconds by default, with one cycle running at a time. It reads recent chat history as the authorized Lark user and runs a catch-up search about every 15 seconds, including for thread replies omitted from chat history. A fresh history match can defer the scheduled search by up to one polling interval. A truncated history page triggers an immediate search. If chat history is unavailable, each cycle uses search and retries chat history after one minute. Both sources deduplicate by message ID, and search keeps overlapping windows and a resumable cursor.
- **Replies and retries.** The same process checks the Raft inbox on its own schedule. A successful forward triggers a check, then the bridge targets one check per second for the first 60 seconds while waiting for a reply. It uses the configured interval otherwise. Replies are saved in SQLite before the Raft inbox cursor advances. Retries reuse the same idempotency key. A reply marked for review needs a manual check in the Raft thread and the original Lark chat before you resend it.
- **Identity and visibility.** Each binding checks the selected Lark application and user before sending. Lark credentials stay managed by `lark-cli`, and the Raft bridge credential is stored locally with user-only permissions. Matching messages enter a Raft DM that the participating agents, their creators, and server owners or admins can access. [Raft DM visibility](https://docs.raft.build/features/messaging/channels/)

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| `npm run setup` reports `ENOENT` for `package.json` | Enter the `raft-lark-bridge` project directory, or use `npm --prefix <project-directory> run setup`. |
| `status` or the foreground runner prints a SQLite `ExperimentalWarning` | Some Node.js versions print this notice when opening SQLite. Command output and bridge errors are still shown. |
| Setup cannot find `lark-cli` or a signed-in profile | Run `lark-cli profile list` under the OS account that runs the bridge. Setup also accepts an absolute path to `lark-cli`. |
| The preview is empty | Check the selected profile, chat, and rule. Send a fresh plain-text message from another account and @mention the bound account if the rule requires it. |
| Raft received the message, but Lark has no reply | Check that the bound agent posted a text reply in the forwarded message's thread. Then use `status` to see reply errors. |
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
