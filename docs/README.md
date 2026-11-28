# 项目文档

| 你要做的事 | 从这里开始 |
| --- | --- |
| 安装或排查现有文字桥接 | [README 的本地安装](../README.md#快速开始) |
| 让 Codex 或其他 Agent 引导配置 | [项目 Skill](../skills/raft-lark-bridge/SKILL.md) |
| 理解本地、云端和审批的分工 | [架构与场景](architecture.md) |
| 准备 Raft App、飞书机器人与云端部署 | [云端设置](cloud-setup.md) · [用户视角预演](cloud-setup-rehearsal.md) |
| 开发 feature、启用 CodeGraph 或提交评审 | [贡献指南](../CONTRIBUTING.md) |
| 评审云端问题卡的需求、协议或验证结果 | [功能 spec](../specs/cloud-question-cards/spec.md) · [卡片盘点](../specs/cloud-question-cards/card-types.md) · [协议](../specs/cloud-question-cards/protocol.md) · [验收](../specs/cloud-question-cards/verification.md) |
| 了解普通私信、个人 @ 与原会话回复 | [个人消息 spec](../specs/personal-messages/spec.md) |

本地文字桥接已实现。云端原生问题卡按 spec 开发，实际启用取决于 Raft 对原卡投递及本人作答的授权接口。
