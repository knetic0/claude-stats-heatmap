import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Metric, Stats } from '../types'
import {
  METRICS,
  addDays,
  buildGrid,
  dateStart,
  emptyDay,
  formatDate,
  formatNumber,
  levelsOf,
  localDate,
  monthRow,
  parseCache,
  scanTranscript,
  summarize,
  topModel,
} from './stats'
import type { Cell, Tally } from './stats'

const PANE = 'stats-heatmap'
const REFRESH_MS = 5 * 60_000

// Change the tag when Stats' fields change: it declines what an earlier
// version stored, which outlives a reload.
const stats = atom({ plugin: 'stats-heatmap', key: 'stats' } as const, null, { shape: 'stats-1' })
const metric = atom({ plugin: 'stats-heatmap', key: 'metric' } as const, 'messages')

// Empty, then four levels of Claude's terracotta.
const LEVELS: [string, ...string[]] = ['#6b7280', '#5a2d1f', '#93432c', '#c9603d', '#f08a62']
const DEFAULT_COLOR = 0x01000000
const BLOCK = 0x2588
const DOT = 0x00b7
const SPACE = 0x20

const DAY_LABELS = [' ', 'Mon', ' ', 'Wed', ' ', 'Fri', ' ']

const isJsonl = (name: string) => name.endsWith('.jsonl')

const list = async ($: EngineInterface, path: string) => {
  try {
    return await $.fs.list(path)
  } catch {
    return []
  }
}

// stats-cache.json covers whole days up to its lastComputedDate; the days
// after it (usually today) are counted from the transcripts changed since.
const load = async ($: EngineInterface) => {
  const root = `${await $.env.get('HOME')}/.claude`
  let tally: Tally = { days: new Map(), through: null, models: {} }
  let error: string | null = null
  try {
    tally = parseCache(await $.fs.read(`${root}/stats-cache.json`))
  } catch {
    error = 'No stats-cache.json yet: counted from transcripts alone.'
  }

  const since = tally.through ? dateStart(addDays(tally.through, 1)) : 0
  let skipped = 0
  const scan = async (path: string, isSession: boolean) => {
    try {
      scanTranscript(await $.fs.read(path), tally.through, tally, isSession)
    } catch {
      skipped += 1
    }
  }

  for (const project of await list($, `${root}/projects`)) {
    if (project.kind !== 'dir') continue
    const dir = `${root}/projects/${project.name}`
    for (const entry of await list($, dir)) {
      if (entry.kind === 'file' && isJsonl(entry.name) && entry.mtimeMs >= since) {
        await scan(`${dir}/${entry.name}`, true)
      } else if (entry.kind === 'dir') {
        for (const sub of await list($, `${dir}/${entry.name}/subagents`)) {
          if (sub.kind === 'file' && isJsonl(sub.name) && sub.mtimeMs >= since) {
            await scan(`${dir}/${entry.name}/subagents/${sub.name}`, false)
          }
        }
      }
    }
  }

  const value: Stats = {
    days: [...tally.days.values()],
    through: tally.through,
    models: tally.models,
    skipped,
    error,
    loadedAt: await $.clock.now(),
  }
  await update($, stats, () => value)
}

const hex = (color: string) => parseInt(color.slice(1), 16)

const toBase64 = (words: Uint32Array) => {
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

// One cell per day, a blank column between weeks.
const rasterCells = (cells: Cell[][], level: (v: number) => number) => {
  const columns = cells.length * 2 - 1
  const words = new Uint32Array(columns * 7 * 3)
  for (let d = 0; d < 7; d++) {
    for (let x = 0; x < columns; x++) {
      const at = (d * columns + x) * 3
      const cell = x % 2 === 0 ? cells[x / 2]?.[d] : undefined
      const n = cell && !cell.isFuture ? level(cell.value) : -1
      words[at] = n < 0 ? SPACE : n === 0 ? DOT : BLOCK
      words[at + 1] = n < 0 ? DEFAULT_COLOR : hex(LEVELS[n] ?? LEVELS[0])
      words[at + 2] = DEFAULT_COLOR
    }
  }
  return { columns, cells: toBase64(words) }
}

const svgHeatmap = (cells: Cell[][], level: (v: number) => number, unit: string) => {
  const size = 11
  const step = 14
  const left = 30
  const top = 18
  const width = left + cells.length * step
  const height = top + 7 * step
  const label = (x: number, y: number, text: string) =>
    `<text x="${x}" y="${y}" font-size="10" font-family="system-ui, sans-serif" fill="#8b949e">${text}</text>`

  const parts: string[] = []
  const months = monthRow(cells, 1)
  for (let w = 0; w < months.length; w++) {
    if (months[w] !== ' ' && (w === 0 || months[w - 1] === ' ')) {
      parts.push(label(left + w * step, 11, months.slice(w, w + 3)))
    }
  }
  DAY_LABELS.forEach((text, d) => {
    if (text.trim()) parts.push(label(0, top + d * step + 9, text))
  })
  cells.forEach((week, w) =>
    week.forEach((cell, d) => {
      if (cell.isFuture) return
      const n = level(cell.value)
      const fill = n === 0 ? `fill="${LEVELS[0]}" fill-opacity="0.18"` : `fill="${LEVELS[n]}"`
      parts.push(
        `<rect x="${left + w * step}" y="${top + d * step}" width="${size}" height="${size}" rx="2" ${fill}>` +
          `<title>${formatDate(cell.date)}: ${formatNumber(cell.value)} ${unit}</title></rect>`,
      )
    }),
  )

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${parts.join('')}</svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'heatmap',
      description: 'Show your Claude Code activity as a calendar heatmap',
    })
    void load($)
    $.clock.every(REFRESH_MS, () => void load($))

    return next(e)
  })

  on('command.run', { command: 'heatmap' }, async $ => {
    await load($)
    await $.ui.open({ id: PANE, title: 'Activity', columns: 64, rows: 15 })

    return { text: 'Activity heatmap opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const data = await read($, stats)
    const chosen = await read($, metric)

    if (data === null) return <Text dimColor>Reading your activity…</Text>

    const today = localDate(await $.clock.now())
    const unit = (METRICS.find(m => m.id === chosen)?.label ?? chosen).toLowerCase()
    const weeks = e.surface === 'terminal' ? Math.max(4, Math.min(53, Math.floor((e.props.bodyColumns - 3) / 2))) : 53
    const cells = buildGrid(data.days, chosen, weeks, today)
    const level = levelsOf(cells)
    const all = summarize(data.days, chosen, today)
    const shown = summarize(
      cells.flat().map(c => ({ ...emptyDay(c.date), [chosen]: c.value })),
      chosen,
      today,
    )
    const model = topModel(data.models)
    const pick = (id: Metric) => () => update($, metric, () => id)

    let heatmap
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      heatmap = (
        <Box flexDirection="column">
          <Text dimColor>{'    ' + monthRow(cells, 2)}</Text>
          <Box>
            <Box flexDirection="column" width={4}>
              {DAY_LABELS.map(text => (
                <Text dimColor>{text}</Text>
              ))}
            </Box>
            <Raster key="grid" rows={7} {...rasterCells(cells, level)} />
          </Box>
        </Box>
      )
    } else {
      const { Svg } = $.ui.resolve(e)
      heatmap = (
        <Svg
          source={svgHeatmap(cells, level, unit)}
          alt={`${formatNumber(shown.total)} ${unit} over the last ${weeks} weeks`}
          isInteractive
        />
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexWrap="wrap" columnGap={1}>
          {METRICS.map(m => (
            <Button
              key={m.id}
              label={m.label}
              hotkey={m.hotkey}
              variant={m.id === chosen ? 'primary' : 'secondary'}
              onPress={pick(m.id)}
            />
          ))}
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => load($)} />
        </Box>
        {heatmap}
        <Box>
          <Text dimColor>Less </Text>
          {LEVELS.map((color, n) => (
            <Text color={color} dimColor={n === 0}>
              {n === 0 ? '·' : '█'}
            </Text>
          ))}
          <Text dimColor> More</Text>
        </Box>
        <Box flexDirection="column">
          <Text bold>
            {`${formatNumber(shown.total)} ${unit} in ${weeks} weeks · ${formatNumber(all.total)} all time`}
          </Text>
          <Text>
            {all.activeDays} active days · streak {all.streak} · longest {all.longestStreak}
          </Text>
          {all.best && (
            <Text>
              Busiest day: {formatDate(all.best.date)} ({formatNumber(all.best[chosen])} {unit})
            </Text>
          )}
          {model && (
            <Text>
              Top model: {model.name} ({model.share}% of tokens)
            </Text>
          )}
          <Text dimColor>
            {data.error ??
              (data.through
                ? `Cached through ${formatDate(data.through)}, later days live from transcripts.`
                : 'Counted from transcripts.')}
            {data.skipped > 0 ? ` ${data.skipped} transcripts too large to read were left out.` : ''}
          </Text>
        </Box>
      </Box>
    )
  })
}
