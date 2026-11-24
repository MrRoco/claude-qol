// The state contract of the task-bar mod: what it keeps in `$.state` for the
// session. Nothing here is written to disk, logs or the network.

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export interface Task {
  /** TaskCreate id, or the list index for TodoWrite */
  id: string
  /** subject / content */
  title: string
  /** activeForm */
  activeTitle?: string
  status: TaskStatus
}

/**
 * What the engine tells about a subagent, as last read from `$.agent.list()`:
 * model ids, numbers and a folder name only, never a description, prompt,
 * input or result.
 */
export interface AgentFacts {
  /** model id of the latest usage entry, else the agent's `model` */
  model?: string
  /** every model id in its usage, in order; more than one = a fallback */
  models: string[]
  /** effort level or number as written; absent = the session's */
  effort?: string
  contextWindowSize?: number
  tokenCount: number
  /** input + cache creation + cache read, summed over its usage */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** estimate, USD, as `/cost` counts it */
  costUsd?: number
  hasUnknownPrice?: boolean
  /** last path part of its folder when that is not the session's own */
  worktree?: string
  /** type of the parent card; absent = started by the main chat */
  parentType?: string
}

export interface AgentCard {
  /** agentId */
  id: string
  /** subagent type, e.g. "Explore" */
  type: string
  /** Agent call description */
  description: string
  status: 'running' | 'done' | 'failed'
  /** ms, from $.clock */
  startedAt: number
  endedAt?: number
  toolCalls: number
  /** tool name only, never its input */
  lastTool?: string
  /** the agent's own TodoWrite list, [] when none */
  tasks: Task[]
  /** calls per tool name, names only */
  toolCounts: Record<string, number>
  /** last snapshot; kept once the agent is no longer listed */
  facts?: AgentFacts
  /** why a failed card ended */
  endReason?: 'error' | 'aborted'
}

export interface TaskBarState {
  /** the chat's main to-do list */
  tasks: Task[]
  /** the progress tool's goal for the main list; null when none */
  goal: string | null
  agents: AgentCard[]
  paneClosedByUser: boolean
  /** id of the one expanded card, null when none */
  openCard: string | null
}

declare module 'claude-code' {
  interface PluginState {
    // Each key spelled out: `claude plugin validate` reads the names here.
    'task-bar': {
      tasks: Task[]
      goal: string | null
      agents: AgentCard[]
      paneClosedByUser: boolean
      openCard: string | null
    }
  }
}
