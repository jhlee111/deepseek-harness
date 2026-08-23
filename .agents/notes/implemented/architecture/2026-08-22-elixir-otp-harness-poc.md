# Agent Note: Elixir/OTP harness PoC

Status: implemented

English | [中文](2026-08-22-elixir-otp-harness-poc.zh.md)

## Problem

DeepSeek Harness's "everything is a plugin" philosophy is the runtime realization of the spatiotemporal-composability paradigm: revertible effects, reactive coeffects, and the L-Unload guard. The shipped TypeScript runtime realizes the paradigm but buys its guarantees with cooperative discipline — cancellation is a signal, teardown is disposer bookkeeping, and same-process code cannot be hard-killed. Whether the paradigm can instead be realized on the BEAM, where fault isolation, teardown, and code introduction/retraction are process semantics rather than discipline, was an open question.

## Decision

`elixir/` is a self-contained PoC that inherits the paradigm, not the code: a fresh Mix project (`dsh`) realizing the paper's model on Elixir/OTP. Elixir 1.20.2 / OTP 28 are pinned via `.tool-versions`; the only dependency is `spark`.

- The substrate realizes revertible effects (`Dsh.Effect`, the LIFO inverse accumulator), reactive coeffects (`Dsh.Coeffect`), and a unified context (`Dsh.Context`) whose pending-unload state machine implements the L-Unload guard: a provider withdraws only after every dependent drained (acknowledgement, death, or timeout).
- Every plugin is a fiber: `use Dsh.Plugin` generates a `:gen_statem` with the paper's four lifecycle states (`:inactive`, `:reloading`, `:active`, `:unloading`). Fibers own their lifecycle and report transitions; the context mirrors them for dependency-graph computation only.
- The first plugin is the session log (`Dsh.Session` with Memory/File providers). A provider's resource release is a revertible effect registered with the context, so the crash path (`:kill`) still releases the resource only after dependents drained — ordered shutdown.
- Composition is declarative: `Dsh.Composition` entries and `Dsh.Plugin.Dsl` `need`/`provide` declarations are Spark sections with compile-time validation and runtime introspection.
- Creator mode (`Dsh.Creator`) compiles source strings, loads them through the BEAM code server, and mounts them as fibers; `redefine/2` performs transactional hot module replacement (compile first, guard-ordered withdrawal, code swap, rollback on failed start).

The suite (33 ExUnit tests) pins the paper's guarantees: recovery exactness, guard ordering, committed views readable during dependent teardown, confluence of reconfiguration, crash isolation, and the DSL as a surface over the same semantics. The PoC is not wired into the pnpm workspace or CI; it runs with `cd elixir && mix test`.

## Alternatives considered

- **Porting the TypeScript harness module by module.** Rejected: the PoC's purpose is to re-express the paradigm in OTP terms; a port would carry TypeScript-shaped machinery (the type-graph analyzer, cooperative cancellation) that BEAM semantics replace.
- **Keeping fibers as records in one coordinator process.** Rejected after independent review: one GenServer holding all lifecycle state avoided process semantics and made the paradigm's isolation claims unobservable; fibers were promoted to `:gen_statem` processes.
- **Exit-signal deactivation (kill dependents on withdrawal).** Rejected: the paper's fiber survives deactivation and reactivates, and killing a dependent broke provider-swap reactivation; the withdrawal protocol uses a message plus a pid-correlated acknowledgement instead.
- **A hand-rolled DSL.** Rejected: Spark provides compile-time schema validation and runtime introspection that a hand-rolled macro would have to reimplement.

## Consequences

The paradigm's guarantees are demonstrated on the BEAM: the fine-grained inverse accumulator runs inside the context while fiber processes crash and transition independently, and creator-written code is introduced, swapped, and retracted at runtime. The costs: a second toolchain and suite outside repository CI; creator source is trusted (module names become atoms, code runs in-process), so sandboxing untrusted creators — the paper's execution boundary — remains future work; and the Runtime's crash re-injection can race an in-flight withdrawal (`:already_provided`) and needs retry/backoff.
