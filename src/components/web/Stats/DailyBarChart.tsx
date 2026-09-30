import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import type { Metrics } from '../../../hooks/useStatsApi'

type DailyPoint = Metrics & { day: string }

const CHART_HEIGHT_PX = 144

function dayLabel(day: string) {
  return format(parseISO(day), 'MMM d')
}

function describe(point: DailyPoint) {
  const failed = point.failures > 0 ? `, ${point.failures} failed` : ''
  return `${dayLabel(point.day)}: ${point.requests} ${point.requests === 1 ? 'request' : 'requests'}${failed}`
}

// One series (requests per day), so one hue and no legend; the title names the series.
// Bars are focusable so the readout works from the keyboard, and a table view is available.
export default function DailyBarChart({ daily }: { daily: DailyPoint[] }) {
  const [active, setActive] = useState<DailyPoint | null>(null)
  const [showTable, setShowTable] = useState(false)
  const max = Math.max(1, ...daily.map((point) => point.requests))

  return (
    <section aria-labelledby="daily-chart-title" className="rounded-lg border border-white/8 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-white/80" id="daily-chart-title">
          Requests per day
        </h2>
        {daily.length > 0 && (
          <button
            className="text-xs text-white/50 underline-offset-2 hover:text-white hover:underline"
            onClick={() => setShowTable((value) => !value)}
            type="button"
          >
            {showTable ? 'Show chart' : 'Show table'}
          </button>
        )}
      </div>

      {daily.length === 0 && <p className="text-sm text-white/50">No requests in this range.</p>}

      {daily.length > 0 && !showTable && (
        <>
          <div className="flex gap-2">
            <span aria-hidden className="w-6 shrink-0 text-right text-[10px] text-white/40">
              {max}
            </span>
            <div
              aria-label={`Bar chart of requests per day, ${daily.length} days, peak ${max}`}
              className="flex flex-1 items-end gap-[2px] border-b border-white/15"
              role="group"
              style={{ height: CHART_HEIGHT_PX }}
            >
              {daily.map((point) => (
                <div
                  aria-label={describe(point)}
                  className={`min-w-[2px] flex-1 rounded-t-[4px] bg-sky-400 outline-none transition-opacity ${
                    active && active.day !== point.day ? 'opacity-50' : ''
                  } focus-visible:ring-2 focus-visible:ring-white`}
                  key={point.day}
                  onBlur={() => setActive(null)}
                  onFocus={() => setActive(point)}
                  onMouseEnter={() => setActive(point)}
                  onMouseLeave={() => setActive(null)}
                  role="img"
                  style={{ height: `${Math.max(2, (point.requests / max) * 100)}%` }}
                  tabIndex={0}
                />
              ))}
            </div>
          </div>
          <div className="mt-2 flex justify-between pl-8 text-[10px] text-white/40">
            <span>{dayLabel(daily[0].day)}</span>
            <span>{dayLabel(daily[daily.length - 1].day)}</span>
          </div>
          <p aria-live="polite" className="mt-2 h-4 pl-8 text-xs text-white/70">
            {active ? describe(active) : ''}
          </p>
        </>
      )}

      {daily.length > 0 && showTable && (
        <div className="max-h-56 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-white/50">
                <th className="py-1 font-medium">Day</th>
                <th className="py-1 text-right font-medium">Requests</th>
                <th className="py-1 text-right font-medium">Failed</th>
                <th className="py-1 text-right font-medium">Cache-read tokens</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((point) => (
                <tr className="border-t border-white/5 text-white/80" key={point.day}>
                  <td className="py-1">{dayLabel(point.day)}</td>
                  <td className="py-1 text-right">{point.requests}</td>
                  <td className="py-1 text-right">{point.failures}</td>
                  <td className="py-1 text-right">{point.cacheReadTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
