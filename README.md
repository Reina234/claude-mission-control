# Mission Control

A Claude Code plugin that gives you a board of your sessions and to-dos, a
game-style context "health bar" above the prompt, and a "waiting on you" inbox.

## Install

```text
/plugin install mission-control --marketplace Reina234/claude-mission-control
```

Say `y` to add the marketplace, pick a scope (user = all your sessions), done.
It loads automatically in every session after that.

## What it does

- **Board pane** (`/board` to toggle, **Esc** to close): your tracked sessions
  and manual to-dos, grouped by topic. Each session shows a state emoji, a
  one-line summary, its branch, and how long since it was last active.
- **Context health bar** above the prompt: a green→red segmented bar scaled to a
  200k "budget", a worry face as usage climbs (💚 💛 ❤️ 😟 😨 💀), and a 💥 burst
  once you pass the budget. The real context limit still shows in the numbers.
- **Inbox**: a `📥‼️ N waiting` count of other sessions that finished and are
  waiting on you (or `🫥 no new messages`).
- **Branch-conflict warning**: a background check that flags when your branch and
  another local branch have changed the same files versus `main`.

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

## macOS-only features

`/enter` and the `↗ enter` button open a new **macOS Terminal** window via
`osascript`, and desktop notifications when a background agent finishes also use
`osascript`. On other systems those are skipped automatically; everything else
works cross-platform.
