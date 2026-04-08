import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation } from '../../i18n'

export function StatusBar() {
  const { currentModel } = useSettingsStore()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const connectionState = useChatStore((s) => activeTabId ? s.sessions[activeTabId]?.connectionState ?? 'disconnected' : 'disconnected')
  const { sessions, activeSessionId } = useSessionStore()
  const t = useTranslation()

  const activeSession = sessions.find((s) => s.id === activeSessionId)

  const statusColor =
    connectionState === 'connected'
      ? 'bg-[var(--color-success)]'
      : connectionState === 'connecting' || connectionState === 'reconnecting'
        ? 'bg-[var(--color-warning)] animate-pulse-dot'
        : 'bg-[var(--color-error)]'

  const statusText =
    connectionState === 'connected'
      ? t('status.connected')
      : connectionState === 'connecting'
        ? t('status.connecting')
        : connectionState === 'reconnecting'
          ? t('status.reconnecting')
          : t('status.disconnected')

  const projectName = activeSession?.projectPath
    ? activeSession.projectPath.split('-').filter(Boolean).pop() || ''
    : ''

  return (
    <div className="h-[var(--statusbar-height)] flex items-center justify-between px-4 border-t border-[var(--color-border)] bg-[var(--color-surface-sidebar)] select-none text-[11px]">
      {/* Left: User info + plan */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
          <span className="text-[var(--color-text-tertiary)]">{statusText}</span>
        </div>

        {projectName && (
          <>
            <span className="text-[var(--color-outline)]">·</span>
            <span className="text-[var(--color-text-secondary)] font-[var(--font-mono)]">{projectName}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-4">
        {currentModel && (
          <span className="text-[var(--color-text-tertiary)] font-[var(--font-mono)]">
            {currentModel.name}
          </span>
        )}
      </div>
    </div>
  )
}
