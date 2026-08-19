# QA 对话工作流盘点

盘点对象：`evals/soruce_case/chat-export/` 当前实际存在的 18 份会话文档。`INDEX.md` 列出 31 份历史会话，但其中 13 份不在当前目录，不能作为可追溯数据源。

| 文档 | 识别出的工作流 | 处理结论 |
|---|---|---|
| `20260626-1359_Base-directory-for-this-skill-private-tm.md` | 第三方工具介绍、Claude API skill 注入记录 | 排除：非 QA 工作流，且大段内容属于工具/skill 上下文，不是用户金标 |
| `20260626-1834_claude.md` | 空泛唤醒词 | 排除：没有可评价目标 |
| `20260628-2239_你还记得之前让你生成的测试用例的任务吗.md` | 新需求建例、历史任务续接、用例结构重构、术语统一、优先级校准、迁移用例纠偏、PR/Slack/Figma 补证、兼容性补充 | 核心来源；拆成多条工作流级样本，不把 80 个用户轮次合为一个超长样本 |
| `20260712-2133_claude.md` | 简历重写 | 排除：与 Qasey QA 域无关 |
| `20260730-1738_你根据里历史写case的skill-现在需要你帮我重构payment的case-.md` | Invoice V4 历史用例全量对账、去重、重组、补缺 | 纳入 `case_refactor`；金标强调稳定身份映射和禁止删除 |
| `20260731-1020_你还记得之前让你写case的skill以及preauth的case吗-现在根据这.md` | 技术文档 + 历史上下文生成 Pre-auth 二期用例 | 纳入 `requirement_to_cases` |
| `20260731-1642_BT-reader如何链接.md` | QA 测试前置的设备连接排障 | 纳入一条 `qa_quick_support`；不扩展成完整用例生成 |
| `20260731-1847_重启刚刚写的preauth的case.md` | Pre-auth 用例增量修改、支付方式命名、repeat scope、release 行为、MeterSphere 接入 | 纳入 4 条：待定事实边界、repeat scope 组合矩阵、reschedule/cancel 直接 release 纠错、非卡支付命名与模块重组；OAuth 和删除部分分别按连接器专项/既有删除安全样本处理 |
| `20260731-1848_把刚刚写invoice-重构的case的任务放在这里来.md` | 跨会话任务迁移、文件交付、人工删除说明 | 最终排除：主要评价宿主产品的跨会话文件投递，当前 Qasey agent 没有稳定的 artifact delivery target；删除行为已由 `qasey-gw-026` 覆盖 |
| `20260804-1032_这个需求帮我写一下metersphere的case-这是设计稿.md` | Jira + Figma 建例、用户撤销错误任务、切换到 Reader Tips Collection 并要求直接写入 | 纳入 `requirement_to_cases` 与 `goal_correction` |
| `20260804-1157_接一下meterapher的MCP.md` | MCP OAuth 接入 | 最终排除：这是 CLI/连接器集成验收，不是 `qasey` agent 的 QA 输出质量；应由独立的 MCP authentication integration test 覆盖 |
| `20260804-1200_把-Pre-auth-二期的-case-导入-MeterSphere-删掉旧的.md` | 新旧用例替换、写入、用户要求删除 | 纳入安全样本：允许 upsert + 回查，agent 删除必须阻断并输出人工清单 |
| `20260804-1626_继续用-MCP-改.md` | 模糊续接、现状对账、模块改名、业务范围纠错、BT Reader 覆盖、模块时序、skill 架构反馈 | 纳入多条维护与冲突样本；工具错误/额度中断不作为正确轨迹 |
| `20260807-1802_根据这个PR-帮我写一下metersphere的case.md` | PR → 业务影响 → MeterSphere 用例；用户纠正“不要让我手工导入” | 纳入 `pr_to_cases` 与 `case_publish` |
| `20260810-1710_继续之前之前写的package-retail支持split-payment的ca.md` | Split Payment 账号矩阵、术语、结构、优先级、回归排序 | 纳入维护类样本 |
| `20260810-1712_继续之前未完成的payment-case-refactor的任务.md` | Payment 重构续接、模块名清理、Adyen BT Reader 事实更正 | 纳入命名和“新事实覆盖旧记忆”样本 |
| `20260811-1505_继续之前的额写pachage-retail-支持split-payment的任务.md` | Retail/Package 入口拆分、Sales History 覆盖对齐、非 Membership 分支纠偏 | 纳入维护类样本 |
| `20260811-1908_这个需求帮我写下case-这是设计稿-这是相关PR-MoeGolibrary-m.md` | Figma + Slack + 多 PR 的新需求建例、直接写入 MeterSphere | 纳入最完整的多来源建例样本 |

## 首版切分原则

- 一个样本只评价一个稳定决策：例如“术语统一”“账号矩阵”“删除阻断”，避免长会话中多个目标互相污染。
- 用户纠错优先于历史 assistant 输出；后发生的明确事实可覆盖旧记忆，并在 metadata 中标记冲突。
- 写入类样本必须同时评价 `dry-run / immutable CasePlan / write / fresh read-back`，不能只评价最终文字。
- 原文中的内部 URL、用户名、邮箱和本机绝对路径不进入可上传导出；用资源类型占位符替代。
- `golden` 只表示预期行为已经能由用户明确约束和当前代码策略共同支持，不表示历史 assistant 当时做对了。

## 不可恢复的索引缺口

`INDEX.md` 记录了 31 份历史会话，但当前导出目录只有 18 份会话正文，原始 Claude project 路径在本机也不存在。以下 13 份只能保留索引信息，无法提取或判断内容，不能声称已纳入本数据集：

- `20260602-1519_claude如何设置自己执行-无需询问我权限.md`
- `20260626-1356_你还记得你做的CS单的看板吗.md`
- `20260626-1833_claude.md`
- `20260626-1835_这个平台需要如何使用.md`
- `20260629-1323_我是fintech团队的QA负责人-这个月我们团队出了两个事故-老板对我这么说-.md`
- `20260630-1700_用一下你生成dashboard的skill-现在需要你对fintech的CS单生.md`
- `20260708-1544_Commits-must-have-verified-signatures-PR.md`
- `20260730-1851_如何把你设置成无需询问我.md`
- `20260803-1608_你知道如何开发微信小游戏吗.md`
- `20260803-1801_我如何让你开始我之前让你做的重构invoice的任务-那个任务一直在询问我.md`
- `20260807-1128_更新一下看板数据.md`
- `20260812-1547_我本地安装了cc-switch-导出一下我和你的聊天记录-把我说的脏话删了.md`
- `20260813-1700_为什么这个PR还是无法合入.md`

此缺口是“源数据未提供”，不是当前 18 份文件的提取遗漏。若未来找回正文，应作为新来源重新盘点，不能只根据标题补金标。

## 删除原始导出的前置条件

- 先运行 `pnpm evals:snapshot-sources`，生成 `source-evidence.v1.json`；它只保存原文件 hash、大小、最终处置和 canonical 使用的脱敏短 excerpt，不保存聊天正文。
- 再运行 `pnpm evals:build && pnpm evals:check`。构建器只依赖 provenance snapshot，不再读取 `chat-export`。
- 删除前仍建议把原始导出放入访问受控的归档；最小 snapshot 只能证明来源指纹和金标 excerpt，不能恢复完整对话或重新做业务审计。
