# Multi-Tab Sessions Design Spec

## Overview

Desktop webapp (Tauri + React + Zustand) 新增多 Tab 功能，允许用户同时打开多个 Session 并行工作。类似 VS Code 的编辑器 Tab 与文件浏览器的关系：Sidebar 浏览所有 Session，Tab 栏管理当前打开的 Session。

## Tech Stack

- **Desktop App**: Tauri v2 + React 18 + Zustand 5 + Tailwind CSS 4 + Vite
- **Backend Server**: `src/server/` — 已支持多 Session 并发 (`maxSessions` 配置)
- **通信协议**: 每个 Session 独立 WebSocket (`/ws/${sessionId}`) + REST API

## Key Design Decisions

| 决策 | 选择 | 理由 |
|------|------|------|
| Tab 与 Sidebar 关系 | 独立共存 (VS Code 模式) | Sidebar 浏览全部历史, Tab 管理当前打开的 |
| Tab 栏位置 | 内容区域顶部 (Sidebar 右侧上方) | 不影响 Sidebar 布局 |
| 并发策略 | 每个 Tab 独立 WebSocket 连接 | 真正并行, 后端已支持, WS 连接轻量 |
| Tab 数量限制 | 不限制 | 用户自由管理 |
| Tab 溢出处理 | 固定宽度 + 左右滚动箭头 | VS Code 风格 |
| 关闭运行中 Tab | 可配置 (默认弹确认框) | 配置项: ask / background / stop |
| Tab 持久化 | 可配置 (默认恢复) | 存 localStorage, 启动时恢复 |
| Sidebar 打开行为 | 去重 + 聚焦 | 已打开则跳转, 否则新 Tab |
| 新建 Session 入口 | 仅 Sidebar | 保持单一入口 |

## Architecture Changes

### 1. New Tab Store (`tabStore.ts`)

新增 Zustand store 管理 Tab 状态:

```ts
interface Tab {
  sessionId: string
  title: string
  status: 'idle' | 'running' | 'error'
}

interface TabStore {
  tabs: Tab[]
  activeTabId: string | null // sessionId

  openTab(sessionId: string, title: string): void
  closeTab(sessionId: string): void
  setActiveTab(sessionId: string): void
  updateTabTitle(sessionId: string, title: string): void
  updateTabStatus(sessionId: string, status: Tab['status']): void
  reorderTabs(fromIndex: number, toIndex: number): void

  // Persistence
  saveTabs(): void
  restoreTabs(): Tab[]
}
```

### 2. chatStore Refactor

从单 Session 改为多 Session 并发:

**Before**: 单一 `messages[]` + 单一 `connectedSessionId`
**After**: 按 sessionId 隔离的 session map

```ts
interface PerSessionState {
  messages: UIMessage[]
  connectionState: 'connecting' | 'connected' | 'disconnected'
  streamingState: StreamingState
  permissionRequests: PermissionRequest[]
  tasks: TaskState[]
}

interface ChatStore {
  sessions: Record<string, PerSessionState>
  connectToSession(sessionId: string): void
  disconnectSession(sessionId: string): void
  sendMessage(sessionId: string, content: string, attachments?: AttachmentRef[]): void
  // ... per-session methods all accept sessionId
}
```

### 3. WebSocket Manager Refactor

从单例连接改为多连接管理:

**Before**: 全局一个 WS 连接
**After**: 按 sessionId 管理多个独立 WS 连接

```ts
class WebSocketManager {
  connections: Map<string, WebSocketConnection>
  connect(sessionId: string): void
  disconnect(sessionId: string): void
  disconnectAll(): void
  getConnection(sessionId: string): WebSocketConnection | undefined
  send(sessionId: string, message: ClientMessage): void
}
```

### 4. UI Components

#### 4.1 TabBar Component (New)

位置: 内容区域顶部, Sidebar 右侧上方。

- 固定 Tab 宽度, 显示 Session 标题 (截断) + 状态指示 + 关闭按钮
- 超出容器宽度时显示左右滚动箭头
- 当前活跃 Tab 高亮
- Tab 运行中显示状态指示 (spinner/dot)
- 右键上下文菜单: 关闭、关闭其他、关闭右侧

#### 4.2 Layout Changes (AppShell / ContentRouter)

```
Before:
┌────────────────────────────────────────┐
│  Tauri Drag Region                     │
├──────────┬─────────────────────────────┤
│ Sidebar  │  ContentRouter              │
│          │  (single active session)    │
└──────────┴─────────────────────────────┘

After:
┌────────────────────────────────────────┐
│  Tauri Drag Region                     │
├──────────┬─────────────────────────────┤
│ Sidebar  │  TabBar                     │
│          ├─────────────────────────────┤
│          │  ContentRouter              │
│          │  (active tab's session)     │
└──────────┴─────────────────────────────┘
```

#### 4.3 ActiveSession Changes

当前 ActiveSession 组件从 `sessionStore.activeSessionId` 获取 session。
改为从 `tabStore.activeTabId` 获取, 并从 `chatStore.sessions[activeTabId]` 读取消息。

### 5. Settings Additions

新增两个配置项到 Settings 页面:

- **关闭运行中 Tab 的行为**: `ask` | `background` | `stop` (默认 `ask`)
- **启动时恢复 Tab**: `boolean` (默认 `true`)

### 6. Sidebar Integration

修改 Sidebar 点击行为:
- 点击 Session → 检查 tabStore 是否已打开该 Session
  - 已打开: `setActiveTab(sessionId)` 聚焦
  - 未打开: `openTab(sessionId, title)` 创建新 Tab + 连接 WS
- 新建 Session → 创建后自动 `openTab`

### 7. Tab Close Flow

```
User clicks X on tab
  → Is session running?
    → No: close tab, disconnect WS, cleanup chatStore session state
    → Yes: check setting `tabCloseWithRunningSession`
      → 'ask': show confirm dialog (3 options: keep running / stop / cancel)
      → 'background': close tab, keep WS + session running
      → 'stop': send stop_generation, close tab, disconnect WS
```

### 8. Tab Persistence

存储到 `localStorage`:
```ts
{
  openTabs: Array<{ sessionId: string; title: string }>
  activeTabId: string | null
}
```

启动时:
1. 读取 localStorage
2. 检查 `restoreTabsOnStartup` 配置
3. 校验每个 sessionId 是否仍存在 (API check)
4. 恢复有效 Tab, 连接活跃 Tab 的 WS

## Backend Impact

**无需后端改动**。后端已支持:
- 多 Session 并发 (`maxSessions` 配置)
- 独立 WebSocket 端点 (`/ws/${sessionId}`)
- Session CRUD REST API
- 独立的消息历史存储

前端并行打开多个 WS 连接即可。

## Files to Modify

### New Files
- `desktop/src/stores/tabStore.ts`
- `desktop/src/components/layout/TabBar.tsx`
- `desktop/src/components/layout/TabCloseDialog.tsx`

### Modified Files
- `desktop/src/stores/chatStore.ts` — 多 session 状态隔离
- `desktop/src/api/websocket.ts` — 多连接管理
- `desktop/src/components/layout/AppShell.tsx` — 集成 TabBar
- `desktop/src/components/layout/ContentRouter.tsx` — 从 tabStore 获取 activeTabId
- `desktop/src/components/layout/Sidebar.tsx` — 点击行为改为 openTab
- `desktop/src/pages/ActiveSession.tsx` — 从 chatStore.sessions[id] 读取
- `desktop/src/pages/Settings.tsx` — 新增 Tab 相关设置项
- `desktop/src/stores/uiStore.ts` — 可能需要调整 activeView 逻辑
- `desktop/src/stores/cliTaskStore.ts` — 按 sessionId 隔离 task 状态

## Performance Considerations

- 每个 WS 连接占用极少资源, 10 个以内无需担心
- 消息缓存在内存中, 极端情况 (大量 Tab + 长对话) 可能占用较多内存
- 非活跃 Tab 不渲染 DOM (React 条件渲染), 无 UI 性能开销
- Tab 切换无需重新加载消息 (已缓存), 切换体验流畅

## Testing Strategy

- Unit tests: tabStore CRUD, persistence, close flow logic
- Integration tests: Sidebar → Tab → WS 连接全链路
- Edge cases: 关闭最后一个 Tab、恢复已删除的 Session、大量 Tab 滚动
