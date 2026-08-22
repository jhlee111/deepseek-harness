# Agent Browser (plugin branch)

This fork ships the `dsh-agent-browser` community plugin **pre-wired** on the
`agent-browser` branch. Everything is additive:

- `packages/agent-browser/agent-browser` — host half (headed Chrome, toolbar,
  `browser_launch`/`browser_feedback`/`browser_capture` tools, feedback + launch
  settings endpoints, dev-server auto-start, page `evaluate`).
- `packages/client/ui-agent-browser` — web client surface (feedback card above
  the composer, Settings → Agent Browser launch settings).
- `packages/bundle/web-app/cordis.patch.yml` — one roster `insert` row loads the
  client surface into the GUI.
- `contrib/agent-browser/` — the per-session host preset fragment + one-shot
  installer.

## Quickstart

```sh
git clone https://github.com/jhlee111/deepseek-harness
cd deepseek-harness
git checkout agent-browser
pnpm install
pnpm run build:lib:host
pnpm run build:lib:client
sh contrib/agent-browser/install.sh    # copies the Agent Browser preset into ~/.dsh
pnpm dsh web --port 3081
```

In the GUI, create a session with the **Agent Browser** preset and ask the agent
to `browser_launch`. Then:

- toolbar: Pick / Draw → **Send → agent** (feedback appears above the composer)
- Settings → **Agent Browser**: default URL, viewport, window size, and an
  optional dev-server command (`<command>` / `<working dir>` / `<port>`) that the
  host runs, waits for, and opens on the next launch.

## Syncing with upstream

```sh
git fetch upstream
git merge upstream/master   # our changes are additive, merges stay small
```

## Canonical source

The plugin code lives in its own repo:
https://github.com/jhlee111/dsh-agent-browser (topic `dsh-plugin`).
