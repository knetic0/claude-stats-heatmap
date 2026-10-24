export type Metric = 'messages' | 'sessions' | 'tools' | 'tokens'

export type Day = {
  date: string
  messages: number
  sessions: number
  tools: number
  tokens: number
}

export type Stats = {
  days: Day[]
  // The last day stats-cache.json covers; later days are counted from transcripts.
  through: string | null
  models: Record<string, number>
  // Transcripts too large to read (over 4 MiB), left out of the live count.
  skipped: number
  error: string | null
  loadedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'stats-heatmap': { stats: Shaped<Stats | null>; metric: Metric }
  }
}
