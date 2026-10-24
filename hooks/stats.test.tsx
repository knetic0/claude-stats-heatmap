import { expect, mock, test } from 'claude-code/testing'

import type { Day, Stats } from '../types'
import { addDays, buildGrid, localDate, parseCache, scanTranscript, summarize } from './stats'

const PANE = {
  plugin: 'stats-heatmap',
  component: 'Pane',
  requestId: 'stats-heatmap',
  props: {
    title: 'Activity',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const day = (date: string, messages: number): Day => ({
  date,
  messages,
  sessions: 1,
  tools: messages * 2,
  tokens: messages * 1000,
})

test('a transcript counts the way stats-cache.json does', async () => {
  const tally = parseCache(
    JSON.stringify({
      lastComputedDate: '2026-10-01',
      dailyActivity: [{ date: '2026-10-01', messageCount: 5, sessionCount: 1, toolCallCount: 2 }],
      dailyModelTokens: [{ date: '2026-10-01', tokensByModel: { 'claude-opus-5': 300 } }],
      modelUsage: { 'claude-opus-5': { inputTokens: 100, outputTokens: 200 } },
    }),
  )
  const at = (hour: number) => new Date(2026, 9, 2, hour).toISOString()
  const lines = [
    { type: 'queue-operation', timestamp: at(9) },
    { type: 'user', timestamp: at(9), message: { content: 'hi' } },
    { type: 'attachment', timestamp: at(9) },
    {
      type: 'assistant',
      timestamp: at(10),
      message: {
        model: 'claude-opus-5',
        content: [{ type: 'tool_use' }, { type: 'text' }],
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 70 },
      },
    },
  ]
  scanTranscript(lines.map(l => JSON.stringify(l)).join('\n'), tally.through, tally, true)

  expect(tally.days.get('2026-10-01')).toEqual({
    date: '2026-10-01',
    messages: 5,
    sessions: 1,
    tools: 2,
    tokens: 300,
  })
  expect(tally.days.get('2026-10-02')).toEqual({
    date: '2026-10-02',
    messages: 3,
    sessions: 1,
    tools: 1,
    tokens: 100,
  })
  expect(tally.models['claude-opus-5']).toBe(400)
})

test('the grid ends on the week holding today', async () => {
  const cells = buildGrid([day('2026-10-24', 3)], 'messages', 2, '2026-10-24')

  expect(cells.length).toBe(2)
  expect(cells[1]?.[6]).toEqual({ date: '2026-10-24', value: 3, isFuture: false })
  expect(cells[0]?.[0]?.date).toBe('2026-10-11')
})

test('a streak survives a today with nothing yet', async () => {
  const days = ['2026-10-20', '2026-10-22', '2026-10-23'].map(d => day(d, 1))
  const summary = summarize(days, 'messages', '2026-10-24')

  expect(summary.streak).toBe(2)
  expect(summary.longestStreak).toBe(2)
  expect(summary.activeDays).toBe(3)
})

test('the pane draws the heatmap and switches metric, on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: new Date(2026, 9, 24, 12).getTime() })
  const today = localDate(clock.now())
  const stats: Stats = {
    days: [day(today, 40), day(addDays(today, -1), 10)],
    through: addDays(today, -1),
    models: { 'claude-opus-5-5': 3, 'claude-sonnet-5': 1 },
    skipped: 0,
    error: null,
    loadedAt: 0,
  }
  // A call on `$` is answered `{ value }`: here the stored, shape-tagged stats.
  on('state.get', ($, e, next) =>
    e.key === 'stats' ? { value: { value: { shape: 'stats-1', value: stats }, version: 1 } } : next(e),
  )

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /50 messages in \d+ weeks/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Top model: opus-5-5 \(75% of tokens\)/ })).toBeDefined()
    expect(await ui.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).toBeDefined()

    await ui.press({ key: 'tools' })
    expect(await ui.find({ type: 'Text', text: /100 tool calls in/ })).toBeDefined()
    await ui.press({ key: 'messages' })
    await ui.unmount()
  }
})
