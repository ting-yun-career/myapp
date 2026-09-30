import { format } from 'date-fns'
import { statsErrorMessage, useStatsApi } from '../../../hooks/useStatsApi'
import type { ConversationMessage, StoredBlock } from '../../../hooks/useStatsApi'
import { useRemote } from '../../../hooks/useRemote'

function stringify(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function Block({ block }: { block: StoredBlock }) {
  if (block.type === 'text') return <p className="whitespace-pre-wrap">{block.text}</p>

  if (block.type === 'tool_use') {
    return (
      <div className="rounded border border-white/10 bg-white/[0.03] p-2">
        <p className="text-xs text-amber-300/80">Tool call · {block.name}</p>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-white/60">{stringify(block.input)}</pre>
      </div>
    )
  }

  if (block.type === 'tool_result') {
    return (
      <div className="rounded border border-white/10 bg-white/[0.03] p-2">
        <p className="text-xs text-emerald-300/80">Tool result</p>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-white/60">{stringify(block.content)}</pre>
      </div>
    )
  }

  return <p className="text-xs text-white/40">[{block.type}]</p>
}

function Message({ message }: { message: ConversationMessage }) {
  const isVisitor = message.role === 'user' && typeof message.content === 'string'
  const label = isVisitor ? 'Visitor' : message.role === 'assistant' ? 'Assistant' : 'Tool'
  const blocks = typeof message.content === 'string' ? null : message.content

  return (
    <li className="space-y-1">
      <p className="text-xs text-white/40">
        {label} · {format(new Date(message.createdAt), 'MMM d, h:mm:ss a')}
      </p>
      <div className={`space-y-2 text-sm ${isVisitor ? 'text-white' : 'text-white/80'}`}>
        {blocks ? blocks.map((block, index) => <Block block={block} key={index} />) : <p className="whitespace-pre-wrap">{message.content as string}</p>}
      </div>
    </li>
  )
}

export default function ConversationViewer({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const { getConversation } = useStatsApi()
  const { data, error, isLoading, retry } = useRemote(`conversation:${conversationId}`, () => getConversation(conversationId))

  return (
    <section aria-label="Conversation" className="rounded-lg border border-white/8 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-white/80">Conversation</h2>
        <button className="text-xs text-white/50 hover:text-white" onClick={onClose} type="button">
          Close
        </button>
      </div>

      {isLoading && <p className="text-sm text-white/50">Loading conversation…</p>}

      {!isLoading && error !== undefined && (
        <div className="text-sm" role="alert">
          <p className="text-red-400">{statsErrorMessage(error)}</p>
          <button className="mt-2 text-xs text-white/60 underline" onClick={retry} type="button">
            Retry
          </button>
        </div>
      )}

      {data && (
        <>
          <p className="mb-4 text-xs text-white/40">
            {data.conversation.ip ?? 'Unknown IP'} · started {format(new Date(data.conversation.createdAt), 'MMM d, yyyy h:mm a')}
          </p>
          {data.messages.length === 0 ? (
            <p className="text-sm text-white/50">No messages.</p>
          ) : (
            <ol className="max-h-[28rem] space-y-4 overflow-y-auto">
              {data.messages.map((message) => (
                <Message key={message.id} message={message} />
              ))}
            </ol>
          )}

          <h3 className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-white/40">Model calls</h3>
          {data.usage.length === 0 ? (
            <p className="text-sm text-white/50">No usage was recorded for this conversation.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-xs">
                <thead>
                  <tr className="text-left text-white/40">
                    <th className="py-1 font-medium">#</th>
                    <th className="py-1 font-medium">Stop</th>
                    <th className="py-1 text-right font-medium">In</th>
                    <th className="py-1 text-right font-medium">Out</th>
                    <th className="py-1 text-right font-medium">Cache write</th>
                    <th className="py-1 text-right font-medium">Cache read</th>
                    <th className="py-1 text-right font-medium">Latency</th>
                    <th className="py-1 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.usage.map((call, index) => (
                    <tr className="border-t border-white/5 text-white/70" key={index}>
                      <td className="py-1">{call.iteration + 1}</td>
                      <td className="py-1">{call.stopReason ?? '—'}</td>
                      <td className="py-1 text-right">{call.inputTokens.toLocaleString()}</td>
                      <td className="py-1 text-right">{call.outputTokens.toLocaleString()}</td>
                      <td className="py-1 text-right">{call.cacheCreationTokens.toLocaleString()}</td>
                      <td className="py-1 text-right">{call.cacheReadTokens.toLocaleString()}</td>
                      <td className="py-1 text-right">{(call.latencyMs / 1000).toFixed(1)}s</td>
                      <td className={`py-1 text-right ${call.status === 'ok' ? '' : 'text-red-400'}`}>{call.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
