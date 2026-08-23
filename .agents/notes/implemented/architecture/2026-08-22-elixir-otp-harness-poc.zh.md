# Agent Note: Elixir/OTP 版 Harness PoC

Status: implemented

[English](2026-08-22-elixir-otp-harness-poc.md) | 中文

## Problem

DeepSeek Harness 的"一切都是插件"哲学，是时空可组合性范式（可逆效果、反应式 coeffect、L-Unload 守卫）的运行时实现。现有的 TypeScript 运行时用协作式纪律换取这些保证：取消是信号，拆除是 disposer 记账，同进程代码无法被强制杀死。而能否把这一范式实现在 BEAM 上——在那里故障隔离、拆除、代码的引入与撤销都是进程语义而非纪律——一直是个未解问题。

## Decision

该范式的 Elixir/OTP 实现位于独立仓库 `jhlee111/dsh-beam`（Mix 应用 `dsh_beam`，模块 `DshBeam.*`，Elixir 1.20.2 / OTP 28，唯一依赖 Spark）。它继承范式，不继承代码。

基板实现可逆效果（LIFO 逆累加器）、反应式 coeffect，以及统一上下文；其 pending-unload 状态机实现 L-Unload 守卫：提供者只有在所有依赖者完成拆除（确认、死亡或超时）后才撤回绑定。每个插件都是带论文四态生命周期的 `:gen_statem` fiber；提供者的资源释放是可逆效果，因此崩溃路径同样只在依赖者排空后释放资源（有序停机）。组合通过 Spark DSL 区块声明，创作者模式经 BEAM 代码服务器编译源代码字符串，支持事务式热替换与回滚。33 个 ExUnit 测试固定论文的保证；CI 在 push 和 pull request 上运行格式、warnings-as-errors 与测试套件。

## Alternatives considered

- **把 PoC 留在此仓库的 elixir/ 下。** 否决：代码与 TypeScript 工具链零耦合，且此仓库的上游不接受拉取请求，留在原地只会带来上游追赶噪音和仓库门禁的第二套工具链。迁移发生时历史仅有两个提交，成本最低。
- **逐模块移植 TypeScript harness。** 否决：PoC 的目的是用 OTP 术语重新表达范式；移植会带上 TypeScript 形态的机制（类型图分析器、协作式取消），而这些恰是 BEAM 语义可以取代的。
- **退出信号式停用（撤回时杀死依赖者）。** 否决：论文中的 fiber 在停用后仍然存活并可重新激活，杀死依赖者破坏了 provider 切换后的再激活；撤回协议改用消息加 pid 关联确认。
- **手写 DSL。** 否决：Spark 提供编译期 schema 校验与运行时反射，手写宏需要重新实现这些。

## Consequences

范式保证已在 BEAM 上、在一个带自己 CI 的独立项目中得到演示。代价是：创作者源码受信任（模块名成为原子、代码在进程内执行），因此对不可信创作者的沙箱化——论文的执行边界——仍是未来工作；崩溃重注入可能与进行中的撤回竞争，需要重试/退避。
