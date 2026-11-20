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
}

export interface TaskBarState {
  /** the chat's main to-do list */
  tasks: Task[]
  /** the progress tool's goal for the main list; null when none */
  goal: string | null
  agents: AgentCard[]
  paneClosedByUser: boolean
}

declare module 'claude-code' {
  interface PluginState {
    // Each key spelled out: `claude plugin validate` reads the names here.
    'task-bar': {
      tasks: Task[]
      goal: string | null
      agents: AgentCard[]
      paneClosedByUser: boolean
    }
  }
}
