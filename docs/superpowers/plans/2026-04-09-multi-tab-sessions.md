# Multi-Tab Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop webapp 支持多 Tab 并行 Session，每个 Tab 独立 WebSocket 连接和消息状态。

**Architecture:** 新增 tabStore 管理 Tab 状态；将 chatStore 从单 session 改为 per-session Map；将 wsManager 从单例连接改为多连接管理器；新增 TabBar 组件放在内容区域顶部；修改 Sidebar 点击行为为 openTab 模式。

**Tech Stack:** React 18, Zustand 5, Tailwind CSS 4, TypeScript, Vite

---

### Task 1: WebSocket Manager 多连接重构

**Files:**
- Modify: `desktop/src/api/websocket.ts`

- [ ] **Step 1: 重构 WebSocketManager 为多连接管理器**

将单例 WS 连接改为 `Map<sessionId, connection>` 模式。每个方法都以 sessionId 为 key。

```ts
import type { ClientMessage, ServerMessage } from '../types/chat'
import { getBaseUrl } from './client'

type MessageHandler = (msg: ServerMessage) => void

type Connection = {
  ws: WebSocket
  handlers: Set<MessageHandler>
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempt: number
  pingInterval: ReturnType<typeof setInterval> | null
  intentionalClose: boolean
  pendingMessages: ClientMessage[]
}

class WebSocketManager {
  private connections = new Map<string, Connection>()

  isConnected(sessionId: string): boolean {
    const conn = this.connections.get(sessionId)
    return conn?.ws.readyState === WebSocket.OPEN
  }

  getConnectedSessionIds(): string[] {
    return [...this.connections.keys()]
  }

  connect(sessionId: string) {
    // Already connected or connecting
    const existing = this.connections.get(sessionId)
    if (existing && !existing.intentionalClose) return

    const conn: Connection = {
      ws: null as unknown as WebSocket,
      handlers: new Set(),
      reconnectTimer: null,
      reconnectAttempt: 0,
      pingInterval: null,
      intentionalClose: false,
      pendingMessages: [],
    }
    this.connections.set(sessionId, conn)

    const wsUrl = getBaseUrl().replace(/^http/, 'ws')
    conn.ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)

    conn.ws.onopen = () => {
      conn.reconnectAttempt = 0
      this.startPingLoop(sessionId)
      while (conn.pendingMessages.length > 0) {
        const msg = conn.pendingMessages.shift()!
        conn.ws.send(JSON.stringify(msg))
      }
    }

    conn.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage
        for (const handler of conn.handlers) {
          handler(msg)
        }
      } catch {
        // Ignore malformed messages
      }
    }

    conn.ws.onclose = () => {
      this.stopPingLoop(sessionId)
      if (!conn.intentionalClose) {
        this.scheduleReconnect(sessionId)
      }
    }

    conn.ws.onerror = () => {
      // onclose will fire after onerror
    }
  }

  disconnect(sessionId: string) {
    const conn = this.connections.get(sessionId)
    if (!conn) return

    conn.intentionalClose = true
    this.stopPingLoop(sessionId)
    this.clearReconnect(sessionId)
    conn.pendingMessages = []

    if (conn.ws) {
      conn.ws.close()
    }
    this.connections.delete(sessionId)
  }

  disconnectAll() {
    for (const sessionId of [...this.connections.keys()]) {
      this.disconnect(sessionId)
    }
  }

  send(sessionId: string, message: ClientMessage) {
    const conn = this.connections.get(sessionId)
    if (!conn) return

    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(message))
    } else if (conn.ws.readyState === WebSocket.CONNECTING) {
      conn.pendingMessages.push(message)
    }
  }

  onMessage(sessionId: string, handler: MessageHandler): () => void {
    const conn = this.connections.get(sessionId)
    if (!conn) return () => {}
    conn.handlers.add(handler)
    return () => { conn.handlers.delete(handler) }
  }

  clearHandlers(sessionId: string) {
    const conn = this.connections.get(sessionId)
    if (conn) conn.handlers.clear()
  }

  private startPingLoop(sessionId: string) {
    this.stopPingLoop(sessionId)
    const conn = this.connections.get(sessionId)
    if (!conn) return
    conn.pingInterval = setInterval(() => {
      this.send(sessionId, { type: 'ping' })
    }, 30_000)
  }

  private stopPingLoop(sessionId: string) {
    const conn = this.connections.get(sessionId)
    if (conn?.pingInterval) {
      clearInterval(conn.pingInterval)
      conn.pingInterval = null
    }
  }

  private scheduleReconnect(sessionId: string) {
    this.clearReconnect(sessionId)
    const conn = this.connections.get(sessionId)
    if (!conn) return

    const delay = Math.min(1000 * 2 ** conn.reconnectAttempt, 30_000)
    conn.reconnectAttempt++

    conn.reconnectTimer = setTimeout(() => {
      if (this.connections.has(sessionId) && !conn.intentionalClose) {
        // Re-create connection
        this.connections.delete(sessionId)
        this.connect(sessionId)
        // Re-register handlers from old connection
        const newConn = this.connections.get(sessionId)
        if (newConn) {
          for (const handler of conn.handlers) {
            newConn.handlers.add(handler)
          }
        }
      }
    }, delay)
  }

  private clearReconnect(sessionId: string) {
    const conn = this.connections.get(sessionId)
    if (conn?.reconnectTimer) {
      clearTimeout(conn.reconnectTimer)
      conn.reconnectTimer = null
    }
  }
}

export const wsManager = new WebSocketManager()
```

- [ ] **Step 2: 验证编译通过**

Run: `cd /Users/nanmi/workspace/myself_code/claude-code-haha/desktop && npx tsc --noEmit 2>&1 | head -30`
Expected: chatStore.ts 会有类型错误（因为调用方式变了），这是预期的，Task 2 会修复。

- [ ] **Step 3: Commit**

```bash
git add desktop/src/api/websocket.ts
git commit -m "refactor: websocket manager supports multiple concurrent connections"
```

---

### Task 2: chatStore 多 Session 状态隔离

**Files:**
- Modify: `desktop/src/stores/chatStore.ts`

- [ ] **Step 1: 重构 chatStore 为 per-session 状态管理**

将 `messages`, `chatState`, `streamingText` 等状态从顶层单一值改为按 sessionId 隔离的 Map 结构。

```ts
import { create } from 'zustand'
import { wsManager } from '../api/websocket'
import { sessionsApi } from '../api/sessions'
import { useTeamStore } from './teamStore'
import { useSessionStore } from './sessionStore'
import { useCLITaskStore } from './cliTaskStore'
import { randomSpinnerVerb } from '../config/spinnerVerbs'
import type { MessageEntry } from '../types/session'
import type { PermissionMode } from '../types/settings'
import type { AttachmentRef, ChatState, UIAttachment, UIMessage, ServerMessage, TokenUsage } from '../types/chat'

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export type PerSessionState = {
  messages: UIMessage[]
  chatState: ChatState
  connectionState: ConnectionState
  streamingText: string
  streamingToolInput: string
  activeToolUseId: string | null
  activeToolName: string | null
  activeThinkingId: string | null
  pendingPermission: {
    requestId: string
    toolName: string
    input: unknown
    description?: string
  } | null
  tokenUsage: TokenUsage
  elapsedSeconds: number
  statusVerb: string
  slashCommands: Array<{ name: string; description: string }>
  elapsedTimer: ReturnType<typeof setInterval> | null
}

function createDefaultSessionState(): PerSessionState {
  return {
    messages: [],
    chatState: 'idle',
    connectionState: 'disconnected',
    streamingText: '',
    streamingToolInput: '',
    activeToolUseId: null,
    activeToolName: null,
    activeThinkingId: null,
    pendingPermission: null,
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    elapsedSeconds: 0,
    statusVerb: '',
    slashCommands: [],
    elapsedTimer: null,
  }
}

type ChatStore = {
  sessions: Record<string, PerSessionState>

  // Actions — all scoped by sessionId
  connectToSession: (sessionId: string) => void
  disconnectSession: (sessionId: string) => void
  sendMessage: (sessionId: string, content: string, attachments?: AttachmentRef[]) => void
  respondToPermission: (sessionId: string, requestId: string, allowed: boolean, rule?: string) => void
  setSessionPermissionMode: (sessionId: string, mode: PermissionMode) => void
  stopGeneration: (sessionId: string) => void
  loadHistory: (sessionId: string) => Promise<void>
  clearMessages: (sessionId: string) => void
  handleServerMessage: (sessionId: string, msg: ServerMessage) => void

  // Helpers
  getSession: (sessionId: string) => PerSessionState
}

const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite'])
const pendingTaskToolUseIds = new Set<string>()

let msgCounter = 0
const nextId = () => `msg-${++msgCounter}-${Date.now()}`

export const useChatStore = create<ChatStore>((set, get) => ({
  sessions: {},

  getSession: (sessionId: string): PerSessionState => {
    return get().sessions[sessionId] ?? createDefaultSessionState()
  },

  connectToSession: (sessionId: string) => {
    const existing = get().sessions[sessionId]
    if (existing && existing.connectionState !== 'disconnected') return

    // Initialize session state
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...createDefaultSessionState(),
          connectionState: 'connecting',
          // Preserve messages if reconnecting
          messages: existing?.messages ?? [],
        },
      },
    }))

    wsManager.clearHandlers(sessionId)
    wsManager.connect(sessionId)
    wsManager.onMessage(sessionId, (msg) => {
      if (msg.type === 'connected') {
        set((s) => ({
          sessions: {
            ...s.sessions,
            [sessionId]: { ...s.sessions[sessionId]!, connectionState: 'connected' },
          },
        }))
      }
      get().handleServerMessage(sessionId, msg)
    })

    // Load history and tasks
    get().loadHistory(sessionId)
    useCLITaskStore.getState().fetchSessionTasks(sessionId)
    sessionsApi.getSlashCommands(sessionId)
      .then(({ commands }) => {
        const current = get().sessions[sessionId]
        if (current) {
          set((s) => ({
            sessions: {
              ...s.sessions,
              [sessionId]: { ...s.sessions[sessionId]!, slashCommands: commands },
            },
          }))
        }
      })
      .catch(() => {
        const current = get().sessions[sessionId]
        if (current) {
          set((s) => ({
            sessions: {
              ...s.sessions,
              [sessionId]: { ...s.sessions[sessionId]!, slashCommands: [] },
            },
          }))
        }
      })
  },

  disconnectSession: (sessionId: string) => {
    const session = get().sessions[sessionId]
    if (session?.elapsedTimer) clearInterval(session.elapsedTimer)

    wsManager.disconnect(sessionId)

    set((s) => {
      const { [sessionId]: _, ...rest } = s.sessions
      return { sessions: rest }
    })
  },

  sendMessage: (sessionId: string, content: string, attachments?: AttachmentRef[]) => {
    const userFacingContent = content.trim()
    const uiAttachments: UIAttachment[] | undefined =
      attachments && attachments.length > 0
        ? attachments.map((attachment) => ({
            type: attachment.type,
            name: attachment.name || attachment.path || attachment.mimeType || attachment.type,
            data: attachment.data,
            mimeType: attachment.mimeType,
          }))
        : undefined

    const taskStore = useCLITaskStore.getState()
    const allTasksDone = taskStore.tasks.length > 0 && taskStore.tasks.every((t) => t.status === 'completed')

    set((s) => {
      const session = s.sessions[sessionId]
      if (!session) return s

      const newMessages = [...session.messages]
      if (allTasksDone) {
        newMessages.push({
          id: nextId(),
          type: 'task_summary',
          tasks: taskStore.tasks.map((t) => ({
            id: t.id,
            subject: t.subject,
            status: t.status,
            activeForm: t.activeForm,
          })),
          timestamp: Date.now(),
        })
        taskStore.clearTasks()
      }
      newMessages.push({
        id: nextId(),
        type: 'user_text',
        content: userFacingContent,
        attachments: uiAttachments,
        timestamp: Date.now(),
      })

      // Clear old timer
      if (session.elapsedTimer) clearInterval(session.elapsedTimer)

      // Start new elapsed timer
      const timer = setInterval(() => {
        set((st) => {
          const sess = st.sessions[sessionId]
          if (!sess) return st
          return {
            sessions: {
              ...st.sessions,
              [sessionId]: { ...sess, elapsedSeconds: sess.elapsedSeconds + 1 },
            },
          }
        })
      }, 1000)

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...session,
            messages: newMessages,
            chatState: 'thinking',
            elapsedSeconds: 0,
            streamingText: '',
            statusVerb: randomSpinnerVerb(),
            elapsedTimer: timer,
          },
        },
      }
    })

    wsManager.send(sessionId, { type: 'user_message', content, attachments })
  },

  respondToPermission: (sessionId, requestId, allowed, rule?) => {
    wsManager.send(sessionId, { type: 'permission_response', requestId, allowed, ...(rule ? { rule } : {}) })
    set((s) => {
      const session = s.sessions[sessionId]
      if (!session) return s
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, pendingPermission: null, chatState: allowed ? 'tool_executing' : 'idle' },
        },
      }
    })
  },

  setSessionPermissionMode: (sessionId, mode) => {
    if (!get().sessions[sessionId]) return
    wsManager.send(sessionId, { type: 'set_permission_mode', mode })
  },

  stopGeneration: (sessionId) => {
    wsManager.send(sessionId, { type: 'stop_generation' })
    set((s) => {
      const session = s.sessions[sessionId]
      if (!session) return s
      if (session.elapsedTimer) clearInterval(session.elapsedTimer)
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, chatState: 'idle', elapsedTimer: null },
        },
      }
    })
  },

  loadHistory: async (sessionId: string) => {
    try {
      const { messages } = await sessionsApi.getMessages(sessionId)
      const uiMessages = mapHistoryMessagesToUiMessages(messages)

      set((state) => {
        const session = state.sessions[sessionId]
        if (!session || session.messages.length > 0) return state
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: { ...session, messages: uiMessages },
          },
        }
      })

      const lastTodos = extractLastTodoWriteFromHistory(messages)
      if (lastTodos && lastTodos.length > 0) {
        const taskStore = useCLITaskStore.getState()
        if (taskStore.tasks.length === 0) {
          taskStore.setTasksFromTodos(lastTodos)
        }
      }

      if (hasUserMessagesAfterTaskCompletion(messages)) {
        useCLITaskStore.getState().markCompletedAndDismissed()
      }
    } catch {
      // Session may not have messages yet
    }
  },

  clearMessages: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId]
      if (!session) return s
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, messages: [], streamingText: '', chatState: 'idle' },
        },
      }
    })
  },

  handleServerMessage: (sessionId: string, msg: ServerMessage) => {
    const updateSession = (updater: (session: PerSessionState) => Partial<PerSessionState>) => {
      set((s) => {
        const session = s.sessions[sessionId]
        if (!session) return s
        return {
          sessions: {
            ...s.sessions,
            [sessionId]: { ...session, ...updater(session) },
          },
        }
      })
    }

    switch (msg.type) {
      case 'connected':
        break

      case 'status':
        updateSession((session) => ({
          chatState: msg.state,
          ...(msg.verb && msg.verb !== 'Thinking' ? { statusVerb: msg.verb } : {}),
          ...(msg.tokens ? { tokenUsage: { ...session.tokenUsage, output_tokens: msg.tokens } } : {}),
          ...(msg.state === 'idle' ? { activeThinkingId: null, statusVerb: '' } : {}),
        }))
        if (msg.state === 'idle') {
          const session = get().sessions[sessionId]
          if (session?.elapsedTimer) {
            clearInterval(session.elapsedTimer)
            updateSession(() => ({ elapsedTimer: null }))
          }
        }
        break

      case 'content_start': {
        const session = get().sessions[sessionId]
        if (!session) break

        const pendingText = session.streamingText.trim()
        if (pendingText) {
          updateSession((s) => ({
            messages: [...s.messages, {
              id: nextId(),
              type: 'assistant_text' as const,
              content: pendingText,
              timestamp: Date.now(),
            }],
            streamingText: '',
          }))
        }

        if (msg.blockType === 'text') {
          updateSession(() => ({ streamingText: '', chatState: 'streaming', activeThinkingId: null }))
        } else if (msg.blockType === 'tool_use') {
          updateSession(() => ({
            activeToolUseId: msg.toolUseId ?? null,
            activeToolName: msg.toolName ?? null,
            streamingToolInput: '',
            chatState: 'tool_executing',
            activeThinkingId: null,
          }))
        }
        break
      }

      case 'content_delta':
        if (msg.text !== undefined) {
          updateSession((s) => ({ streamingText: s.streamingText + msg.text }))
        }
        if (msg.toolInput !== undefined) {
          updateSession((s) => ({ streamingToolInput: s.streamingToolInput + msg.toolInput }))
        }
        break

      case 'thinking':
        updateSession((s) => {
          const pendingText = s.streamingText.trim()
          const base = pendingText
            ? [...s.messages, { id: nextId(), type: 'assistant_text' as const, content: pendingText, timestamp: Date.now() }]
            : s.messages

          const last = base[base.length - 1]
          if (last && last.type === 'thinking') {
            const updated = [...base]
            updated[updated.length - 1] = { ...last, content: last.content + msg.text }
            return { messages: updated, chatState: 'thinking', activeThinkingId: last.id, streamingText: '' }
          }
          const id = nextId()
          return {
            messages: [...base, { id, type: 'thinking', content: msg.text, timestamp: Date.now() }],
            chatState: 'thinking',
            activeThinkingId: id,
            streamingText: '',
          }
        })
        break

      case 'tool_use_complete': {
        const session = get().sessions[sessionId]
        const toolName = msg.toolName || session?.activeToolName || 'unknown'
        updateSession((s) => ({
          messages: [...s.messages, {
            id: nextId(),
            type: 'tool_use',
            toolName,
            toolUseId: msg.toolUseId || s.activeToolUseId || '',
            input: msg.input,
            timestamp: Date.now(),
            parentToolUseId: msg.parentToolUseId,
          }],
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          streamingToolInput: '',
        }))
        if (toolName === 'TodoWrite' && Array.isArray((msg.input as any)?.todos)) {
          useCLITaskStore.getState().setTasksFromTodos((msg.input as any).todos)
        } else if (TASK_TOOL_NAMES.has(toolName)) {
          const useId = msg.toolUseId || session?.activeToolUseId
          if (useId) pendingTaskToolUseIds.add(useId)
        }
        break
      }

      case 'tool_result':
        updateSession((s) => ({
          messages: [...s.messages, {
            id: nextId(),
            type: 'tool_result',
            toolUseId: msg.toolUseId,
            content: msg.content,
            isError: msg.isError,
            timestamp: Date.now(),
            parentToolUseId: msg.parentToolUseId,
          }],
          chatState: 'thinking',
          activeThinkingId: null,
        }))
        if (pendingTaskToolUseIds.has(msg.toolUseId)) {
          pendingTaskToolUseIds.delete(msg.toolUseId)
          useCLITaskStore.getState().refreshTasks()
        }
        break

      case 'permission_request':
        updateSession((s) => ({
          pendingPermission: {
            requestId: msg.requestId,
            toolName: msg.toolName,
            input: msg.input,
            description: msg.description,
          },
          chatState: 'permission_pending',
          activeThinkingId: null,
          messages: [...s.messages, {
            id: nextId(),
            type: 'permission_request',
            requestId: msg.requestId,
            toolName: msg.toolName,
            input: msg.input,
            description: msg.description,
            timestamp: Date.now(),
          }],
        }))
        break

      case 'message_complete': {
        const session = get().sessions[sessionId]
        if (!session) break
        const text = session.streamingText
        if (text) {
          updateSession((s) => ({
            messages: [...s.messages, { id: nextId(), type: 'assistant_text', content: text, timestamp: Date.now() }],
            streamingText: '',
          }))
        }
        if (session.elapsedTimer) {
          clearInterval(session.elapsedTimer)
        }
        updateSession(() => ({ tokenUsage: msg.usage, chatState: 'idle', activeThinkingId: null, elapsedTimer: null }))
        break
      }

      case 'error':
        updateSession((s) => ({
          messages: [...s.messages, { id: nextId(), type: 'error', message: msg.message, code: msg.code, timestamp: Date.now() }],
          chatState: 'idle',
          activeThinkingId: null,
        }))
        {
          const session = get().sessions[sessionId]
          if (session?.elapsedTimer) {
            clearInterval(session.elapsedTimer)
            updateSession(() => ({ elapsedTimer: null }))
          }
        }
        break

      case 'team_created':
        useTeamStore.getState().handleTeamCreated(msg.teamName)
        break
      case 'team_update':
        useTeamStore.getState().handleTeamUpdate(msg.teamName, msg.members)
        break
      case 'team_deleted':
        useTeamStore.getState().handleTeamDeleted(msg.teamName)
        break
      case 'task_update':
        break
      case 'session_title_updated':
        useSessionStore.getState().updateSessionTitle(msg.sessionId, msg.title)
        break
      case 'system_notification':
        if (msg.subtype === 'slash_commands' && Array.isArray(msg.data)) {
          updateSession(() => ({ slashCommands: msg.data as Array<{ name: string; description: string }> }))
        }
        break
      case 'pong':
        break
    }
  },
}))

// ─── History mapping helpers (unchanged) ─────────────────────

type AssistantHistoryBlock = {
  type: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  input?: unknown
}

type UserHistoryBlock = {
  type: string
  text?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  source?: { data?: string }
  mimeType?: string
  media_type?: string
  name?: string
}

export function mapHistoryMessagesToUiMessages(messages: MessageEntry[]): UIMessage[] {
  const uiMessages: UIMessage[] = []
  for (const msg of messages) {
    const timestamp = new Date(msg.timestamp).getTime()
    if (msg.type === 'user' && typeof msg.content === 'string') {
      uiMessages.push({ id: msg.id || nextId(), type: 'user_text', content: msg.content, timestamp })
      continue
    }
    if (msg.type === 'assistant' && typeof msg.content === 'string') {
      uiMessages.push({ id: msg.id || nextId(), type: 'assistant_text', content: msg.content, timestamp, model: msg.model })
      continue
    }
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      for (const block of msg.content as AssistantHistoryBlock[]) {
        if (block.type === 'thinking' && block.thinking) {
          uiMessages.push({ id: nextId(), type: 'thinking', content: block.thinking, timestamp })
        } else if (block.type === 'text' && block.text) {
          uiMessages.push({ id: nextId(), type: 'assistant_text', content: block.text, timestamp, model: msg.model })
        } else if (block.type === 'tool_use') {
          uiMessages.push({
            id: nextId(), type: 'tool_use', toolName: block.name ?? 'unknown',
            toolUseId: block.id ?? '', input: block.input, timestamp, parentToolUseId: msg.parentToolUseId,
          })
        }
      }
      continue
    }
    if ((msg.type === 'user' || msg.type === 'tool_result') && Array.isArray(msg.content)) {
      const textParts: string[] = []
      const attachments: UIAttachment[] = []
      for (const block of msg.content as UserHistoryBlock[]) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text)
        } else if (block.type === 'image') {
          attachments.push({ type: 'image', name: block.name || 'image', data: block.source?.data, mimeType: block.mimeType || block.media_type })
        } else if (block.type === 'file') {
          attachments.push({ type: 'file', name: block.name || 'file' })
        } else if (block.type === 'tool_result') {
          uiMessages.push({
            id: nextId(), type: 'tool_result', toolUseId: block.tool_use_id ?? '',
            content: block.content, isError: !!block.is_error, timestamp, parentToolUseId: msg.parentToolUseId,
          })
        }
      }
      if (textParts.length > 0 || attachments.length > 0) {
        uiMessages.push({
          id: nextId(), type: 'user_text', content: textParts.join('\n'),
          attachments: attachments.length > 0 ? attachments : undefined, timestamp,
        })
      }
    }
  }
  return uiMessages
}

function extractLastTodoWriteFromHistory(
  messages: MessageEntry[],
): Array<{ content: string; status: string; activeForm?: string }> | null {
  let foundIndex = -1
  let todos: Array<{ content: string; status: string; activeForm?: string }> | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      const blocks = msg.content as AssistantHistoryBlock[]
      for (let j = blocks.length - 1; j >= 0; j--) {
        const block = blocks[j]!
        if (block.type === 'tool_use' && block.name === 'TodoWrite') {
          const input = block.input as { todos?: unknown } | undefined
          if (input && Array.isArray(input.todos)) {
            todos = input.todos as Array<{ content: string; status: string; activeForm?: string }>
            foundIndex = i
            break
          }
        }
      }
      if (todos) break
    }
  }
  if (!todos) return null
  const allDone = todos.every((t) => t.status === 'completed')
  if (allDone) {
    for (let i = foundIndex + 1; i < messages.length; i++) {
      const msg = messages[i]!
      if (msg.type === 'user' && msg.content) return null
    }
  }
  return todos
}

const TASK_RELATED_TOOL_NAMES = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])

function hasUserMessagesAfterTaskCompletion(messages: MessageEntry[]): boolean {
  let lastTaskIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      const blocks = msg.content as AssistantHistoryBlock[]
      if (blocks.some((b) => b.type === 'tool_use' && TASK_RELATED_TOOL_NAMES.has(b.name ?? ''))) {
        lastTaskIndex = i
        break
      }
    }
  }
  if (lastTaskIndex < 0) return false
  for (let i = lastTaskIndex + 1; i < messages.length; i++) {
    if (messages[i]!.type === 'user') return true
  }
  return false
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/stores/chatStore.ts
git commit -m "refactor: chatStore supports per-session isolated state"
```

---

### Task 3: Tab Store

**Files:**
- Create: `desktop/src/stores/tabStore.ts`

- [ ] **Step 1: 创建 tabStore**

```ts
import { create } from 'zustand'
import { sessionsApi } from '../api/sessions'

const TAB_STORAGE_KEY = 'cc-haha-open-tabs'

export type Tab = {
  sessionId: string
  title: string
  status: 'idle' | 'running' | 'error'
}

type TabPersistence = {
  openTabs: Array<{ sessionId: string; title: string }>
  activeTabId: string | null
}

type TabStore = {
  tabs: Tab[]
  activeTabId: string | null

  openTab: (sessionId: string, title: string) => void
  closeTab: (sessionId: string) => void
  setActiveTab: (sessionId: string) => void
  updateTabTitle: (sessionId: string, title: string) => void
  updateTabStatus: (sessionId: string, status: Tab['status']) => void

  saveTabs: () => void
  restoreTabs: () => Promise<void>
}

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab: (sessionId, title) => {
    const { tabs } = get()
    const existing = tabs.find((t) => t.sessionId === sessionId)
    if (existing) {
      set({ activeTabId: sessionId })
    } else {
      set({
        tabs: [...tabs, { sessionId, title, status: 'idle' }],
        activeTabId: sessionId,
      })
    }
    get().saveTabs()
  },

  closeTab: (sessionId) => {
    const { tabs, activeTabId } = get()
    const index = tabs.findIndex((t) => t.sessionId === sessionId)
    if (index < 0) return

    const newTabs = tabs.filter((t) => t.sessionId !== sessionId)
    let newActiveId = activeTabId

    // If closing the active tab, activate the nearest neighbor
    if (activeTabId === sessionId) {
      if (newTabs.length === 0) {
        newActiveId = null
      } else if (index >= newTabs.length) {
        newActiveId = newTabs[newTabs.length - 1]!.sessionId
      } else {
        newActiveId = newTabs[index]!.sessionId
      }
    }

    set({ tabs: newTabs, activeTabId: newActiveId })
    get().saveTabs()
  },

  setActiveTab: (sessionId) => {
    set({ activeTabId: sessionId })
    get().saveTabs()
  },

  updateTabTitle: (sessionId, title) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.sessionId === sessionId ? { ...t, title } : t)),
    }))
    get().saveTabs()
  },

  updateTabStatus: (sessionId, status) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.sessionId === sessionId ? { ...t, status } : t)),
    }))
  },

  saveTabs: () => {
    const { tabs, activeTabId } = get()
    const data: TabPersistence = {
      openTabs: tabs.map((t) => ({ sessionId: t.sessionId, title: t.title })),
      activeTabId,
    }
    try {
      localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(data))
    } catch { /* noop */ }
  },

  restoreTabs: async () => {
    try {
      const raw = localStorage.getItem(TAB_STORAGE_KEY)
      if (!raw) return

      const data = JSON.parse(raw) as TabPersistence
      if (!data.openTabs || data.openTabs.length === 0) return

      // Validate sessions still exist
      const { sessions } = await sessionsApi.list({ limit: 200 })
      const existingIds = new Set(sessions.map((s) => s.id))

      const validTabs: Tab[] = data.openTabs
        .filter((t) => existingIds.has(t.sessionId))
        .map((t) => ({
          sessionId: t.sessionId,
          title: sessions.find((s) => s.id === t.sessionId)?.title || t.title,
          status: 'idle' as const,
        }))

      if (validTabs.length === 0) return

      const activeId = data.activeTabId && validTabs.some((t) => t.sessionId === data.activeTabId)
        ? data.activeTabId
        : validTabs[0]!.sessionId

      set({ tabs: validTabs, activeTabId: activeId })
    } catch { /* noop */ }
  },
}))
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/stores/tabStore.ts
git commit -m "feat: add tabStore for multi-tab state management"
```

---

### Task 4: TabBar 组件

**Files:**
- Create: `desktop/src/components/layout/TabBar.tsx`

- [ ] **Step 1: 创建 TabBar 组件**

固定宽度 Tab + 滚动箭头 + 关闭按钮 + 状态指示 + 右键上下文菜单。

```tsx
import { useRef, useState, useEffect, useCallback } from 'react'
import { useTabStore, type Tab } from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useTranslation } from '../../i18n'

const TAB_WIDTH = 180
const ARROW_WIDTH = 28

export function TabBar() {
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const setActiveTab = useTabStore((s) => s.setActiveTab)
  const closeTab = useTabStore((s) => s.closeTab)
  const disconnectSession = useChatStore((s) => s.disconnectSession)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const t = useTranslation()

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateScrollState()
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', updateScrollState)
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateScrollState)
      ro.disconnect()
    }
  }, [updateScrollState, tabs.length])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [contextMenu])

  const scroll = (direction: 'left' | 'right') => {
    const el = scrollRef.current
    if (!el) return
    el.scrollBy({ left: direction === 'left' ? -TAB_WIDTH : TAB_WIDTH, behavior: 'smooth' })
  }

  const handleClose = (sessionId: string) => {
    disconnectSession(sessionId)
    closeTab(sessionId)
  }

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    setContextMenu({ sessionId, x: e.clientX, y: e.clientY })
  }

  const handleCloseOthers = (sessionId: string) => {
    setContextMenu(null)
    const otherIds = tabs.filter((t) => t.sessionId !== sessionId).map((t) => t.sessionId)
    for (const id of otherIds) handleClose(id)
  }

  const handleCloseRight = (sessionId: string) => {
    setContextMenu(null)
    const idx = tabs.findIndex((t) => t.sessionId === sessionId)
    const rightIds = tabs.slice(idx + 1).map((t) => t.sessionId)
    for (const id of rightIds) handleClose(id)
  }

  if (tabs.length === 0) return null

  return (
    <div className="flex items-center border-b border-[var(--color-border)] bg-[var(--color-surface)] min-h-[36px] select-none">
      {/* Left arrow */}
      {canScrollLeft && (
        <button onClick={() => scroll('left')} className="flex-shrink-0 w-7 h-full flex items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
          <span className="material-symbols-outlined text-[16px]">chevron_left</span>
        </button>
      )}

      {/* Tabs scroll container */}
      <div ref={scrollRef} className="flex-1 flex overflow-x-hidden">
        {tabs.map((tab) => (
          <TabItem
            key={tab.sessionId}
            tab={tab}
            isActive={tab.sessionId === activeTabId}
            onClick={() => setActiveTab(tab.sessionId)}
            onClose={() => handleClose(tab.sessionId)}
            onContextMenu={(e) => handleContextMenu(e, tab.sessionId)}
          />
        ))}
      </div>

      {/* Right arrow */}
      {canScrollRight && (
        <button onClick={() => scroll('right')} className="flex-shrink-0 w-7 h-full flex items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
          <span className="material-symbols-outlined text-[16px]">chevron_right</span>
        </button>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-md)] py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y, boxShadow: 'var(--shadow-dropdown)' }}
        >
          <button
            onClick={() => { handleClose(contextMenu.sessionId); setContextMenu(null) }}
            className="w-full px-3 py-1.5 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.close')}
          </button>
          <button
            onClick={() => handleCloseOthers(contextMenu.sessionId)}
            className="w-full px-3 py-1.5 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeOthers')}
          </button>
          <button
            onClick={() => handleCloseRight(contextMenu.sessionId)}
            className="w-full px-3 py-1.5 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeRight')}
          </button>
        </div>
      )}
    </div>
  )
}

function TabItem({ tab, isActive, onClick, onClose, onContextMenu }: {
  tab: Tab
  isActive: boolean
  onClick: () => void
  onClose: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`
        flex-shrink-0 flex items-center gap-1.5 px-3 h-[36px] border-r border-[var(--color-border)] cursor-pointer group transition-colors
        ${isActive
          ? 'bg-[var(--color-surface)] border-b-2 border-b-[var(--color-brand)]'
          : 'bg-[var(--color-surface-container-low)] hover:bg-[var(--color-surface-hover)]'
        }
      `}
      style={{ width: TAB_WIDTH, maxWidth: TAB_WIDTH }}
    >
      {/* Status indicator */}
      {tab.status === 'running' && (
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse flex-shrink-0" />
      )}
      {tab.status === 'error' && (
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-error)] flex-shrink-0" />
      )}

      {/* Title */}
      <span className={`flex-1 truncate text-xs ${isActive ? 'text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-secondary)]'}`}>
        {tab.title || 'Untitled'}
      </span>

      {/* Close button */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose() }}
        className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--color-surface-hover)] transition-opacity text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
      >
        <span className="material-symbols-outlined text-[14px]">close</span>
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/components/layout/TabBar.tsx
git commit -m "feat: add TabBar component with scroll overflow and context menu"
```

---

### Task 5: i18n 翻译 keys

**Files:**
- Modify: `desktop/src/i18n/locales/en.ts`
- Modify: `desktop/src/i18n/locales/zh.ts`

- [ ] **Step 1: 在 en.ts 末尾添加 Tab 相关翻译**

在 `en.ts` 对象末尾（closing `}` 之前）添加：

```ts
  // ─── Tabs ──────────────────────────────────────
  'tabs.close': 'Close',
  'tabs.closeOthers': 'Close Others',
  'tabs.closeRight': 'Close to the Right',
  'tabs.closeConfirmTitle': 'Session Running',
  'tabs.closeConfirmMessage': 'This session is still running. What would you like to do?',
  'tabs.closeConfirmKeep': 'Keep Running',
  'tabs.closeConfirmStop': 'Stop & Close',
```

- [ ] **Step 2: 在 zh.ts 末尾添加对应中文翻译**

```ts
  // ─── Tabs ──────────────────────────────────────
  'tabs.close': '关闭',
  'tabs.closeOthers': '关闭其他',
  'tabs.closeRight': '关闭右侧',
  'tabs.closeConfirmTitle': '会话运行中',
  'tabs.closeConfirmMessage': '此会话仍在运行，你想要怎么做？',
  'tabs.closeConfirmKeep': '保持运行',
  'tabs.closeConfirmStop': '停止并关闭',
```

- [ ] **Step 3: Commit**

```bash
git add desktop/src/i18n/locales/en.ts desktop/src/i18n/locales/zh.ts
git commit -m "feat: add i18n translations for multi-tab feature"
```

---

### Task 6: 布局集成 — AppShell + ContentRouter

**Files:**
- Modify: `desktop/src/components/layout/AppShell.tsx`
- Modify: `desktop/src/components/layout/ContentRouter.tsx`

- [ ] **Step 1: AppShell 集成 TabBar 和 Tab 恢复**

在 `AppShell.tsx` 中 import TabBar，在 bootstrap 后恢复 Tab 状态，并在 `<ContentRouter />` 之前渲染 `<TabBar />`。

修改 import 区域，添加：
```ts
import { TabBar } from './TabBar'
import { useTabStore } from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
```

在 `bootstrap` async 函数中，`setReady(true)` 之前添加 Tab 恢复：
```ts
        await useTabStore.getState().restoreTabs()
        // Connect active tab's WS
        const activeId = useTabStore.getState().activeTabId
        if (activeId) {
          useChatStore.getState().connectToSession(activeId)
        }
```

修改 main 内容区 JSX，将 `<ContentRouter />` 替换为：
```tsx
        <TabBar />
        <ContentRouter />
```

- [ ] **Step 2: ContentRouter 从 tabStore 获取 activeTabId**

修改 `ContentRouter.tsx`：

```tsx
import { useUIStore } from '../../stores/uiStore'
import { useTabStore } from '../../stores/tabStore'
import { useTeamStore } from '../../stores/teamStore'
import { EmptySession } from '../../pages/EmptySession'
import { ActiveSession } from '../../pages/ActiveSession'
import { ScheduledTasks } from '../../pages/ScheduledTasks'
import { Settings } from '../../pages/Settings'
import { AgentTranscript } from '../../pages/AgentTranscript'

export function ContentRouter() {
  const activeView = useUIStore((s) => s.activeView)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const viewingAgentId = useTeamStore((s) => s.viewingAgentId)

  if (activeView === 'settings') {
    return <Settings />
  }

  if (activeView === 'scheduled') {
    return <ScheduledTasks />
  }

  if (activeView === 'terminal') {
    return <TerminalPlaceholder />
  }

  if (activeView === 'history') {
    if (viewingAgentId) {
      return <AgentTranscript />
    }
    return <HistoryPlaceholder />
  }

  // Code view
  if (!activeTabId) {
    return <EmptySession />
  }

  if (viewingAgentId) {
    return <AgentTranscript />
  }

  return <ActiveSession />
}
```

（TerminalPlaceholder 和 HistoryPlaceholder 函数保持不变）

- [ ] **Step 3: Commit**

```bash
git add desktop/src/components/layout/AppShell.tsx desktop/src/components/layout/ContentRouter.tsx
git commit -m "feat: integrate TabBar into AppShell layout and route by activeTabId"
```

---

### Task 7: ActiveSession 适配多 Tab

**Files:**
- Modify: `desktop/src/pages/ActiveSession.tsx`

- [ ] **Step 1: 改为从 tabStore 和 chatStore.sessions 读取**

```tsx
import { useEffect, useMemo } from 'react'
import { useTabStore } from '../stores/tabStore'
import { useSessionStore } from '../stores/sessionStore'
import { useChatStore } from '../stores/chatStore'
import { MessageList } from '../components/chat/MessageList'
import { ChatInput } from '../components/chat/ChatInput'
import { TeamStatusBar } from '../components/teams/TeamStatusBar'
import { SessionTaskBar } from '../components/chat/SessionTaskBar'

export function ActiveSession() {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const sessions = useSessionStore((s) => s.sessions)
  const connectToSession = useChatStore((s) => s.connectToSession)
  const sessionState = useChatStore((s) => activeTabId ? s.sessions[activeTabId] : undefined)

  const session = sessions.find((s) => s.id === activeTabId)
  const chatState = sessionState?.chatState ?? 'idle'
  const tokenUsage = sessionState?.tokenUsage ?? { input_tokens: 0, output_tokens: 0 }

  useEffect(() => {
    if (activeTabId) {
      connectToSession(activeTabId)
    }
  }, [activeTabId, connectToSession])

  const isActive = chatState !== 'idle'
  const totalTokens = tokenUsage.input_tokens + tokenUsage.output_tokens

  const lastUpdated = useMemo(() => {
    if (!session?.modifiedAt) return ''
    const diff = Date.now() - new Date(session.modifiedAt).getTime()
    if (diff < 60000) return 'just now'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
    return `${Math.floor(diff / 86400000)}d ago`
  }, [session?.modifiedAt])

  if (!activeTabId) return null

  return (
    <div className="flex-1 flex flex-col relative overflow-hidden bg-background text-on-surface">
      {/* Session info header */}
      <div className="mx-auto flex w-full max-w-[860px] items-center border-b border-outline-variant/10 px-8 py-3">
        <div className="flex-1">
          <h1 className="text-lg font-bold font-headline text-on-surface leading-tight">
            {session?.title || 'Untitled Session'}
          </h1>
          <div className="flex items-center gap-2 text-[10px] text-outline font-medium mt-1">
            {isActive && (
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse-dot" />
                session active
              </span>
            )}
            {totalTokens > 0 && (
              <>
                <span className="text-[var(--color-outline)]">·</span>
                <span>{totalTokens.toLocaleString()} t</span>
              </>
            )}
            {lastUpdated && (
              <>
                <span className="text-[var(--color-outline)]">·</span>
                <span>last updated {lastUpdated}</span>
              </>
            )}
            {session?.messageCount !== undefined && session.messageCount > 0 && (
              <>
                <span className="text-[var(--color-outline)]">·</span>
                <span>{session.messageCount} messages</span>
              </>
            )}
          </div>
          {session?.workDirExists === false && (
            <div className="mt-2 inline-flex max-w-full items-center gap-2 rounded-lg border border-[var(--color-error)]/20 bg-[var(--color-error)]/8 px-3 py-1.5 text-[11px] text-[var(--color-error)]">
              <span className="material-symbols-outlined text-[14px]">warning</span>
              <span className="truncate">
                Workspace unavailable: {session.workDir || 'directory no longer exists'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Message stream */}
      <MessageList />

      {/* Session task bar — sticky at bottom */}
      <SessionTaskBar />

      {/* Team status bar */}
      <TeamStatusBar />

      {/* Chat input */}
      <ChatInput />
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/pages/ActiveSession.tsx
git commit -m "feat: ActiveSession reads from tabStore and per-session chatStore"
```

---

### Task 8: Sidebar 集成 — 点击打开 Tab

**Files:**
- Modify: `desktop/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: 修改 Sidebar session 点击行为**

在 Sidebar.tsx 中 import tabStore 和 chatStore：
```ts
import { useTabStore } from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
```

修改 session 按钮的 `onClick`，从：
```ts
onClick={() => { setActiveView('code'); setActiveSession(session.id) }}
```
改为：
```ts
onClick={() => {
  setActiveView('code')
  const { openTab } = useTabStore.getState()
  openTab(session.id, session.title)
  useChatStore.getState().connectToSession(session.id)
}}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/components/layout/Sidebar.tsx
git commit -m "feat: sidebar click opens session in tab instead of replacing"
```

---

### Task 9: EmptySession 集成 — 新建 Session 自动开 Tab

**Files:**
- Modify: `desktop/src/pages/EmptySession.tsx`

- [ ] **Step 1: 修改 handleSubmit 创建 Session 后打开 Tab**

在 EmptySession.tsx 中添加 import：
```ts
import { useTabStore } from '../stores/tabStore'
```

在 `handleSubmit` 中，`createSession` 成功后，添加 openTab 调用。修改 `try` 块：
```ts
      const sessionId = await createSession(workDir || undefined)
      setActiveView('code')
      // Open as tab
      useTabStore.getState().openTab(sessionId, 'New Session')
      connectToSession(sessionId)
      const attachmentPayload: AttachmentRef[] = attachments.map((attachment) => ({
        type: attachment.type,
        name: attachment.name,
        data: attachment.data,
        mimeType: attachment.mimeType,
      }))
      sendMessage(text, attachmentPayload)
      setInput('')
      setAttachments([])
```

注意：这里 `sendMessage` 现在需要传 sessionId 作为第一个参数：
```ts
      sendMessage(sessionId, text, attachmentPayload)
```

同时更新 sendMessage 的引用获取：
```ts
const sendMessage = useChatStore((state) => state.sendMessage)
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/pages/EmptySession.tsx
git commit -m "feat: new session creation automatically opens as tab"
```

---

### Task 10: MessageList 和 ChatInput 适配 per-session 数据

**Files:**
- Modify: `desktop/src/components/chat/MessageList.tsx`
- Modify: `desktop/src/components/chat/ChatInput.tsx`

- [ ] **Step 1: 修改 MessageList 从 per-session state 读取**

在 MessageList.tsx 中，找到从 `useChatStore` 读取 `messages`, `chatState`, `streamingText` 等的地方，改为通过 `activeTabId` 从 `sessions[activeTabId]` 读取。

添加 import：
```ts
import { useTabStore } from '../../stores/tabStore'
```

将所有从 chatStore 直接读取的字段改为通过 helper：
```ts
const activeTabId = useTabStore((s) => s.activeTabId)
const sessionState = useChatStore((s) => activeTabId ? s.sessions[activeTabId] : undefined)
const messages = sessionState?.messages ?? []
const chatState = sessionState?.chatState ?? 'idle'
const streamingText = sessionState?.streamingText ?? ''
// ... 等等
```

- [ ] **Step 2: 修改 ChatInput 发送消息时传 sessionId**

在 ChatInput.tsx 中，找到调用 `sendMessage(content, attachments)` 的地方，改为 `sendMessage(activeTabId, content, attachments)`。

同样对 `respondToPermission`, `stopGeneration`, `setSessionPermissionMode` 等调用添加 sessionId 参数。

- [ ] **Step 3: Commit**

```bash
git add desktop/src/components/chat/MessageList.tsx desktop/src/components/chat/ChatInput.tsx
git commit -m "feat: MessageList and ChatInput read from per-session state"
```

---

### Task 11: Tab 状态同步 — session_title_updated + chatState

**Files:**
- Modify: `desktop/src/stores/chatStore.ts`

- [ ] **Step 1: 在 handleServerMessage 中同步 Tab 状态**

在 `session_title_updated` case 中添加：
```ts
      case 'session_title_updated':
        useSessionStore.getState().updateSessionTitle(msg.sessionId, msg.title)
        // Sync to tab title
        import('../stores/tabStore').then(({ useTabStore }) => {
          useTabStore.getState().updateTabTitle(msg.sessionId, msg.title)
        })
        break
```

更简洁的方式：在文件顶部 import tabStore：
```ts
import { useTabStore } from './tabStore'
```

然后在 `status` case 中同步 tab status：
```ts
      case 'status':
        updateSession((session) => ({ ... }))
        // Sync tab status
        if (msg.state === 'idle') {
          useTabStore.getState().updateTabStatus(sessionId, 'idle')
        } else {
          useTabStore.getState().updateTabStatus(sessionId, 'running')
        }
        break
```

在 `error` case 中：
```ts
        useTabStore.getState().updateTabStatus(sessionId, 'error')
```

在 `session_title_updated` case 中：
```ts
        useTabStore.getState().updateTabTitle(msg.sessionId, msg.title)
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/stores/chatStore.ts
git commit -m "feat: sync tab status and title from server messages"
```

---

### Task 12: Tab 关闭确认对话框

**Files:**
- Create: `desktop/src/components/layout/TabCloseDialog.tsx`
- Modify: `desktop/src/components/layout/TabBar.tsx`

- [ ] **Step 1: 创建 TabCloseDialog 组件**

```tsx
import { Modal } from '../shared/Modal'
import { Button } from '../shared/Button'
import { useTranslation } from '../../i18n'

type Props = {
  open: boolean
  onKeepRunning: () => void
  onStopAndClose: () => void
  onCancel: () => void
}

export function TabCloseDialog({ open, onKeepRunning, onStopAndClose, onCancel }: Props) {
  const t = useTranslation()

  return (
    <Modal open={open} onClose={onCancel} title={t('tabs.closeConfirmTitle')} width={400} footer={
      <>
        <Button variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant="secondary" onClick={onKeepRunning}>{t('tabs.closeConfirmKeep')}</Button>
        <Button onClick={onStopAndClose}>{t('tabs.closeConfirmStop')}</Button>
      </>
    }>
      <p className="text-sm text-[var(--color-text-secondary)]">
        {t('tabs.closeConfirmMessage')}
      </p>
    </Modal>
  )
}
```

- [ ] **Step 2: 在 TabBar 中集成关闭确认逻辑**

在 TabBar.tsx 中 import 对话框：
```ts
import { TabCloseDialog } from './TabCloseDialog'
```

添加 state：
```ts
  const [closingTabId, setClosingTabId] = useState<string | null>(null)
```

修改 `handleClose` 函数，检查 session 是否正在运行：
```ts
  const handleClose = (sessionId: string) => {
    const sessionState = useChatStore.getState().sessions[sessionId]
    const isRunning = sessionState && sessionState.chatState !== 'idle'

    if (isRunning) {
      // TODO: check settings for tabCloseWithRunningSession
      setClosingTabId(sessionId)
      return
    }

    disconnectSession(sessionId)
    closeTab(sessionId)
  }
```

在 JSX 末尾（context menu 后面）添加对话框：
```tsx
      {closingTabId && (
        <TabCloseDialog
          open={true}
          onKeepRunning={() => {
            closeTab(closingTabId)
            setClosingTabId(null)
          }}
          onStopAndClose={() => {
            useChatStore.getState().stopGeneration(closingTabId)
            disconnectSession(closingTabId)
            closeTab(closingTabId)
            setClosingTabId(null)
          }}
          onCancel={() => setClosingTabId(null)}
        />
      )}
```

- [ ] **Step 3: Commit**

```bash
git add desktop/src/components/layout/TabCloseDialog.tsx desktop/src/components/layout/TabBar.tsx
git commit -m "feat: add confirmation dialog when closing running session tab"
```

---

### Task 13: 编译验证和集成测试

**Files:**
- All modified files

- [ ] **Step 1: TypeScript 编译检查**

Run: `cd /Users/nanmi/workspace/myself_code/claude-code-haha/desktop && npx tsc --noEmit`
Expected: 零错误。如有错误，逐一修复类型问题。

- [ ] **Step 2: Vite 开发服务器启动测试**

Run: `cd /Users/nanmi/workspace/myself_code/claude-code-haha/desktop && npx vite build 2>&1 | tail -20`
Expected: Build 成功，无错误。

- [ ] **Step 3: 运行现有测试**

Run: `cd /Users/nanmi/workspace/myself_code/claude-code-haha/desktop && npx vitest run 2>&1`
Expected: 测试通过（可能需要更新 mock）。

- [ ] **Step 4: 修复所有发现的问题**

根据编译/构建/测试结果修复问题。

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "fix: resolve compilation and integration issues for multi-tab"
```
