import type { Day, Metric } from '../types'

export const METRICS: { id: Metric; label: string; hotkey: string }[] = [
  { id: 'messages', label: 'Messages', hotkey: 'm' },
  { id: 'sessions', label: 'Sessions', hotkey: 's' },
  { id: 'tools', label: 'Tool calls', hotkey: 't' },
  { id: 'tokens', label: 'Tokens', hotkey: 'k' },
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad = (n: number) => String(n).padStart(2, '0')

// Year, month (1-12) and day of a YYYY-MM-DD date.
const partsOf = (date: string) => {
  const [y = 1970, m = 1, d = 1] = date.split('-').map(Number)
  return { y, m, d }
}

export const localDate = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Midnight local time of a YYYY-MM-DD date.
export const dateStart = (date: string) => {
  const { y, m, d } = partsOf(date)
  return new Date(y, m - 1, d).getTime()
}

export const addDays = (date: string, n: number) => {
  const { y, m, d } = partsOf(date)
  return localDate(new Date(y, m - 1, d + n).getTime())
}

export const emptyDay = (date: string): Day => ({
  date,
  messages: 0,
  sessions: 0,
  tools: 0,
  tokens: 0,
})

type Cache = {
  lastComputedDate?: string
  dailyActivity?: { date: string; messageCount?: number; sessionCount?: number; toolCallCount?: number }[]
  dailyModelTokens?: { date: string; tokensByModel?: Record<string, number> }[]
  modelUsage?: Record<
    string,
    {
      inputTokens?: number
      outputTokens?: number
      cacheReadInputTokens?: number
      cacheCreationInputTokens?: number
    }
  >
}

export type Tally = {
  days: Map<string, Day>
  through: string | null
  models: Record<string, number>
}

const dayOf = (tally: Tally, date: string) => {
  let day = tally.days.get(date)
  if (!day) {
    day = emptyDay(date)
    tally.days.set(date, day)
  }
  return day
}

// Reads ~/.claude/stats-cache.json, the file Claude Code's own stats are computed into.
export const parseCache = (text: string): Tally => {
  const cache = JSON.parse(text) as Cache
  const tally: Tally = { days: new Map(), through: cache.lastComputedDate ?? null, models: {} }

  for (const row of cache.dailyActivity ?? []) {
    const day = dayOf(tally, row.date)
    day.messages = row.messageCount ?? 0
    day.sessions = row.sessionCount ?? 0
    day.tools = row.toolCallCount ?? 0
  }
  for (const row of cache.dailyModelTokens ?? []) {
    const byModel = row.tokensByModel ?? {}
    dayOf(tally, row.date).tokens = Object.values(byModel).reduce((a, b) => a + b, 0)
  }
  for (const [model, u] of Object.entries(cache.modelUsage ?? {})) {
    tally.models[model] =
      (u.inputTokens ?? 0) +
      (u.outputTokens ?? 0) +
      (u.cacheReadInputTokens ?? 0) +
      (u.cacheCreationInputTokens ?? 0)
  }

  return tally
}

type Entry = {
  type?: string
  timestamp?: string
  message?: {
    model?: string
    content?: unknown
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

// Adds one transcript's entries dated after `after` to the tally, counting the
// way stats-cache.json does: user, assistant and attachment rows are messages,
// tool_use blocks are tool calls, and tokens include cache reads and writes.
// A transcript counts as a session on the day of its first entry.
export const scanTranscript = (text: string, after: string | null, tally: Tally, isSession: boolean) => {
  let first: string | null = null

  for (const line of text.split('\n')) {
    if (!line.includes('"timestamp"')) continue
    let entry: Entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry.timestamp) continue
    const ms = Date.parse(entry.timestamp)
    if (Number.isNaN(ms)) continue
    const date = localDate(ms)
    first ??= date
    if (after !== null && date <= after) continue
    if (entry.type !== 'user' && entry.type !== 'assistant' && entry.type !== 'attachment') continue

    const day = dayOf(tally, date)
    day.messages += 1
    if (entry.type !== 'assistant' || !entry.message) continue

    const content = entry.message.content
    if (Array.isArray(content)) {
      day.tools += content.filter(b => b && typeof b === 'object' && b.type === 'tool_use').length
    }
    const u = entry.message.usage
    if (u) {
      const tokens =
        (u.input_tokens ?? 0) +
        (u.output_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0)
      day.tokens += tokens
      const model = entry.message.model
      if (model && model !== '<synthetic>') tally.models[model] = (tally.models[model] ?? 0) + tokens
    }
  }

  if (isSession && first !== null && (after === null || first > after)) dayOf(tally, first).sessions += 1
}

export type Cell = { date: string; value: number; isFuture: boolean }

// Weeks run Sunday to Saturday, the last column holding today.
export const buildGrid = (days: Day[], metric: Metric, weeks: number, today: string): Cell[][] => {
  const byDate = new Map(days.map(d => [d.date, d[metric]]))
  const weekday = new Date(dateStart(today)).getDay()
  const start = addDays(today, -weekday - (weeks - 1) * 7)

  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const date = addDays(start, w * 7 + d)
      return { date, value: byDate.get(date) ?? 0, isFuture: date > today }
    }),
  )
}

// Four levels, split at the quartiles of the days with any activity.
export const levelsOf = (cells: Cell[][]) => {
  const values = cells
    .flat()
    .map(c => c.value)
    .filter(v => v > 0)
    .sort((a, b) => a - b)
  const at = (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0
  const cuts = [at(0.25), at(0.5), at(0.75)]

  return (value: number) => (value <= 0 ? 0 : 1 + cuts.filter(c => value > c).length)
}

// Month names over the first week that starts in each month, where they fit.
export const monthRow = (cells: Cell[][], stride: number) => {
  const width = cells.length * stride
  const row = Array<string>(width).fill(' ')
  let free = 0
  cells.forEach((week, w) => {
    const { m, d } = partsOf(week[0]?.date ?? '')
    const at = w * stride
    if (d <= 7 && at >= free && at + 3 <= width) {
      ;[...(MONTHS[m - 1] ?? '')].forEach((ch, i) => (row[at + i] = ch))
      free = at + 4
    }
  })
  return row.join('').trimEnd()
}

export type Summary = {
  total: number
  activeDays: number
  streak: number
  longestStreak: number
  best: Day | null
}

export const summarize = (days: Day[], metric: Metric, today: string): Summary => {
  const active = days.filter(d => d[metric] > 0 && d.date <= today).sort((a, b) => (a.date < b.date ? -1 : 1))
  let longestStreak = 0
  let run = 0
  let prev: string | null = null
  for (const day of active) {
    run = prev !== null && addDays(prev, 1) === day.date ? run + 1 : 1
    longestStreak = Math.max(longestStreak, run)
    prev = day.date
  }
  // A streak still counts while today has nothing yet.
  const last = active.at(-1)?.date
  const streak = last === today || last === addDays(today, -1) ? run : 0

  return {
    total: active.reduce((sum, d) => sum + d[metric], 0),
    activeDays: active.length,
    streak,
    longestStreak,
    best: active.reduce<Day | null>((b, d) => (b === null || d[metric] > b[metric] ? d : b), null),
  }
}

export const formatNumber = (n: number) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export const formatDate = (date: string) => {
  const { m, d } = partsOf(date)
  return `${MONTHS[m - 1]} ${d}`
}

export const modelName = (model: string) => model.replace(/^claude-/, '').replace(/-\d{8}$/, '')

export const topModel = (models: Record<string, number>) => {
  const total = Object.values(models).reduce((a, b) => a + b, 0)
  const [name, tokens] = Object.entries(models).sort((a, b) => b[1] - a[1])[0] ?? []
  if (!name || !tokens || total === 0) return null
  return { name: modelName(name), share: Math.round((tokens / total) * 100) }
}
