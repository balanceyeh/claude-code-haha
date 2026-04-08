import { create } from 'zustand'
import { wsManager } from '../api/websocket'
import { sessionsApi } from '../api/sessions'
import { useTeamStore } from './teamStore'
import { useSessionStore } from './sessionStore'
import { useCLITaskStore } from './cliTaskStore'
import { useTabStore } from './tabStore'
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

const DEFAULT_SESSION_STATE: PerSessionState = {
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

function createDefaultSessionState(): PerSessionState {
  return { ...DEFAULT_SESSION_STATE, messages: [], tokenUsage: { input_tokens: 0, output_tokens: 0 } }
}

type ChatStore = {
  sessions: Record<string, PerSessionState>

  getSession: (sessionId: string) => PerSessionState
  connectToSession: (sessionId: string) => void
  disconnectSession: (sessionId: string) => void
  sendMessage: (sessionId: string, content: string, attachments?: AttachmentRef[]) => void
  respondToPermission: (sessionId: string, requestId: string, allowed: boolean, rule?: string) => void
  setSessionPermissionMode: (sessionId: string, mode: PermissionMode) => void
  stopGeneration: (sessionId: string) => void
  loadHistory: (sessionId: string) => Promise<void>
  clearMessages: (sessionId: string) => void
  handleServerMessage: (sessionId: string, msg: ServerMessage) => void
}

const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite'])
const pendingTaskToolUseIds = new Set<string>()

let msgCounter = 0
const nextId = () => `msg-${++msgCounter}-${Date.now()}`

/** Helper: immutably update a specific session within the sessions record */
function updateSessionIn(
  sessions: Record<string, PerSessionState>,
  sessionId: string,
  updater: (s: PerSessionState) => Partial<PerSessionState>,
): Record<string, PerSessionState> {
  const session = sessions[sessionId]
  if (!session) return sessions
  return { ...sessions, [sessionId]: { ...session, ...updater(session) } }
}

export const useChatStore = create<ChatStore>((set, get) => ({
  sessions: {},

  getSession: (sessionId) => get().sessions[sessionId] ?? createDefaultSessionState(),

  connectToSession: (sessionId) => {
    const existing = get().sessions[sessionId]
    if (existing && existing.connectionState !== 'disconnected') return

    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...createDefaultSessionState(),
          connectionState: 'connecting',
          messages: existing?.messages ?? [],
        },
      },
    }))

    wsManager.clearHandlers(sessionId)
    wsManager.connect(sessionId)
    wsManager.onMessage(sessionId, (msg) => {
      if (msg.type === 'connected') {
        set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({ connectionState: 'connected' })) }))
      }
      get().handleServerMessage(sessionId, msg)
    })

    get().loadHistory(sessionId)
    useCLITaskStore.getState().fetchSessionTasks(sessionId)
    sessionsApi.getSlashCommands(sessionId)
      .then(({ commands }) => {
        if (get().sessions[sessionId]) {
          set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({ slashCommands: commands })) }))
        }
      })
      .catch(() => {
        if (get().sessions[sessionId]) {
          set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({ slashCommands: [] })) }))
        }
      })
  },

  disconnectSession: (sessionId) => {
    const session = get().sessions[sessionId]
    if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
    wsManager.disconnect(sessionId)
    set((s) => {
      const { [sessionId]: _, ...rest } = s.sessions
      return { sessions: rest }
    })
  },

  sendMessage: (sessionId, content, attachments?) => {
    const userFacingContent = content.trim()
    const uiAttachments: UIAttachment[] | undefined =
      attachments && attachments.length > 0
        ? attachments.map((a) => ({
            type: a.type,
            name: a.name || a.path || a.mimeType || a.type,
            data: a.data,
            mimeType: a.mimeType,
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
          tasks: taskStore.tasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status, activeForm: t.activeForm })),
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

      if (session.elapsedTimer) clearInterval(session.elapsedTimer)

      const timer = setInterval(() => {
        set((st) => ({ sessions: updateSessionIn(st.sessions, sessionId, (sess) => ({ elapsedSeconds: sess.elapsedSeconds + 1 })) }))
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
    set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({ pendingPermission: null, chatState: allowed ? 'tool_executing' : 'idle' })) }))
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
      return { sessions: { ...s.sessions, [sessionId]: { ...session, chatState: 'idle', elapsedTimer: null } } }
    })
  },

  loadHistory: async (sessionId) => {
    try {
      const { messages } = await sessionsApi.getMessages(sessionId)
      const uiMessages = mapHistoryMessagesToUiMessages(messages)
      set((state) => {
        const session = state.sessions[sessionId]
        if (!session || session.messages.length > 0) return state
        return { sessions: updateSessionIn(state.sessions, sessionId, () => ({ messages: uiMessages })) }
      })
      const lastTodos = extractLastTodoWriteFromHistory(messages)
      if (lastTodos && lastTodos.length > 0) {
        const taskStore = useCLITaskStore.getState()
        if (taskStore.tasks.length === 0) taskStore.setTasksFromTodos(lastTodos)
      }
      if (hasUserMessagesAfterTaskCompletion(messages)) {
        useCLITaskStore.getState().markCompletedAndDismissed()
      }
    } catch {
      // Session may not have messages yet
    }
  },

  clearMessages: (sessionId) => {
    set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({ messages: [], streamingText: '', chatState: 'idle' })) }))
  },

  handleServerMessage: (sessionId, msg) => {
    const update = (updater: (session: PerSessionState) => Partial<PerSessionState>) => {
      set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, updater) }))
    }

    switch (msg.type) {
      case 'connected':
        break

      case 'status':
        update((session) => ({
          chatState: msg.state,
          ...(msg.verb && msg.verb !== 'Thinking' ? { statusVerb: msg.verb } : {}),
          ...(msg.tokens ? { tokenUsage: { ...session.tokenUsage, output_tokens: msg.tokens } } : {}),
          ...(msg.state === 'idle' ? { activeThinkingId: null, statusVerb: '' } : {}),
        }))
        if (msg.state === 'idle') {
          const session = get().sessions[sessionId]
          if (session?.elapsedTimer) {
            clearInterval(session.elapsedTimer)
            update(() => ({ elapsedTimer: null }))
          }
        }
        // Sync tab status
        useTabStore.getState().updateTabStatus(sessionId, msg.state === 'idle' ? 'idle' : 'running')
        break

      case 'content_start': {
        const session = get().sessions[sessionId]
        if (!session) break
        const pendingText = session.streamingText.trim()
        if (pendingText) {
          update((s) => ({
            messages: [...s.messages, { id: nextId(), type: 'assistant_text' as const, content: pendingText, timestamp: Date.now() }],
            streamingText: '',
          }))
        }
        if (msg.blockType === 'text') {
          update(() => ({ streamingText: '', chatState: 'streaming', activeThinkingId: null }))
        } else if (msg.blockType === 'tool_use') {
          update(() => ({
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
        if (msg.text !== undefined) update((s) => ({ streamingText: s.streamingText + msg.text }))
        if (msg.toolInput !== undefined) update((s) => ({ streamingToolInput: s.streamingToolInput + msg.toolInput }))
        break

      case 'thinking':
        update((s) => {
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
        update((s) => ({
          messages: [...s.messages, {
            id: nextId(), type: 'tool_use', toolName,
            toolUseId: msg.toolUseId || s.activeToolUseId || '',
            input: msg.input, timestamp: Date.now(), parentToolUseId: msg.parentToolUseId,
          }],
          activeToolUseId: null, activeToolName: null, activeThinkingId: null, streamingToolInput: '',
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
        update((s) => ({
          messages: [...s.messages, {
            id: nextId(), type: 'tool_result', toolUseId: msg.toolUseId,
            content: msg.content, isError: msg.isError, timestamp: Date.now(), parentToolUseId: msg.parentToolUseId,
          }],
          chatState: 'thinking', activeThinkingId: null,
        }))
        if (pendingTaskToolUseIds.has(msg.toolUseId)) {
          pendingTaskToolUseIds.delete(msg.toolUseId)
          useCLITaskStore.getState().refreshTasks()
        }
        break

      case 'permission_request':
        update((s) => ({
          pendingPermission: { requestId: msg.requestId, toolName: msg.toolName, input: msg.input, description: msg.description },
          chatState: 'permission_pending',
          activeThinkingId: null,
          messages: [...s.messages, {
            id: nextId(), type: 'permission_request', requestId: msg.requestId,
            toolName: msg.toolName, input: msg.input, description: msg.description, timestamp: Date.now(),
          }],
        }))
        break

      case 'message_complete': {
        const session = get().sessions[sessionId]
        if (!session) break
        const text = session.streamingText
        if (text) {
          update((s) => ({
            messages: [...s.messages, { id: nextId(), type: 'assistant_text', content: text, timestamp: Date.now() }],
            streamingText: '',
          }))
        }
        if (session.elapsedTimer) clearInterval(session.elapsedTimer)
        update(() => ({ tokenUsage: msg.usage, chatState: 'idle', activeThinkingId: null, elapsedTimer: null }))
        break
      }

      case 'error':
        update((s) => ({
          messages: [...s.messages, { id: nextId(), type: 'error', message: msg.message, code: msg.code, timestamp: Date.now() }],
          chatState: 'idle', activeThinkingId: null,
        }))
        useTabStore.getState().updateTabStatus(sessionId, 'error')
        {
          const session = get().sessions[sessionId]
          if (session?.elapsedTimer) {
            clearInterval(session.elapsedTimer)
            update(() => ({ elapsedTimer: null }))
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
        useTabStore.getState().updateTabTitle(msg.sessionId, msg.title)
        break
      case 'system_notification':
        if (msg.subtype === 'slash_commands' && Array.isArray(msg.data)) {
          update(() => ({ slashCommands: msg.data as Array<{ name: string; description: string }> }))
        }
        break
      case 'pong':
        break
    }
  },
}))

// ─── History mapping helpers (unchanged from original) ─────────

type AssistantHistoryBlock = { type: string; text?: string; thinking?: string; name?: string; id?: string; input?: unknown }
type UserHistoryBlock = { type: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean; source?: { data?: string }; mimeType?: string; media_type?: string; name?: string }

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
        if (block.type === 'thinking' && block.thinking) uiMessages.push({ id: nextId(), type: 'thinking', content: block.thinking, timestamp })
        else if (block.type === 'text' && block.text) uiMessages.push({ id: nextId(), type: 'assistant_text', content: block.text, timestamp, model: msg.model })
        else if (block.type === 'tool_use') uiMessages.push({ id: nextId(), type: 'tool_use', toolName: block.name ?? 'unknown', toolUseId: block.id ?? '', input: block.input, timestamp, parentToolUseId: msg.parentToolUseId })
      }
      continue
    }
    if ((msg.type === 'user' || msg.type === 'tool_result') && Array.isArray(msg.content)) {
      const textParts: string[] = []
      const attachments: UIAttachment[] = []
      for (const block of msg.content as UserHistoryBlock[]) {
        if (block.type === 'text' && block.text) textParts.push(block.text)
        else if (block.type === 'image') attachments.push({ type: 'image', name: block.name || 'image', data: block.source?.data, mimeType: block.mimeType || block.media_type })
        else if (block.type === 'file') attachments.push({ type: 'file', name: block.name || 'file' })
        else if (block.type === 'tool_result') uiMessages.push({ id: nextId(), type: 'tool_result', toolUseId: block.tool_use_id ?? '', content: block.content, isError: !!block.is_error, timestamp, parentToolUseId: msg.parentToolUseId })
      }
      if (textParts.length > 0 || attachments.length > 0) {
        uiMessages.push({ id: nextId(), type: 'user_text', content: textParts.join('\n'), attachments: attachments.length > 0 ? attachments : undefined, timestamp })
      }
    }
  }
  return uiMessages
}

function extractLastTodoWriteFromHistory(messages: MessageEntry[]): Array<{ content: string; status: string; activeForm?: string }> | null {
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
      if (messages[i]!.type === 'user' && messages[i]!.content) return null
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
      if (blocks.some((b) => b.type === 'tool_use' && TASK_RELATED_TOOL_NAMES.has(b.name ?? ''))) { lastTaskIndex = i; break }
    }
  }
  if (lastTaskIndex < 0) return false
  for (let i = lastTaskIndex + 1; i < messages.length; i++) { if (messages[i]!.type === 'user') return true }
  return false
}
