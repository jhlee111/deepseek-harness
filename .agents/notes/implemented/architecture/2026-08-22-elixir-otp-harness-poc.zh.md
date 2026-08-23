# Agent Note: Elixir/OTP 版 Harness PoC

Status: implemented

[English](2026-08-22-elixir-otp-harness-poc.md) | 中文

## Problem

DeepSeek Harness 的"一切都是插件"哲学，是时空可组合性范式（可逆效果、反应式 coeffect、L-Unload 守卫）的运行时实现。现有的 TypeScript 运行时实现了该范式，但其保证依赖协作式纪律：取消是信号，拆除是 disposer 记账，同进程代码无法被强制杀死。而能否把这一范式实现在 BEAM 上——在那里故障隔离、拆除、代码的引入与撤销都是进程语义而非纪律——一直是个未解问题。

## Decision

`elixir/` 是一个自包含的 PoC：继承范式而非代码，用一个全新的 Mix 项目（`dsh`）在 Elixir/OTP 上实现论文模型。`.tool-versions` 固定 Elixir 1.20.2 / OTP 28；唯一依赖是 `spark`。

- 基板实现了可逆效果（`Dsh.Effect`，LIFO 逆累加器）、反应式 coeffect（`Dsh.Coeffect`），以及统一上下文（`Dsh.Context`）；其 pending-unload 状态机实现 L-Unload 守卫：提供者只有在所有依赖者完成拆除（确认、死亡或超时）之后才撤回绑定。
- 每个插件都是一个 fiber：`use Dsh.Plugin` 生成带论文四态生命周期（`:inactive`、`:reloading`、`:active`、`:unloading`）的 `:gen_statem`。fiber 拥有自己的生命周期并上报状态迁移；上下文仅在依赖图计算时镜像它们。
- 第一个插件是会话日志（`Dsh.Session`，Memory/File 两个提供者）。提供者的资源释放是注册到上下文的一个可逆效果，因此崩溃路径（`:kill`）同样只在依赖者排空后才释放资源——有序停机。
- 组合是声明式的：`Dsh.Composition` 的 entry 与 `Dsh.Plugin.Dsl` 的 `need`/`provide` 声明是 Spark 区块，具备编译期校验与运行时反射。
- 创作者模式（`Dsh.Creator`）编译源代码字符串、经 BEAM 代码服务器加载并挂载为 fiber；`redefine/2` 执行事务式热替换（先编译、守卫序拆除、换码、启动失败则回滚）。

测试套件（33 个 ExUnit 测试）固定了论文的保证：恢复精确性、守卫次序、依赖者拆除期间 committed view 可读、重配置的合流性、崩溃隔离，以及 DSL 作为同一语义之上的表层。该 PoC 未接入 pnpm 工作区或 CI；用 `cd elixir && mix test` 运行。

## Alternatives considered

- **逐模块移植 TypeScript harness。** 否决：PoC 的目的是用 OTP 术语重新表达范式；移植会带上 TypeScript 形态的机制（类型图分析器、协作式取消），而这些恰是 BEAM 语义可以取代的。
- **把 fiber 作为单一协调进程里的记录。** 独立评审后否决：一个 GenServer 持有全部生命周期状态回避了进程语义，使范式的隔离主张不可观察；fiber 已提升为 `:gen_statem` 进程。
- **退出信号式停用（撤回时杀死依赖者）。** 否决：论文中的 fiber 在停用后仍然存活并可重新激活，杀死依赖者破坏了 provider 切换后的再激活；撤回协议改用消息加 pid 关联确认。
- **手写 DSL。** 否决：Spark 提供编译期 schema 校验与运行时反射，手写宏需要重新实现这些。

## Consequences

范式保证已在 BEAM 上得到演示：细粒度的逆累加器在上下文内运行，而 fiber 进程独立地崩溃与迁移；创作者编写的代码可在运行时引入、替换与撤销。代价是：仓库 CI 之外的第二套工具链与测试；创作者源码是受信任的（模块名成为原子、代码在进程内执行），因此对不可信创作者的沙箱化——论文的执行边界——仍是未来工作；Runtime 的崩溃重注入可能与进行中的撤回竞争（`:already_provided`），需要重试/退避。
