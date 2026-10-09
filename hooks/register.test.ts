import { test, expect, mock } from 'claude-code/testing'
import { outputDir, safeId, appendLog, draftValue, wordValue, numberValue, quotaSignal, permissionVerdictCounts,
  addStepUsage, takeTurnUsage, STEP_SUM_CAP, type StepSum, backgroundStarted, backgroundEnded, applyStart, applyEnd,
  countRunning, RUNNING_CAP, type BackgroundKind } from './register'

test('the output folder: an absolute option, ~/ expanded, else <home>/.claude/agent-state, never a relative one', () => {
  expect(outputDir('', '/home/u')).toBe('/home/u/.claude/agent-state')
  expect(outputDir(undefined, '/home/u/')).toBe('/home/u/.claude/agent-state')
  expect(outputDir('/var/state/', '/home/u')).toBe('/var/state')
  expect(outputDir('~/states', '/home/u')).toBe('/home/u/states')
  expect(outputDir('states', '/home/u')).toBe(null)
  expect(outputDir('', undefined)).toBe(null)
  expect(outputDir('~/x', 'relative')).toBe(null)
})

test('a session id becomes a safe file name', () => {
  expect(safeId('3f2a9c1e-0000-4000-8000-123456789abc')).toBe('3f2a9c1e-0000-4000-8000-123456789abc')
  expect(safeId('../../etc/passwd')).toBe('etcpasswd')
  expect(safeId('')).toBe(null)
  expect(safeId(undefined)).toBe(null)
})

test('the log appends, and past the cap the old text rolls over', () => {
  expect(appendLog('', ['a', 'b'])).toEqual({ log: 'a\nb\n', rolled: null })
  expect(appendLog('a\n', ['b'], 100)).toEqual({ log: 'a\nb\n', rolled: null })
  expect(appendLog('x'.repeat(10), ['yy'], 11)).toEqual({ log: 'yy\n', rolled: 'x'.repeat(10) })
})

test('the prompt box is only WHETHER text waits; event words and numbers fit their shape', () => {
  expect(draftValue('secret text')).toBe('1')
  expect(draftValue(' \n')).toBe('')
  expect(wordValue('Rate Limit!')).toBe('rate_limit_')
  expect(wordValue(undefined)).toBe('unknown')
  expect(numberValue(23.5)).toBe('24')
  expect(numberValue(-4)).toBe('0')
  expect(numberValue('5')).toBe('')
  expect(quotaSignal('five_hour')).toBe('quota_5h')
  expect(quotaSignal('spend_limit')).toBe(null)
})

test('an ask is the permission state only in its own open turn, and not for a dialog tool', () => {
  expect(permissionVerdictCounts('ask', 'Bash', true, 3, 3)).toBe(true)
  expect(permissionVerdictCounts('allow', 'Bash', true, 3, 3)).toBe(false)
  expect(permissionVerdictCounts('ask', 'AskUserQuestion', true, 3, 3)).toBe(false)
  expect(permissionVerdictCounts('ask', 'Bash', false, 3, 3)).toBe(false)
  expect(permissionVerdictCounts('ask', 'Bash', true, 2, 3)).toBe(false)
})

test('a turn\'s requests are summed per model, and a turn is taken once', () => {
  const m = new Map<string, StepSum>()
  const u = (model: string, i: number) => ({ input_tokens: i, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 1, model })
  addStepUsage(m, 't1', false, u('opus', 1))
  addStepUsage(m, 't1', false, u('opus', 2))
  addStepUsage(m, 't1', false, u('sonnet', 5))
  addStepUsage(m, 't1', false, { ...u('x', 1), output_tokens: -3 })
  expect(takeTurnUsage(m, 't1').map(x => [x.model, x.input_tokens])).toEqual([['opus', 3], ['sonnet', 5]])
  expect(takeTurnUsage(m, 't1')).toEqual([])
  for (let i = 0; i < STEP_SUM_CAP + 5; i++) addStepUsage(m, 'x' + i, false, u('m', 1))
  expect(m.size).toBe(STEP_SUM_CAP)
})

test('background work: started from the tool result, ended by a terminal notification, an early end cancels its start', () => {
  expect(backgroundStarted('Bash', { backgroundTaskId: 'b1' })).toEqual({ id: 'b1', kind: 'process' })
  expect(backgroundStarted('Agent', { status: 'async_launched', agentId: 'a1' })).toEqual({ id: 'a1', kind: 'agent' })
  expect(backgroundStarted('Agent', { status: 'completed', agentId: 'a1' })).toBe(null)
  expect(backgroundEnded('<task-notification><task-id>b1</task-id><status>completed</status></task-notification>'
    + '<task-notification><task-id>m1</task-id><status>running</status></task-notification>')).toEqual(['b1'])
  const running = new Map<string, BackgroundKind>(), early = new Set<string>()
  expect(applyEnd(running, early, 'fast')).toBe(false)
  expect(applyStart(running, early, 'fast', 'process')).toBe(false)
  expect(applyStart(running, early, 'a1', 'agent')).toBe(true)
  expect(countRunning(running)).toEqual({ agentWork: 1, processes: 0 })
  for (let i = 0; i < RUNNING_CAP + 5; i++) applyStart(running, early, 'p' + i, 'process')
  expect(running.size).toBe(RUNNING_CAP)
})

// Through the hooks, the engine beneath: the snapshot follows the state, the log holds the changes and the token use,
// and nothing of the prompt's text reaches either file.
test('the snapshot and the log, through the hooks', async ($, on) => {
  const files = new Map<string, string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = on as any, d = $ as any
  const clock = mock.clock(on)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  o('fs.write', (_$: any, e: any) => { files.set(e.path ?? e[0], e.text ?? e[1]); return { value: undefined } })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  o('fs.exists', (_$: any, e: any) => ({ value: files.has(e.path ?? e[0] ?? e) }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  o('fs.read', (_$: any, e: any) => ({ value: files.get(e.path ?? e[0] ?? e) ?? '' }))
  o('env.get', () => ({ value: '/home/u' }))
  o('session.id', () => ({ value: 'sess-1' }))
  o('session.version', () => ({ value: { version: 'test' } }))
  o('session.usage', () => ({ value: { startedAt: 1_791_550_000_123, context: {}, rateLimits: [] } }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  o('session.start', (_$: any, e: any) => ({ value: { cwd: e.cwd }, cwd: e.cwd }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  o('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  o('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, model: 'opus' } }
  })
  o('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  o('session.end', () => ({ sessionId: 'sess-1' }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  o('prompt.edit', (_$: any, e: any) => ({ text: e.text, cursor: e.text.length }))
  const settle = () => clock.advance(0)
  const snap = () => JSON.parse(files.get('/home/u/.claude/agent-state/sess-1.json') ?? '{}')
  const lines = () => (files.get('/home/u/.claude/agent-state/sess-1.jsonl') ?? '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))

  await d.session.start({ cwd: '/work/project', source: 'startup' })
  await settle()
  expect(snap()).toMatchObject({ schema: 1, session_id: 'sess-1', cwd: '/work/project', state: 'idle', session_started_ms: 1_791_550_000_123 })

  await d.prompt.edit({ origin: { kind: 'composer' }, text: 'my private prompt', cursor: 17, start: 17, end: 17, inputText: 't' })
  await settle()
  expect(snap().signals.draft.value).toBe('1')

  // (the kit's turn.start never settles with a plugin beneath it on 2.1.295 -- measured with an empty hook body --
  // so the turn is driven from its tool call and its completion)
  await d.tool.call({ tool: 'Bash', input: { command: 'ls' } })
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _c of d.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 })) { /* drain */ }
  await d.turn.complete({ reason: 'answer', answer: 'x', durationMs: 1, isAborted: false, turnId: 't1' })
  await settle()
  expect(snap().state).toBe('idle')
  const log = lines()
  expect(log.filter(l => l.kind === 'state').map(l => l.state)).toEqual(['idle', 'tool', 'idle'])
  expect(log.filter(l => l.kind === 'state' && l.state === 'tool')[0].tool).toBe('Bash')
  expect(log.filter(l => l.kind === 'usage')).toEqual([expect.objectContaining({ model: 'opus', input: 1, output: 2, cache_read: 3, cache_creation: 4 })])
  expect(log.filter(l => l.kind === 'signal' && l.signal === 'turn_end').map(l => l.value)).toEqual(['answer'])
  const all = [...files.values()].join('\n')
  expect(all.includes('my private prompt')).toBe(false)

  await d.session.end({ reason: 'clear' })
  await settle()
  expect(snap().state).toBe('ended')
  expect(snap().signals.session_end.value).toBe('clear')
})

test('with no usable output folder the mod writes nothing and the session goes on', async ($, on) => {
  let writes = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = on as any, d = $ as any
  const clock = mock.clock(on)
  o('fs.write', () => { writes++; return { value: undefined } })
  o('env.get', () => ({ value: undefined }))
  o('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  o('session.id', () => ({ value: 'sess-2' }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  o('session.start', (_$: any, e: any) => ({ value: { cwd: e.cwd }, cwd: e.cwd }))
  await d.session.start({ cwd: '/work', source: 'startup' })
  await d.tool.call({ tool: 'Bash', input: { command: 'ls' } })
  await clock.advance(0)
  expect(writes).toBe(0)
})
