# Agent Note: Elixir/OTP harness PoC

Status: implemented

English | [中文](2026-08-22-elixir-otp-harness-poc.zh.md)

## Problem

DeepSeek Harness's "everything is a plugin" philosophy is the runtime realization of the spatiotemporal-composability paradigm: revertible effects, reactive coeffects, and the L-Unload guard. The shipped TypeScript runtime buys its guarantees with cooperative discipline — cancellation is a signal, teardown is disposer bookkeeping, and same-process code cannot be hard-killed. Whether the paradigm can instead be realized on the BEAM, where fault isolation, teardown, and code introduction/retraction are process semantics rather than discipline, was an open question.

## Decision

The Elixir/OTP realization of the paradigm lives in its own repository, `jhlee111/dsh-beam` (Mix app `dsh_beam`, modules `DshBeam.*`, Elixir 1.20.2 / OTP 28, Spark as the only dependency). It inherits the paradigm, not the code.

The substrate realizes revertible effects (the LIFO inverse accumulator), reactive coeffects, and a unified context whose pending-unload state machine implements the L-Unload guard: a provider withdraws only after every dependent drained (acknowledgement, death, or timeout). Every plugin is a `:gen_statem` fiber with the paper's four lifecycle states; a provider's resource release is a revertible effect, so even the crash path releases only after dependents drained (ordered shutdown). Composition is declarative via Spark DSL sections, and creator mode compiles source strings through the BEAM code server with transactional hot redefine and rollback. 33 ExUnit tests pin the paper's guarantees; CI runs format, warnings-as-errors, and the suite on push and pull request.

## Alternatives considered

- **Keeping the PoC in this repository under elixir/.** Rejected: the code has zero coupling to the TypeScript toolchain, and this repository's upstream does not accept pull requests, so colocation only added upstream-churn noise and a second toolchain to repository gates. The move happened while the history was two commits, at minimum cost.
- **Porting the TypeScript harness module by module.** Rejected: the PoC's purpose is to re-express the paradigm in OTP terms; a port would carry TypeScript-shaped machinery (the type-graph analyzer, cooperative cancellation) that BEAM semantics replace.
- **Exit-signal deactivation (kill dependents on withdrawal).** Rejected: the paper's fiber survives deactivation and reactivates, and killing a dependent broke provider-swap reactivation; the withdrawal protocol uses a message plus a pid-correlated acknowledgement instead.
- **A hand-rolled DSL.** Rejected: Spark provides compile-time schema validation and runtime introspection that a hand-rolled macro would have to reimplement.

## Consequences

The paradigm's guarantees are demonstrated on the BEAM in a standalone project with its own CI. The costs: creator source is trusted (module names become atoms, code runs in-process), so sandboxing untrusted creators — the paper's execution boundary — remains future work; and crash re-injection can race an in-flight withdrawal and needs retry/backoff.
