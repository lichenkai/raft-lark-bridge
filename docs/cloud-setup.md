# 云端设置指南

本页用于准备计划中的云端原生问题卡服务。当前可按平台文档准备应用注册和试点计划。桥接后台部署、回调地址、用户绑定及测试卡功能随 [功能 spec](../specs/cloud-question-cards/spec.md) 实现，并需验证 Raft 所提供的投递和作答能力。现有文字桥接安装请用 [README](../README.md#快速开始)。

## 部署前准备

| 谁负责 | 准备与核对 |
| --- | --- |
| 服务维护者 | 选定一套云端环境及稳定 HTTPS 地址，规划 Raft 登录回调、飞书登录与卡片回调、设置页。配置示例使用占位内容，真实密钥通过运行环境的秘密管理入口注入。 |
| Raft 来源服务器管理员 | 创建 Raft App，核应用标识、主页、回调地址和设置地址。 |
| 每个目标 Raft 服务器管理员 | 安装应用，确认其请求的权限及退订方式。 |
| 飞书租户管理员 | 开启自建应用的机器人能力，发布所需消息权限，把试点员工纳入应用可用范围，配置卡片回调。 |
| 试点用户 | 登录两端并确认接收账号，逐个启用需要收卡的 Raft 服务器。 |

部署配置应能让维护者逐项检查服务 URL、应用注册、回调连通、安装范围与当前支持的能力。服务就绪后，设置页给出下一步和失败原因，启动日志与配置检查只输出状态及可定位的非敏感标识。

## 创建和安装 Raft App

1. 在来源服务器左栏打开 **应用 → 添加应用 → 创建 Raft 应用**。应用页的「开发者」用于编辑与分发。来源服务器的 owner/admin 也可确认 Agent 发起的注册卡。
2. 使用已部署的实际 HTTPS 回调。Raft 要求注册值与 OAuth 请求中的回调逐字节一致。设置页 URL 作为安装后的引导入口。应用凭据由维护者在平台生成，再从受控入口配置到服务。
3. 若在多个服务器试点，在来源应用的「分发」生成私有分享链接。只把链接交给各目标服务器的管理员。每个管理员选择自己的服务器安装，同一个客户端 ID 可供该应用的多次独立安装使用。对外分发可随后走市场。
4. 验证每次安装的服务器和授权。用户逐个开启需要的服务器，后台核当前安装、成员身份和授予范围。来源服务器的注册本身不会给其它服务器启用权限。

CLI 辅助注册适用于已确定实际应用 URL 的环境。下面的域名和路径是示例，填写部署件实际提供的地址。命令会在指定对话发起注册卡：

```sh
raft integration app prepare register \
  --client-key raft-lark-bridge \
  --name "Raft Lark Bridge" \
  --redirect-url "https://bridge.example.com/auth/raft/callback" \
  --app-url "https://bridge.example.com" \
  --setup-url "https://bridge.example.com/setup" \
  --scope openid --scope profile \
  --target "#admin"
```

[Raft 应用注册和服务器授权](https://docs.raft.build/zh-cn/developers/login-with-raft/) · [私有跨服务器安装](https://docs.raft.build/developers/raft-apps/share/)

## 配置飞书应用和用户绑定

1. 在目标飞书租户启用自建应用机器人。核它能够以应用身份向试点用户发送交互卡片，订阅 `card.action.trigger`，使用当前部署选择的受信回调通道。
2. 用户从桥接设置页登录两端。飞书身份用于确认收卡账号。用本机器人所属应用得到的 `open_id`，并保存对应租户与应用。已有个人 CLI 使用其它应用时，其 `open_id` 不能复用。
3. 按服务器分别显示个人卡、普通 DM 和个人 @ 的可用状态。每种场景先核该用户有权接收对应的原生事件，再核该场景自己的本人作答或回复权限。只有事件投递时，界面显示「打开 Raft 处理」。事件投递也不可用时，界面说明需由谁补齐。员工从同一设置页选择可用场景并查看测试结果。 [个人消息 spec](../specs/personal-messages/spec.md)
4. 取消个人绑定后停止该绑定的投递和作答。卸载某个服务器的 Raft App 后停止该服务器链路。飞书应用撤销可用范围后，后台停止向该账号投递。旧卡点击时仍需检查绑定和原卡状态。

[飞书应用发消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create) · [飞书回调](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/receive-and-handle-callbacks) · [飞书用户标识](https://open.larksuite.com/document/home/user-identity-introduction)

## Agent 引导与交接

把仓库交给 Codex 或其他开发 Agent，要求按 [项目 Skill](../skills/raft-lark-bridge/SKILL.md) 在目标机器检查并引导配置。维护者提供要部署的模式、运行账号、目标服务器和测试对象。引导过程先检查现有服务、权限和缺项，给出下一条能执行的操作。需要管理员确认或用户登录时，明确动作在哪里完成，完成后继续检查原项。涉及个人账号授权、密钥和生产访问时使用平台受控入口。

云端上线前按 [验收矩阵](../specs/cloud-question-cards/verification.md) 留实际投递、点击回写和撤权证据。关闭云端功能时，保留用于核对待确认回执的记录，并按部署约定回收失效授权。现有本地服务可独立管理。
