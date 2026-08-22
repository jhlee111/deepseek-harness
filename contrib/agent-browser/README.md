# Agent Browser preset

The host half of `dsh-agent-browser` loads per-session through this agent
preset. `install.sh` copies the shipped `standard` preset into
`~/.dsh/.agent-presets/agent-browser/` and appends `agent-browser.patch.yml`
(the one host row below):

```yaml
- id: agent-browser
  name: '@deepseek-ai/dsh-agent-browser'
  config:
    defaultUrl: http://localhost:4000/todos
```

The web client surface (feedback card, Settings section) does not need this
preset — the bundle roster row in `packages/bundle/web-app/cordis.patch.yml`
loads it for every GUI session.

Change `defaultUrl` to your dev server, or leave the default and configure per
project in Settings → Agent Browser.
