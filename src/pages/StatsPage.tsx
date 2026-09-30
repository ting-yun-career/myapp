import { useState } from 'react'
import { format } from 'date-fns'
import ConversationViewer from '../components/web/Stats/ConversationViewer'
import DailyBarChart from '../components/web/Stats/DailyBarChart'
import { useRemote } from '../hooks/useRemote'
import { statsErrorMessage, useStatsApi } from '../hooks/useStatsApi'
import type { ConversationSummary } from '../hooks/useStatsApi'

const RANGE_OPTIONS = [7, 30, 90] as const
const DAY_MS = 24 * 60 * 60 * 1000

function formatUsd(value: number) {
  return value === 0 ? '$0' : value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function ErrorNotice({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="text-sm" role="alert">
      <p className="text-red-400">{statsErrorMessage(error)}</p>
      <button className="mt-2 text-xs text-white/60 underline" onClick={onRetry} type="button">
        Retry
      </button>
    </div>
  )
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-white/8 p-4">
      <p className="text-xs text-white/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {note && <p className="mt-1 text-xs text-white/40">{note}</p>}
    </div>
  )
}

function ConversationPage({
  ip,
  before,
  isLast,
  onLoadMore,
  onSelect,
}: {
  ip?: string
  before?: string
  isLast: boolean
  onLoadMore: (cursor: string) => void
  onSelect: (conversation: ConversationSummary) => void
}) {
  const { getConversations } = useStatsApi()
  const { data, error, isLoading, retry } = useRemote(`conversations:${ip ?? ''}:${before ?? ''}`, () => getConversations({ ip, before }))

  if (isLoading) return <li className="px-4 py-3 text-sm text-white/50">Loading conversations…</li>
  if (error !== undefined) {
    return (
      <li className="px-4 py-3">
        <ErrorNotice error={error} onRetry={retry} />
      </li>
    )
  }
  if (!data) return null

  return (
    <>
      {data.conversations.map((conversation) => (
        <li className="border-b border-white/5 last:border-b-0" key={conversation.id}>
          <button className="block w-full px-4 py-3 text-left hover:bg-white/[0.03]" onClick={() => onSelect(conversation)} type="button">
            <span className="block truncate text-sm text-white/80">{conversation.firstMessage ?? '(no visitor message)'}</span>
            <span className="mt-0.5 block text-xs text-white/40">
              {format(new Date(conversation.createdAt), 'MMM d, h:mm a')} · {conversation.ip ?? 'Unknown IP'} · {conversation.messageCount}{' '}
              {conversation.messageCount === 1 ? 'message' : 'messages'}
            </span>
          </button>
        </li>
      ))}
      {isLast && data.nextBefore && (
        <li className="px-4 py-3">
          <button className="text-xs text-white/60 underline" onClick={() => onLoadMore(data.nextBefore as string)} type="button">
            Load more
          </button>
        </li>
      )}
    </>
  )
}

function ConversationList({ ip, onSelect }: { ip?: string; onSelect: (conversation: ConversationSummary) => void }) {
  // One ConversationPage per cursor; the first page has no cursor.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])

  return (
    <ul className="rounded-lg border border-white/8">
      {cursors.map((cursor, index) => (
        <ConversationPage
          before={cursor}
          ip={ip}
          isLast={index === cursors.length - 1}
          key={cursor ?? 'first'}
          onLoadMore={(next) => setCursors((current) => [...current, next])}
          onSelect={onSelect}
        />
      ))}
    </ul>
  )
}

export default function StatsPage() {
  const { getByIp, getSummary } = useStatsApi()
  const [days, setDays] = useState<(typeof RANGE_OPTIONS)[number]>(30)
  const [ipFilter, setIpFilter] = useState<string | undefined>()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const overview = useRemote(`overview:${days}`, () => {
    const to = new Date()
    const from = new Date(to.getTime() - days * DAY_MS)
    return Promise.all([getSummary(from.toISOString(), to.toISOString()), getByIp(from.toISOString(), to.toISOString())])
  })

  const [summary, byIp] = overview.data ?? []
  const totals = summary?.totals

  return (
    <main className="min-h-screen bg-neutral-950 pb-24 text-white">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-10 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Chat stats</h1>
          <div aria-label="Date range" className="flex gap-1" role="group">
            {RANGE_OPTIONS.map((option) => (
              <button
                aria-pressed={days === option}
                className={`rounded-[3px] border px-3 py-1.5 text-sm ${
                  days === option ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/60 hover:text-white'
                }`}
                key={option}
                onClick={() => setDays(option)}
                type="button"
              >
                Last {option} days
              </button>
            ))}
          </div>
        </div>

        {overview.isLoading && <p className="text-sm text-white/50">Loading stats…</p>}

        {!overview.isLoading && overview.error !== undefined && <ErrorNotice error={overview.error} onRetry={overview.retry} />}

        {totals && summary && byIp && (
          <>
            {totals.requests === 0 ? (
              <p className="text-sm text-white/50">No model requests in this range yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Tile label="Requests processed" note={`${totals.turns.toLocaleString()} chat turns${totals.failures > 0 ? ` · ${totals.failures} failed` : ''}`} value={totals.requests.toLocaleString()} />
                <Tile label="Conversations" value={totals.conversations.toLocaleString()} />
                <Tile label="Tokens (in + out)" note={`${totals.inputTokens.toLocaleString()} in · ${totals.outputTokens.toLocaleString()} out`} value={(totals.inputTokens + totals.outputTokens).toLocaleString()} />
                <Tile label="Cache hit rate" note={`${totals.cacheReadTokens.toLocaleString()} read · ${totals.cacheCreationTokens.toLocaleString()} written`} value={formatPercent(totals.cacheHitRate)} />
                <Tile label="Tokens saved" note="Served from cache" value={totals.tokensSaved.toLocaleString()} />
                <Tile label="Estimated cost" note={totals.unpricedRequests > 0 ? `${totals.unpricedRequests} requests not priced` : undefined} value={formatUsd(totals.costUsd)} />
                <Tile label="Cost saved" note={`${formatUsd(totals.cacheReadSavingsUsd)} from reads − ${formatUsd(totals.cacheWritePremiumUsd)} write premium`} value={formatUsd(totals.cacheReadSavingsUsd - totals.cacheWritePremiumUsd)} />
              </div>
            )}

            <DailyBarChart daily={summary.daily} />

            <section aria-labelledby="by-ip-title">
              <h2 className="mb-2 text-sm font-medium text-white/80" id="by-ip-title">
                By IP address
              </h2>
              {byIp.ips.length === 0 ? (
                <p className="text-sm text-white/50">No requests in this range.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-white/8">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b border-white/8 bg-white/[0.03] text-left text-white/50">
                        <th className="px-4 py-3 font-medium">IP</th>
                        <th className="px-4 py-3 text-right font-medium">Requests</th>
                        <th className="px-4 py-3 text-right font-medium">Conversations</th>
                        <th className="px-4 py-3 text-right font-medium">Tokens</th>
                        <th className="px-4 py-3 text-right font-medium">Cost</th>
                        <th className="px-4 py-3 text-left font-medium">Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byIp.ips.map((entry) => {
                        const filterValue = entry.ip ?? 'unknown'
                        return (
                          <tr className="border-b border-white/5 last:border-b-0 hover:bg-white/[0.03]" key={filterValue}>
                            <td className="px-4 py-3">
                              <button
                                className="text-white/80 underline-offset-2 hover:underline"
                                onClick={() => {
                                  setIpFilter(filterValue)
                                  setSelectedId(null)
                                }}
                                type="button"
                              >
                                {entry.ip ?? 'Unknown IP'}
                              </button>
                            </td>
                            <td className="px-4 py-3 text-right text-white/70">{entry.requests.toLocaleString()}</td>
                            <td className="px-4 py-3 text-right text-white/70">{entry.conversations.toLocaleString()}</td>
                            <td className="px-4 py-3 text-right text-white/70">{(entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens).toLocaleString()}</td>
                            <td className="px-4 py-3 text-right text-white/70">{formatUsd(entry.costUsd)}</td>
                            <td className="whitespace-nowrap px-4 py-3 text-white/50">{entry.lastSeen ? format(new Date(entry.lastSeen), 'MMM d, h:mm a') : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        <section aria-labelledby="conversations-title">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-white/80" id="conversations-title">
              Conversations{ipFilter ? ` from ${ipFilter === 'unknown' ? 'unknown IP' : ipFilter}` : ''}
            </h2>
            {ipFilter && (
              <button
                className="text-xs text-white/60 underline"
                onClick={() => {
                  setIpFilter(undefined)
                  setSelectedId(null)
                }}
                type="button"
              >
                Show all
              </button>
            )}
          </div>
          <ConversationList ip={ipFilter} key={ipFilter ?? 'all'} onSelect={(conversation) => setSelectedId(conversation.id)} />
        </section>

        {selectedId && <ConversationViewer conversationId={selectedId} key={selectedId} onClose={() => setSelectedId(null)} />}
      </div>
    </main>
  )
}
