import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register } from 'claude-code'

import type { McTask, McThread, McThreadState } from '../types'

const PANE = 'mission-control'
const MAIN_BRANCH = 'main'
const DEFAULT_TOPIC = 'general'
const DEFAULT_TITLE = 'Mission Control'
const BAR_WIDTH = 16
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const STALE_MS = 3 * DAY_MS
const FORGET_MS = 30 * DAY_MS
const UPPER_BOUND = 200_000
const SEED_VERSION = 2

const BRANCH_COLOR = '#7dd3fc'
const AGE_COLOR = '#c4b5fd'

const tasks = atom({ plugin: 'mission-control', key: 'tasks' } as const, [] as McTask[])
const threads = atom({ plugin: 'mission-control', key: 'threads' } as const, [] as McThread[])
const doneTopics = atom({ plugin: 'mission-control', key: 'doneTopics' } as const, [] as string[])
const collapsedTopics = atom(
  { plugin: 'mission-control', key: 'collapsedTopics' } as const,
  [] as string[],
)
const conflictLine = atom(
  { plugin: 'mission-control', key: 'conflict' } as const,
  null as string | null,
)

async function runCommand($: CoreEngineInterface, argv: readonly string[]): Promise<string> {
  const stream = $.process.spawn({ argv })
  let out = ''
  for await (const chunk of stream) {
    if (chunk.stream === 'stdout') out += chunk.text
  }
  await stream.result
  return out
}

function runGit($: CoreEngineInterface, args: readonly string[]): Promise<string> {
  return runCommand($, ['git', ...args])
}

async function detectMac($: CoreEngineInterface): Promise<boolean> {
  const out = await runCommand($, ['uname']).catch(() => '')
  return out.trim() === 'Darwin'
}

async function notifyDesktop(
  $: CoreEngineInterface,
  title: string,
  message: string,
): Promise<void> {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`
  await runCommand($, ['osascript', '-e', script])
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function openSessionInTerminal(
  $: CoreEngineInterface,
  sessionId: string,
  cwd: string,
): Promise<void> {
  const command = `cd "${cwd || '.'}" && claude --resume ${sessionId}`
  await runCommand($, [
    'osascript',
    '-e',
    `tell application "Terminal" to do script ${appleScriptString(command)}`,
    '-e',
    'tell application "Terminal" to activate',
  ])
}

async function currentBranch($: CoreEngineInterface): Promise<string> {
  const out = await runGit($, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return out.trim()
}

async function changedVsMain($: CoreEngineInterface, branch: string): Promise<string[]> {
  const out = await runGit($, ['diff', '--name-only', `${MAIN_BRANCH}...${branch}`])
  return out
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

async function computeConflict($: CoreEngineInterface): Promise<string | null> {
  const cur = await currentBranch($)
  if (!cur || cur === 'HEAD') return null

  const ownFiles = new Set(await changedVsMain($, cur))
  if (ownFiles.size === 0) return null

  const branchList = await runGit($, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
  const others = branchList
    .split('\n')
    .map(line => line.trim())
    .filter(name => name && name !== cur && name !== MAIN_BRANCH)

  for (const other of others) {
    const shared = (await changedVsMain($, other)).filter(file => ownFiles.has(file))
    const first = shared[0]
    if (first !== undefined) {
      const extra = shared.length > 1 ? ` (+${shared.length - 1} more)` : ''
      return `${cur} and ${other} both touch ${first}${extra}`
    }
  }
  return null
}

async function refreshConflict($: CoreEngineInterface): Promise<void> {
  const conflict = await computeConflict($).catch(() => null)
  await update($, conflictLine, () => conflict)
}

async function writeTasks(
  $: CoreEngineInterface,
  change: (list: McTask[]) => McTask[],
): Promise<McTask[]> {
  const nextList = await update($, tasks, change)
  await $.store.set('tasks', nextList)
  return nextList
}

async function writeThreads(
  $: CoreEngineInterface,
  change: (list: McThread[]) => McThread[],
): Promise<McThread[]> {
  const nextList = await update($, threads, change)
  await $.store.set('threads', nextList)
  return nextList
}

async function writeDoneTopics(
  $: CoreEngineInterface,
  change: (list: string[]) => string[],
): Promise<string[]> {
  const nextList = await update($, doneTopics, change)
  await $.store.set('doneTopics', nextList)
  return nextList
}

async function writeCollapsedTopics(
  $: CoreEngineInterface,
  change: (list: string[]) => string[],
): Promise<string[]> {
  const nextList = await update($, collapsedTopics, change)
  await $.store.set('collapsedTopics', nextList)
  return nextList
}

async function loadStore($: CoreEngineInterface): Promise<void> {
  const storedTasks = ((await $.store.get('tasks')) as McTask[] | undefined) ?? []
  await update($, tasks, () => storedTasks)
  const storedThreads = ((await $.store.get('threads')) as McThread[] | undefined) ?? []
  await update($, threads, () => storedThreads)
  const storedDone = ((await $.store.get('doneTopics')) as string[] | undefined) ?? []
  await update($, doneTopics, () => storedDone)
  const storedCollapsed = ((await $.store.get('collapsedTopics')) as string[] | undefined) ?? []
  await update($, collapsedTopics, () => storedCollapsed)
}

async function summariseLiveSession(
  $: CoreEngineInterface,
  sessionId: string,
): Promise<void> {
  const result = await $.model
    .fork({
      prompt:
        'In 8 words or fewer, summarise what this session is working on. ' +
        'Reply with only the summary, no quotes and no trailing punctuation.',
    })
    .catch(() => null)
  if (result === null || !result.isAnswered) return
  const summary = result.text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["']|["']$/g, '')
    .slice(0, 60)
  if (!summary) return
  await writeThreads($, list =>
    list.map(thread => (thread.sessionId === sessionId ? { ...thread, name: summary } : thread)),
  )
}

function upsertSession(
  list: readonly McThread[],
  sessionId: string,
  branch: string,
  cwd: string,
  now: number,
): McThread[] {
  const alive = list.filter(thread => now - thread.lastActiveAt < FORGET_MS)
  if (alive.some(thread => thread.sessionId === sessionId)) {
    return alive.map(thread =>
      thread.sessionId === sessionId ? { ...thread, branch, cwd, lastActiveAt: now } : thread,
    )
  }
  const n =
    alive.reduce((max, thread) => Math.max(max, Number(thread.id.replace(/^t/, '')) || 0), 0) + 1
  return [
    ...alive,
    {
      id: `t${n}`,
      sessionId,
      topic: DEFAULT_TOPIC,
      name: '',
      branch,
      cwd,
      tokens: 0,
      state: 'working',
      isDone: false,
      createdAt: now,
      lastActiveAt: now,
    },
  ]
}

async function currentTopic($: CoreEngineInterface): Promise<string> {
  const sessionId = await $.session.id().catch(() => '')
  const list = await read($, threads)
  return list.find(thread => thread.sessionId === sessionId)?.topic ?? DEFAULT_TOPIC
}

function topicsOf(threadList: readonly McThread[], taskList: readonly McTask[]): string[] {
  const set = new Set<string>()
  for (const thread of threadList) set.add(thread.topic)
  for (const task of taskList) set.add(task.topic)
  return [...set]
}

function nextTaskId(list: readonly McTask[]): string {
  const highest = list.reduce((max, task) => Math.max(max, Number(task.id) || 0), 0)
  return String(highest + 1)
}

function fmtAge(ms: number): string {
  const days = Math.floor(ms / DAY_MS)
  if (days > 0) return `${days}d ago`
  return `${Math.max(1, Math.floor(ms / HOUR_MS))}h ago`
}

function isStaleThread(thread: McThread, now: number): boolean {
  return now - thread.lastActiveAt > STALE_MS
}

function threadRank(thread: McThread, now: number): number {
  if (isStaleThread(thread, now)) return 3
  if (thread.state === 'waiting') return 0
  if (thread.state === 'working') return 1
  return 2
}

function needsYouCount(
  list: readonly McThread[],
  currentId: string,
  now: number,
  doneTopicsList: readonly string[],
): number {
  return list.filter(
    thread =>
      !thread.isDone &&
      thread.sessionId !== currentId &&
      !doneTopicsList.includes(thread.topic) &&
      thread.state === 'waiting' &&
      !isStaleThread(thread, now),
  ).length
}

function stateEmoji(state: McThreadState, isStale: boolean): string {
  if (isStale) return '\u{1f35e}'
  if (state === 'working') return '\u{1f373}'
  if (state === 'waiting') return '\u{1f4e5}‼️'
  return '\u{1f4a4}'
}

function truncateEnd(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(1, max - 1))}…`
}

const LEGEND =
  '👉 this session   \u{1f373} working   \u{1f4e5}‼️ waiting on you   \u{1f4a4} idle   \u{1f35e} stale'

type BarCell = { char: string; color?: string; dim?: boolean }

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, '0')
}

function mix(from: readonly number[], to: readonly number[], t: number): number[] {
  return from.map((value, i) => Math.round(value + ((to[i] ?? value) - value) * t))
}

function gradientHex(fraction: number): string {
  const green = [34, 197, 94]
  const amber = [234, 179, 8]
  const red = [239, 68, 68]
  const rgb =
    fraction < 0.5
      ? mix(green, amber, fraction / 0.5)
      : mix(amber, red, (fraction - 0.5) / 0.5)
  return `#${rgb.map(toHex).join('')}`
}

function barCells(percent: number, width: number, overrideColor?: string): BarCell[] {
  const filled = Math.round((clampPct(percent) / 100) * width)
  const cells: BarCell[] = []
  for (let i = 0; i < width; i += 1) {
    cells.push(
      i < filled
        ? { char: '▰', color: overrideColor ?? gradientHex(i / Math.max(1, width - 1)) }
        : { char: '▱', dim: true },
    )
  }
  return cells
}

function statusEmoji(tokens: number): string {
  if (tokens > 750_000) return '\u{1f480}'
  if (tokens > 500_000) return '\u{1f628}'
  if (tokens > 300_000) return '\u{1f61f}'
  const fraction = tokens / UPPER_BOUND
  if (fraction < 0.5) return '\u{1f49a}'
  if (fraction < 0.75) return '\u{1f49b}'
  return '❤️'
}

function dummyThreads(now: number): McThread[] {
  const here = '~/code/example-app'
  const mk = (
    id: string,
    topic: string,
    name: string,
    branch: string,
    tokens: number,
    state: McThreadState,
    ageMs: number,
  ): McThread => ({
    id,
    sessionId: `dummy-${id}`,
    topic,
    name,
    branch,
    cwd: here,
    tokens,
    state,
    isDone: false,
    createdAt: now - 10 * DAY_MS,
    lastActiveAt: now - ageMs,
  })
  return [
    mk('t1', 'search', 'Add pagination to the search endpoint', 'feat/search-pagination', 128_000, 'waiting', 5 * HOUR_MS),
    mk('t2', 'docs', 'Rewrite the getting-started guide', 'docs/getting-started', 46_000, 'working', 2 * HOUR_MS),
    mk('t3', 'bug triage', 'Fix the flaky upload test', 'fix/flaky-upload', 72_000, 'idle', 1 * DAY_MS),
    mk('t4', 'infra', 'Bump the CI Node version', 'chore/ci-node', 31_000, 'working', 6 * HOUR_MS),
    mk('t5', 'refactor', 'Split the auth module', 'refactor/auth-split', 95_000, 'waiting', 35 * 60 * 1000),
    mk('t6', 'release', 'Cut v2.1.0', 'release/2.1.0', 184_000, 'working', 10 * 60 * 1000),
    mk('t7', 'make cool mods', 'Polish the board layout', 'feat/board-polish', 58_000, 'waiting', 20 * 60 * 1000),
  ]
}

function dummyTasks(): McTask[] {
  return [
    { id: '1', text: 'Write the release notes', topic: 'release', isDone: false },
    { id: '2', text: 'Set up permanent plugin install', topic: 'make cool mods', isDone: false },
    { id: '3', text: 'Add a dark-mode legend', topic: 'make cool mods', isDone: false },
  ]
}

async function openBoard($: CoreEngineInterface, fallback: string): Promise<unknown> {
  const sessionId = await $.session.id().catch(() => '')
  const list = await read($, threads)
  const name = (list.find(thread => thread.sessionId === sessionId)?.name ?? '').trim()
  const titleText = name.length > 0 ? name : fallback
  return $.ui.open({
    id: PANE,
    title: titleText,
    rows: 22,
    columns: 96,
    focus: true,
    closeOnEscape: true,
  })
}

export const register: Register = (on, options) => {
  let firstPrompt = true
  let boardOpen = false
  let isMac = false
  const configured = options.boardTitle
  const title =
    typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_TITLE
  const banner = `✨  ${title.toUpperCase()}  ✨`

  on('session.start', async ($, e, next) => {
    const registerCommand = (name: string, description: string): Promise<unknown> =>
      $.command.register({ name, description }).catch(() => undefined)
    await registerCommand('board', 'Toggle the Mission Control board')
    await registerCommand('task', 'Add a to-do: /task <text> [@topic]')
    await registerCommand('done', 'Tick a task: /done <id>')
    await registerCommand('forget', 'Remove a thread: /forget <id|name>')
    await registerCommand('topic', 'Set this session topic: /topic <name>')
    await registerCommand('name', 'Name this session: /name <text>')
    await registerCommand('enter', 'Open a tracked session in a new Terminal window (macOS)')

    isMac = await detectMac($).catch(() => false)

    void openBoard($, title)
    boardOpen = true
    await loadStore($).catch(() => undefined)

    const now = await $.clock.now()
    const seeded = (await $.store.get('seedVersion')) as number | undefined
    const existing = await read($, threads)
    if (existing.length === 0 || seeded !== SEED_VERSION) {
      await writeThreads($, () => dummyThreads(now)).catch(() => undefined)
      await writeTasks($, () => dummyTasks()).catch(() => undefined)
      await writeDoneTopics($, () => []).catch(() => undefined)
      await writeCollapsedTopics($, () => []).catch(() => undefined)
      await $.store.set('seedVersion', SEED_VERSION).catch(() => undefined)
    }

    const sessionId = await $.session.id().catch(() => '')
    const branch = await currentBranch($).catch(() => '(no branch)')
    const cwd = await $.session.cwd().catch(() => '')
    if (sessionId) {
      await writeThreads($, list => upsertSession(list, sessionId, branch, cwd, now)).catch(
        () => undefined,
      )
      const usage = await $.session.usage().catch(() => null)
      const tokens = usage ? usage.context.tokens ?? 0 : 0
      await writeThreads($, list =>
        list.map(thread => (thread.sessionId === sessionId ? { ...thread, tokens } : thread)),
      ).catch(() => undefined)
    }

    await refreshConflict($).catch(() => undefined)
    $.clock.every(60_000, () => {
      refreshConflict($).catch(() => undefined)
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (firstPrompt) {
      firstPrompt = false
      boardOpen = false
      $.ui.close({ id: PANE }).catch(() => undefined)
    }
    const sessionId = await $.session.id().catch(() => '')
    if (sessionId) {
      const now = await $.clock.now()
      await writeThreads($, list =>
        list.map(thread =>
          thread.sessionId === sessionId
            ? { ...thread, lastActiveAt: now, state: 'working' }
            : thread,
        ),
      ).catch(() => undefined)
    }
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    if (boardOpen) {
      boardOpen = false
      await $.ui.close({ id: PANE }).catch(() => undefined)
      return { text: `${title} closed.` }
    }
    boardOpen = true
    await openBoard($, title)
    return { text: `${title} opened.` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    boardOpen = false
    return next(e)
  })

  on('command.run', { command: 'task' }, async ($, e) => {
    const raw = e.args.trim()
    if (!raw) return { text: 'Usage: /task <description> [@topic]' }

    const targeted = raw.match(/\s@(.+)$/)
    const text = targeted ? raw.slice(0, targeted.index ?? raw.length).trim() : raw
    if (!text) return { text: 'Usage: /task <description> [@topic]' }
    const topic = targeted ? (targeted[1] ?? '').trim() : await currentTopic($)

    await writeTasks($, list => [...list, { id: nextTaskId(list), text, topic, isDone: false }])
    boardOpen = true
    await openBoard($, title)
    return { text: `Added to "${topic}".` }
  })

  on('command.run', { command: 'done' }, async ($, e) => {
    const id = e.args.trim()
    if (!id) return { text: 'Usage: /done <id>' }

    await writeTasks($, list =>
      list.map(task => (task.id === id ? { ...task, isDone: true } : task)),
    )
    return { text: `Ticked #${id}.` }
  })

  on('command.run', { command: 'forget' }, async ($, e) => {
    const needle = e.args.trim().toLowerCase()
    if (!needle) return { text: 'Usage: /forget <id|name>' }

    await writeThreads($, list =>
      list.filter(thread => thread.id !== needle && !thread.name.toLowerCase().includes(needle)),
    )
    return { text: `Forgot threads matching "${needle}".` }
  })

  on('command.run', { command: 'topic' }, async ($, e) => {
    const name = e.args.trim()
    if (!name) return { text: 'Usage: /topic <name>' }

    const sessionId = await $.session.id().catch(() => '')
    await writeThreads($, list =>
      list.map(thread => (thread.sessionId === sessionId ? { ...thread, topic: name } : thread)),
    )
    return { text: `This session is now under "${name}".` }
  })

  on('command.run', { command: 'name' }, async ($, e) => {
    const name = e.args.trim()
    if (!name) return { text: 'Usage: /name <session name>' }

    const sessionId = await $.session.id().catch(() => '')
    await writeThreads($, list =>
      list.map(thread => (thread.sessionId === sessionId ? { ...thread, name } : thread)),
    )
    return { text: `This session is now "${name}".` }
  })

  on('command.run', { command: 'enter' }, async ($, e) => {
    if (!isMac) {
      return { text: 'Entering a session opens a new macOS Terminal window; not available on this OS.' }
    }
    const currentId = await $.session.id().catch(() => '')
    const candidates = (await read($, threads)).filter(
      thread => !thread.isDone && thread.sessionId !== currentId,
    )
    const labelFor = (thread: McThread): string => thread.name || thread.sessionId.slice(0, 8)
    const chosen = candidates[0]
    if (chosen === undefined) return { text: 'No other tracked sessions to enter.' }

    let target = chosen
    if (candidates.length > 1) {
      const labels = candidates.slice(0, 4).map(labelFor)
      const picked = await $.ui.ask('Enter which session?', labels).catch(() => '')
      const match = candidates.find(thread => labelFor(thread) === picked)
      if (match === undefined) return { text: 'Cancelled.' }
      target = match
    }

    await openSessionInTerminal($, target.sessionId, target.cwd).catch(() => undefined)
    return { text: `Opening "${labelFor(target)}" in a new Terminal window.` }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      $.ui.toast('A background agent finished')
      if (isMac) {
        notifyDesktop($, 'Claude Code', 'A background agent finished').catch(() => undefined)
      }
      return next(e)
    }

    const sessionId = await $.session.id().catch(() => '')
    if (sessionId) {
      const usage = await $.session.usage().catch(() => null)
      const tokens = usage ? usage.context.tokens ?? 0 : 0
      await writeThreads($, list =>
        list.map(thread =>
          thread.sessionId === sessionId ? { ...thread, state: 'waiting', tokens } : thread,
        ),
      ).catch(() => undefined)
      await summariseLiveSession($, sessionId).catch(() => undefined)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const usage = await $.session.usage().catch(() => null)
    if (usage === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const rawTokens = usage.context.tokens
    const measuring = rawTokens === undefined
    const used = rawTokens ?? 0
    const limit = usage.context.window ?? 1_000_000
    const percent = clampPct((used / UPPER_BOUND) * 100)
    const over = used > UPPER_BOUND

    const currentId = await $.session.id().catch(() => '')
    const now = await $.clock.now()
    const waiting = needsYouCount(
      await read($, threads),
      currentId,
      now,
      await read($, doneTopics),
    )
    const columns = e.viewport?.columns
    const width = columns !== undefined ? Math.max(1, columns - 5) : undefined

    return (
      <Box width={width} justifyContent="flex-end">
        {waiting > 0 ? (
          <Text color="#f59e0b">{`📥‼️ ${waiting} waiting    `}</Text>
        ) : (
          <Text dimColor>{`🫥 no new messages    `}</Text>
        )}
        <Text>{`${measuring ? '🩺' : statusEmoji(used)} `}</Text>
        {measuring
          ? Array.from({ length: BAR_WIDTH }).map((_, i) => (
              <Text key={`ap-${i}`} dimColor>
                {'▱'}
              </Text>
            ))
          : barCells(percent, BAR_WIDTH, over ? '#ef4444' : undefined).map((cell, i) => (
              <Text key={`ap-${i}`} color={cell.color} dimColor={cell.dim}>
                {cell.char}
              </Text>
            ))}
        {!measuring && over && <Text>{'💥'}</Text>}
        <Text dimColor>{measuring ? '  measuring…' : `  ${fmtTokens(used)} / ${fmtTokens(limit)}`}</Text>
        <Text>{' '}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const taskList = await read($, tasks)
    const threadList = await read($, threads)
    const closedTopics = await read($, doneTopics)
    const collapsed = await read($, collapsedTopics)
    const conflict = await read($, conflictLine)
    const now = await $.clock.now()
    const currentId = await $.session.id().catch(() => '')
    const topics = topicsOf(threadList, taskList)
    const width = e.viewport?.columns
    const contentWidth = (width ?? 60) - 6

    return (
      <Box flexDirection="column" width={width} paddingLeft={3} paddingRight={3}>
        <Box justifyContent="flex-end">
          <Button
            plain
            role="dismiss"
            key="board-close"
            label={'✕ close'}
            onPress={() => {
              boardOpen = false
              void $.ui.close({ id: PANE })
            }}
          />
        </Box>
        <Box justifyContent="center">
          <Text bold>{banner}</Text>
        </Box>
        <Text dimColor>{LEGEND}</Text>
        <Text> </Text>
        <Text bold>{'Open tasks:'}</Text>
        <Box flexDirection="column">
          {topics.length === 0 && (
            <Text dimColor>{'  Nothing tracked yet. Add a to-do with /task <text>.'}</Text>
          )}
          {topics
            .filter(topic => !closedTopics.includes(topic))
            .map(topic => {
              const isCollapsed = collapsed.includes(topic)
              const openThreads = threadList
                .filter(thread => thread.topic === topic && !thread.isDone)
                .sort((a, b) => threadRank(a, now) - threadRank(b, now))
              const openTasks = taskList.filter(task => task.topic === topic && !task.isDone)
              return (
                <Box key={`topic-${topic}`} flexDirection="column">
                  <Box>
                    <Button
                      plain
                      key={`collapse-${topic}`}
                      label={isCollapsed ? '▸' : '▾'}
                      onPress={() =>
                        writeCollapsedTopics($, list =>
                          list.includes(topic)
                            ? list.filter(name => name !== topic)
                            : [...list, topic],
                        )
                      }
                    />
                    <Button
                      plain
                      key={`topic-check-${topic}`}
                      label={' ☐'}
                      onPress={() => writeDoneTopics($, list => [...list, topic])}
                    />
                    <Text bold>{` ${topic}`}</Text>
                  </Box>
                  {!isCollapsed &&
                    openThreads.map(thread => {
                      const isStale = isStaleThread(thread, now)
                      const isCurrent = thread.sessionId === currentId
                      const emoji = isCurrent ? '👉 ' : stateEmoji(thread.state, isStale)
                      const showEnter = isMac && !isCurrent
                      const meta = `   ${thread.branch}   ${fmtAge(now - thread.lastActiveAt)} `
                      const nameBudget = Math.max(
                        8,
                        contentWidth - 6 - meta.length - (showEnter ? 8 : 0),
                      )
                      const shownName = truncateEnd(thread.name || 'in progress', nameBudget)
                      return (
                        <Box key={thread.id} paddingLeft={3}>
                          <Text>{`${emoji} `}</Text>
                          <Text dimColor={isStale} wrap="truncate-end">
                            {shownName}
                          </Text>
                          <Text color={BRANCH_COLOR}>{`   ${thread.branch}`}</Text>
                          <Text color={AGE_COLOR}>{`   ${fmtAge(now - thread.lastActiveAt)} `}</Text>
                          {showEnter && (
                            <Button
                              plain
                              key={`enter-${thread.id}`}
                              label={'↗ enter'}
                              onPress={() =>
                                openSessionInTerminal($, thread.sessionId, thread.cwd)
                              }
                            />
                          )}
                        </Box>
                      )
                    })}
                  {!isCollapsed &&
                    openTasks.map(task => (
                      <Box key={`task-${task.id}`} paddingLeft={3}>
                        <Button
                          plain
                          key={`task-check-${task.id}`}
                          label={'○'}
                          onPress={() =>
                            writeTasks($, l =>
                              l.map(x => (x.id === task.id ? { ...x, isDone: !x.isDone } : x)),
                            )
                          }
                        />
                        <Text>{` ${task.text}`}</Text>
                      </Box>
                    ))}
                  <Text> </Text>
                </Box>
              )
            })}
          {topics.some(topic => closedTopics.includes(topic)) && (
            <Box flexDirection="column">
              <Text bold dimColor>{'Completed:'}</Text>
              {topics
                .filter(topic => closedTopics.includes(topic))
                .map(topic => (
                  <Box key={`done-${topic}`}>
                    <Button
                      plain
                      key={`done-check-${topic}`}
                      label={'☑'}
                      onPress={() =>
                        writeDoneTopics($, list => list.filter(name => name !== topic))
                      }
                    />
                    <Text dimColor>{` ${topic}`}</Text>
                  </Box>
                ))}
            </Box>
          )}
          {conflict !== null && (
            <Box flexDirection="column">
              <Text> </Text>
              <Text color="yellow">{'⚠ '}{conflict}</Text>
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
