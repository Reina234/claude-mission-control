# Mission Control

A Claude Code plugin that gives you a board of your sessions and to-dos (and any branch conflict warnings), as well as a little context health bar and inbox line above the messages in each session. Please let me know about bugs! This has only ever been tested on Macs (specifically, my mac)

## Install

```text
/plugin install mission-control --marketplace Reina234/claude-mission-control
```

Say `y` to add the marketplace, pick a scope (user = all your sessions) -> done!


## Legend

👉 this session   🍳 working   📥‼️ waiting on you   💤 idle   🍞 stale

## Commands

- `/board` — toggle the board
- `/task <text> [@topic]` — add a to-do, optionally under a topic
- `/done <id>` — tick a task
- `/topic <name>` — set this session's topic
- `/name <text>` — name this session
- `/forget <id|name>` — drop a tracked thread
- `/enter` — open another tracked session in a new Terminal window (macOS only)

## Configuration

`boardTitle` — the heading shown at the top of the board (default
"Mission Control"). Set it with `/plugin configure mission-control`.

## Fullscreen

In a normal terminal the board opens inline above the prompt. Run
`/tui fullscreen` to switch Claude Code into its fullscreen layout, and the
board docks as a side panel beside the transcript instead. `/tui default`
switches back.

