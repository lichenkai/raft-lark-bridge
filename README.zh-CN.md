<h1 align="center">Raft Lark Bridge</h1>

<p align="center">用你已登录的飞书账号，把指定会话接到 Raft Agent。</p>

<p align="center"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

---

把本机的 `lark-cli` profile 绑定到 Raft Agent，选择要转发的指定单聊、指定群聊，或指定群里 @ 你的消息。Agent 的答复可以用同一个登录身份引用飞书原消息回复。一个桥接服务可以管理多条绑定。

```mermaid
flowchart LR
    L["飞书会话"] -->|"命中转发规则"| B["本机桥接 · lark-cli"]
    B -->|"Raft 私聊"| A["绑定的 Raft Agent"]
    A -->|"线程内的正式答复"| B
    B -->|"以本人身份回复"| L
```

<p align="center"><a href="#快速开始">快速开始</a> · <a href="#管理绑定">管理绑定</a> · <a href="#macos-后台运行">后台运行</a></p>

## 快速开始

**所需环境** · Node.js 22.13+、已登录的 `lark-cli` profile，以及管理员可以创建 External Agent 的 Raft 服务器。桥接使用 `lark-cli` 1.0.100 的命令和输出格式。

1. 在 Raft 打开 **Members → Connect an external agent → Build your own**，创建一个桥接身份，例如 `@lark-bridge`，留好 `sk_agent_…` 凭证供向导使用。桥接身份会通过私聊把消息交给你已有的 Agent。
2. 在项目目录运行下面的命令。`setup` 会隐藏凭证输入，并引导你选择 Lark profile、目标 Agent 和会话。可以从最近的私聊里选、按群名搜索，或直接输入会话 ID（`oc_…`）。预览命中的消息后保存绑定。

   ```bash
   npm ci
   node src/cli.js setup
   node src/cli.js doctor
   node src/cli.js run
   ```

3. 用另一个飞书账号在刚绑定的测试会话发条新消息。消息进入 Raft 后，Agent 可以在这条消息的线程里按以下格式回复。

   ```text
   /lark-reply
   这里是要发回飞书的正式答复。
   ```

每条转发消息都附有这项回复约定。桥接会把目标 Agent 的第一条带标记答复作为纯文本发回飞书。进度更新留在 Raft。

> [!TIP]
> `doctor` 检查身份和读取权限，不发送消息。请在测试会话中验证你的飞书账号也能以本人身份回复。

## 管理绑定

再次运行 `node src/cli.js setup` 就能添加另一条绑定。命令中的 `<绑定>` 可以用绑定名称，也可以用 `status` 显示的 ID。

| 命令 | 用途 |
| --- | --- |
| `node src/cli.js status` | 查看绑定、队列和近期错误 |
| `node src/cli.js preview <绑定>` | 预览命中的消息，无需转发 |
| `node src/cli.js pause <绑定>` | 暂停绑定，已经提交的请求仍可能完成 |
| `node src/cli.js resume <绑定>` | 继续处理待办消息，从保存的位置补读 |
| `node src/cli.js unbind <绑定>` | 解除绑定 |
| `node src/cli.js run --once` | 执行一轮实际转发和回复 |

同一飞书登录身份与会话的组合只允许一条绑定。更改规则时，先解除旧绑定，再运行 `setup`。配置、Raft 凭证和 SQLite 数据库默认存放在 `~/.raft-lark-bridge`。可以用 `--data-dir <目录>` 管理独立的配置，例如为另一台 Raft 服务器建立桥接。

## macOS 后台运行

先停止前台进程，再用运行 `lark-cli` 的同一个 macOS 账号安装并启动用户级 LaunchAgent。

```bash
node src/cli.js service install
```

用 `service stop`、`service start` 和 `service remove` 管理后台服务。状态和错误代码写入数据目录中的 `bridge.log`。绑定修改在下一轮生效。移动安装位置后，重新运行 `service install`。需要前台运行时使用 `node src/cli.js run`。

## 消息投递与数据

- **收消息。** 默认每 20 秒轮询飞书搜索，查询时间窗口会重叠，并按消息 ID 去重。新绑定从保存时开始处理。新消息查询的速度和覆盖范围取决于飞书搜索索引。
- **回复和重试。** 桥接先把回复保存到 SQLite，再推进 Raft 收件箱游标。重试会复用幂等键。标记为「待核对」的回复，需要先检查 Raft 线程和飞书原会话，再手动补发。
- **身份和可见范围。** 每条绑定都会在发送前核对飞书应用和登录用户。Lark 凭证由 `lark-cli` 管理，Raft 桥接凭证保存在本机仅当前用户可读的文件中。命中的消息会进入 Raft 私聊，参与的 Agent、其创建者以及服务器所有者或管理员可以查看。 [Raft 私聊可见性](https://docs.raft.build/features/messaging/channels/)

## 分享和开发

可以把项目目录或本地 npm 安装包发给同事。同事在自己的电脑上用本人的 Lark 登录和独立的 Raft External Agent 凭证运行 `setup`。绑定配置和运行数据也保留在各自的电脑上。

```bash
npm test
npm pack --dry-run
```

测试使用模拟的 Lark 和 Raft 服务，覆盖多身份、倒序回复、重启、身份变化、分页、重试和去重。本地试用期间包保留私有设置。公开项目时再选择许可证和发布渠道。

[飞书消息搜索](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-search.md) · [飞书原消息回复](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-reply.md) · [Raft External Agent 接入](https://docs.raft.build/developers/sdk/external-agents/)
