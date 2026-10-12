export type McTask = {
  id: string
  text: string
  topic: string
  isDone: boolean
}

export type McThreadState = 'working' | 'waiting' | 'idle'

export type McThread = {
  id: string
  sessionId: string
  topic: string
  name: string
  branch: string
  cwd: string
  tokens: number
  state: McThreadState
  isDone: boolean
  createdAt: number
  lastActiveAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      tasks: McTask[]
      threads: McThread[]
      doneTopics: string[]
      collapsedTopics: string[]
      conflict: string | null
    }
  }
}
