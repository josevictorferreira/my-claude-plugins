---
description: Summarize the last agent reply and play it as speech (again: stop)
allowed-tools: Bash(node:*)
---

!`node "$CLAUDE_PLUGIN_ROOT/scripts/speak.mjs"`

The command above has already run and its output is shown to the user. Reply with
that single status line and nothing else. Do not summarize anything, do not run
any tool, and do not continue the previous task.
