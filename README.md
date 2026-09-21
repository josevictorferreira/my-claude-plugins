# my-claude-plugins

Custom [Claude Code](https://code.claude.com) plugins. The repo is itself a
plugin marketplace, so adding it once makes every plugin here installable by
name.

## Plugins

| Plugin | Description |
| --- | --- |
| [voice](plugins/voice/) | `/speak` reads the last agent reply aloud, `/dictate` transcribes your microphone to the clipboard — both through [Velox](https://velox.josevictor.me) |

## Install

```
/plugin marketplace add josevictorferreira/my-claude-plugins
/plugin install voice@my-claude-plugins
```

Update everything later with `/plugin marketplace update my-claude-plugins`.

## Development

Point the marketplace at a local checkout (`claude plugin` works from a shell
too, and needs the `./` prefix on a path):

```sh
claude plugin marketplace add ./
claude plugin install voice@my-claude-plugins
claude plugin validate .
```

Installing copies the plugin to `~/.claude/plugins/cache/my-claude-plugins/`, so
edits to the checkout are not live — run `claude plugin marketplace update
my-claude-plugins && claude plugin update voice` and restart to pick them up.

## Layout

```
.claude-plugin/marketplace.json   one entry per plugin
plugins/<name>/
├── .claude-plugin/plugin.json    manifest
├── commands/*.md                 slash commands
├── hooks/hooks.json              event hooks
├── scripts/                      implementation
└── README.md                     tools, configuration, caveats
```

## Conventions

- One directory per plugin under `plugins/`, listed in the root
  `marketplace.json`.
- Scripts run on Node with no dependencies — Claude Code ships its own Node, and
  a plugin that needs `npm install` is not worth the install friction.
- Reference the plugin's own files through `$CLAUDE_PLUGIN_ROOT`, never a
  relative or absolute path.
- Each plugin documents its environment variables and the external commands it
  shells out to in its own `README.md`.
