# Raft 个人卡片盘点

个人卡是 Raft 当前明确交给某人接收或处理、且该人仍有权打开的卡。单聊可由 Raft 提供隐含收件人。频道、讨论串和任务讨论中的卡使用 Raft 的实际个人收件人或处理人。面向频道全员的问题、一般链接预览或文本进入各自的原生流程。

这份盘点以公开 SDK、Raft Manual 的 Action Cards 和应用发卡说明为起点。目标是逐类适配个人卡。每条线上能力还要核对目标服务器和客户端实际提供的卡片格式、收件人字段和权限。公开有文档的类型仍需对接真实平台事件和版本。

| 已知类型与形态 | 适配目标 |
| --- | --- |
| `question:ask` 一键确认、单选、多选、自由文本、多题与分页 | 都纳入映射盘点。飞书能完整表达原题、选项及约束，且 Raft 支持本人提交时才开放直接作答；其余已验证版本可提醒并回原卡。 |
| `request:prepare` | 核 Raft 指定的可处理人，已适配版本提醒并跳原卡，让 Raft 完成确认及执行。按服务器实际功能开关核验。 |
| `channel:create`、`channel:add_member`、`channel:invite_external`、`agent:create`、`agent:migrate`、`feedback:submit`、`plan:upgrade` | 仅在 Raft 明确给个人且有权处理时适配提醒和原卡跳转。保留归属、权限、原生表单和执行条件。 |
| `integration:approve_agent_login`、`integration:install_marketplace_app`、`integration:register_app`、`integration:recover_app_owner`、`integration:connect_mcp` | 依 Raft 定位当前具名处理人。提醒回原卡完成安装、授权或配置，保持原动作语义。 |
| 具名 Raft App 卡 | 按应用、卡格式和版本核对接收者以及可行动作。应用发卡的 `for` 可用于限制谁能按按钮，实际个人投递仍取 Raft 授权事件。 |
| 已退役的 `integration:update_app_registration` | 记录兼容边界；不启用转发。 |

[Raft 动作卡 SDK](https://docs.raft.build/developers/sdk/api-client/#action-cards) · [Raft App 发卡](https://docs.raft.build/developers/raft-apps/cards/app-sent-cards/)

## 什么可以打开

代码维护已适配的「卡片类型＋格式版本＋支持模式」清单。管理员和用户的开关从该清单中选，能力至少区分关闭、仅提醒与原卡链接、在飞书直接作答。先验证服务器授权、收件人和原卡权限，再检查配置是否启用该版本。没有匹配项的类型或版本留在 Raft，同类型新版本不会继承旧版本的开关。

区分两种情况。完全未知的类型或版本不外发。已验证具名、可见与原卡链接的版本，即使不能在飞书完整作答，也可按其已验证的提醒模式提供入口。允许启用的清单随真实卡片夹具和验收一起更新。
