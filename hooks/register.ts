import type { Register } from 'claude-code'

// agent-state: what this Claude Code session is really doing, as the session itself sees it -- not read off the
// screen. Two files per session in the output folder:
//   <session-id>.json   the current snapshot (state, tool, signals, heartbeat), rewritten on every change
//   <session-id>.jsonl  the event log (state changes, signal changes, per-turn token use), appended in batches
//
// REPORT ONLY, NEVER A GATE: every hook passes the event on unchanged and returns what the engine answered; a failure
// in here is caught and the session goes on. A snapshot whose heartbeat_ms is older than ~1 minute means the mod is
// not running (the heartbeat rewrites it every 30 s).
//
// PRIVACY: the prompt box is reported only as WHETHER text waits (draft) or a suggestion shows (suggest), never the
// text; a slash command by name only, never its arguments; token use as numbers and the model name only.

export const HEARTBEAT_MS = 30_000
export const LOG_MAX_CHARS = 1_000_000   // the .jsonl rolls over to .jsonl.1 past this (one previous file is kept)
const SESSION_END_BUDGET_MS = 1_000      // session.end has a short bound: the last write is awaited up to this

export type State = 'idle' | 'working' | 'tool' | 'permission' | 'ended'
export type Signal = 'draft' | 'command' | 'turn_end' | 'suggest' | 'api_error' | 'notice' | 'session_end'
  | 'quota_5h' | 'quota_7d' | 'context' | 'background' | 'background_proc'

/** EVENT signals are logged every time; the rest are states, logged only when the value changes. */
export const EVENT_SIGNALS: readonly Signal[] = ['turn_end', 'api_error', 'notice', 'session_end']

/** Tools whose 'ask' verdict is a question to the person, not a permission prompt. */
export const PERMISSION_EXEMPT_TOOLS = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']

/** Whether a tool.check verdict is the permission state: an 'ask', not a dialog tool's, in the turn still open. A
 *  verdict that lands after its turn ended would otherwise mark an idle session as waiting for permission. */
export function permissionVerdictCounts(decision: unknown, tool: string, turnOpen: boolean, askedIn: number, nowTurn: number): boolean {
  return decision === 'ask' && !PERMISSION_EXEMPT_TOOLS.includes(tool) && turnOpen && askedIn === nowTurn
}

/** The output folder: the option when it is an absolute path (or starts with ~/), else <home>/.claude/agent-state.
 *  null when no usable folder can be named (no home, a relative option): the mod then writes nothing. */
export function outputDir(option: unknown, home: string | undefined): string | null {
  const o = typeof option === 'string' ? option.trim().replace(/\/+$/, '') : ''
  const h = typeof home === 'string' && home.startsWith('/') ? home.replace(/\/+$/, '') : null
  if (o.startsWith('/')) return o
  if (o.startsWith('~/')) return h ? h + o.slice(1) : null
  if (o.length > 0) return null
  return h ? h + '/.claude/agent-state' : null
}

/** A file-name-safe session id (the transcript's name is a UUID; anything else is reduced to [A-Za-z0-9_-]). */
export function safeId(id: unknown): string | null {
  const s = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)
  return s.length > 0 ? s : null
}

/** A word-shaped value for the EVENT signals: lower-cased, every other character an underscore, '' -> 'unknown'. */
export function wordValue(raw: unknown): string {
  const w = String(raw ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60)
  return w.length > 0 ? w : 'unknown'
}

/** '1' while text (anything but whitespace) waits in the prompt box, '' otherwise. Never the text itself. */
export function draftValue(text: string): string {
  return text.trim().length > 0 ? '1' : ''
}

export function suggestValue(isShown: unknown): string {
  return isShown === true ? '1' : ''
}

/** A whole number 0..9999 for the percent / count signals, '' when there is no number. */
export function numberValue(raw: unknown): string {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return ''
  return String(Math.min(9999, Math.max(0, Math.round(raw))))
}

export function quotaSignal(kind: string): Signal | null {
  return kind === 'five_hour' ? 'quota_5h' : kind === 'seven_day' ? 'quota_7d' : null
}

/** An edit or suggestion answer is stale when the box changed (a submit, typing, a new turn) while it was in flight. */
export function editIsStale(changesAtStart: number, changesNow: number): boolean {
  return changesAtStart !== changesNow
}

export function startedFrom(u: { startedAt?: unknown } | null | undefined): number | null {
  const v = u?.startedAt
  return typeof v === 'number' && Number.isInteger(v) && v > 1e12 && v < 1e13 ? v : null
}

// ---- token use: summed per turn and model ---------------------------------------------------------------------------
// turn.complete's usage is the sum of the turn's requests under the LAST request's model, so a turn that switched
// models (a fallback) would book everything to one. Each request's usage comes with its own model in turn.step.

export type StepSum = { sub: boolean; model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export const STEP_SUM_CAP = 200   // turns whose end never came must not grow the map without bound

export function addStepUsage(sums: Map<string, StepSum>, turnId: string, sub: boolean, usage: unknown): void {
  if (!turnId || !usage || typeof usage !== 'object') return
  const u = usage as Record<string, unknown>
  const model = typeof u['model'] === 'string' ? (u['model'] as string).slice(0, 80) : ''
  const n = (k: string): number | null => (typeof u[k] === 'number' && Number.isInteger(u[k]) && (u[k] as number) >= 0 ? u[k] as number : null)
  const inp = n('input_tokens'), out = n('output_tokens'), cr = n('cache_read_input_tokens'), cc = n('cache_creation_input_tokens')
  if (!model || inp == null || out == null || cr == null || cc == null) return
  const key = turnId + '\u0000' + model
  const cur = sums.get(key)
  if (cur) { cur.input_tokens += inp; cur.output_tokens += out; cur.cache_read_input_tokens += cr; cur.cache_creation_input_tokens += cc; return }
  if (sums.size >= STEP_SUM_CAP) { const oldest = sums.keys().next().value; if (oldest !== undefined) sums.delete(oldest) }
  sums.set(key, { sub, model, input_tokens: inp, output_tokens: out, cache_read_input_tokens: cr, cache_creation_input_tokens: cc })
}

/** The turn's per-model sums, removed from the map (so a turn is logged once). */
export function takeTurnUsage(sums: Map<string, StepSum>, turnId: string): StepSum[] {
  const out: StepSum[] = []
  const prefix = turnId + '\u0000'
  for (const [k, v] of [...sums]) if (k.startsWith(prefix)) { out.push(v); sums.delete(k) }
  return out
}

// ---- background work: the mod keeps its own list ---------------------------------------------------------------------
// Measured on Claude Code 2.1.294-2.1.295: classic.* events (the settings-hook events, among them Stop with its
// background_tasks) did not reach a mod live, so the count comes from the starting tool's result and the task's
// terminal notification. async Agent / Workflow = agent work; a backgrounded Bash and a Monitor = a process.

export type BackgroundKind = 'agent' | 'process'
export function backgroundStarted(tool: string, result: unknown): { id: string; kind: BackgroundKind } | null {
  const r = (result ?? {}) as Record<string, unknown>
  const id = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null)
  if (tool === 'Bash') { const t = id(r.backgroundTaskId); return t ? { id: t, kind: 'process' } : null }
  if (tool === 'Monitor') { const t = id(r.taskId); return t ? { id: t, kind: 'process' } : null }
  if (tool === 'Agent' && r.status === 'async_launched') { const t = id(r.agentId); return t ? { id: t, kind: 'agent' } : null }
  if (tool === 'Workflow' && (r.status === 'async_launched' || r.status === 'remote_launched')) {
    const t = id(r.taskId); return t ? { id: t, kind: 'agent' } : null
  }
  return null
}

const TERMINAL_TASK_STATUS = ['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error', 'timeout']
/** The <task-id> of each <task-notification> block whose <status> is terminal, in order. */
export function backgroundEnded(text: string): string[] {
  const out: string[] = []
  for (const b of text.split(/<task-notification>/).slice(1)) {
    const id = /<task-id>\s*([^<\s]{1,200})\s*<\/task-id>/.exec(b)
    const st = /<status>\s*([a-z_]{1,40})\s*<\/status>/i.exec(b)
    if (id?.[1] && st?.[1] && TERMINAL_TASK_STATUS.includes(st[1].toLowerCase())) out.push(id[1])
  }
  return out
}

// An end that arrives BEFORE its start's tool result (a fast task) is kept and cancels that later start. Both lists are
// bounded, so a lost end never grows them past a handful.
export const RUNNING_CAP = 50
export function applyStart(running: Map<string, BackgroundKind>, endedEarly: Set<string>, id: string, kind: BackgroundKind): boolean {
  if (endedEarly.delete(id)) return false
  running.set(id, kind)
  while (running.size > RUNNING_CAP) { const first = running.keys().next().value; if (first === undefined) break; running.delete(first) }
  return true
}
export function applyEnd(running: Map<string, BackgroundKind>, endedEarly: Set<string>, id: string): boolean {
  if (running.delete(id)) return true
  endedEarly.add(id)
  while (endedEarly.size > RUNNING_CAP) { const first = endedEarly.values().next().value; if (first === undefined) break; endedEarly.delete(first) }
  return false
}
export function countRunning(running: ReadonlyMap<string, BackgroundKind>): { agentWork: number; processes: number } {
  let agentWork = 0, processes = 0
  for (const k of running.values()) { if (k === 'agent') agentWork++; else processes++ }
  return { agentWork, processes }
}

// ---- the two files -----------------------------------------------------------------------------------------------

export type Snapshot = {
  schema: 1
  session_id: string
  cwd: string
  cc_version: string | null
  session_started_ms: number | null
  state: State
  tool: string | null
  state_since_ms: number
  heartbeat_ms: number
  signals: Record<string, { value: string; at_ms: number }>
}

/** New log lines appended to the old log text; past the cap the old text is returned as `rolled` (for .jsonl.1) and
 *  the log starts over with the new lines alone. */
export function appendLog(old: string, lines: readonly string[], cap: number = LOG_MAX_CHARS): { log: string; rolled: string | null } {
  const add = lines.map(l => l + '\n').join('')
  if (old.length > 0 && old.length + add.length > cap) return { log: add, rolled: old }
  return { log: old + add, rolled: null }
}

// module state: a reload starts it over, and session.start fills it again (helpers that take $ must be top-level
// functions: the loader follows $ only into those)
let optionDir: unknown = undefined
let dir: string | null = null
let sid: string | null = null
let snap: Snapshot | null = null
let turnOpen = false
let turnSeq = 0
let submits = 0
let boxChanges = 0
let heartbeat: { cancel: () => void } | null = null
const stepSums = new Map<string, StepSum>()
const running = new Map<string, BackgroundKind>()
const endedEarly = new Set<string>()
// one write in flight; the snapshot is latest-wins, log lines queue in order
let inFlight = false
let snapDirty = false
let logQueue: string[] = []
let logDue = false   // the log is written in batches (heartbeat, turn end, session end): a read+rewrite per tool call
                     // of a file up to LOG_MAX_CHARS would cost more than the report is worth

const now = () => Date.now()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeOnce($: any): Promise<void> {
  if (!dir || !sid || !snap) return
  if (snapDirty) {
    snapDirty = false
    await $.fs.write(`${dir}/${sid}.json`, JSON.stringify(snap) + '\n')
  }
  if (logDue && logQueue.length > 0) {
    logDue = false
    const lines = logQueue
    logQueue = []
    const path = `${dir}/${sid}.jsonl`
    let old = ''
    try { if (await $.fs.exists(path)) old = String(await $.fs.read(path)) } catch { old = '' }
    const { log, rolled } = appendLog(old, lines)
    if (rolled !== null) await $.fs.write(path + '.1', rolled)
    await $.fs.write(path, log)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flush($: any): void {
  // nothing can be written without a folder and a session: return, or the finally below would re-run flush forever
  // on a flag no write ever clears
  if (!dir || !sid || !snap) { snapDirty = false; logDue = false; return }
  if (inFlight || !(snapDirty || (logDue && logQueue.length > 0))) return
  inFlight = true
  Promise.resolve()
    .then(() => writeOnce($))
    .catch(() => undefined)   // report only: the next change or heartbeat writes again
    .finally(() => { inFlight = false; try { flush($) } catch { /* next change */ } })
    .catch(() => undefined)
}

function log(entry: Record<string, unknown>): void {
  logQueue.push(JSON.stringify({ t: now(), ...entry }))
  if (logQueue.length > 5000) logQueue = logQueue.slice(-5000)   // a folder that cannot be written must not grow memory
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function report($: any, state: State, tool?: string): void {
  if (!snap) return
  const t = tool && (state === 'tool' || state === 'permission') ? tool.slice(0, 200) : null
  if (snap.state !== state || snap.tool !== t) {
    snap.state = state
    snap.tool = t
    snap.state_since_ms = now()
    log({ kind: 'state', state, tool: t })
  }
  snap.heartbeat_ms = now()
  snapDirty = true
  flush($)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function signal($: any, name: Signal, value: string): void {
  if (!snap) return
  const v = value.slice(0, 60)
  const isEvent = EVENT_SIGNALS.includes(name)
  if (!isEvent && (snap.signals[name]?.value ?? '') === v) return
  snap.signals[name] = { value: v, at_ms: now() }
  log({ kind: 'signal', signal: name, value: v })
  snapDirty = true
  flush($)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reportBackground($: any): void {
  const c = countRunning(running)
  signal($, 'background', c.agentWork > 0 ? numberValue(c.agentWork) : '')
  signal($, 'background_proc', c.processes > 0 ? numberValue(c.processes) : '')
}

export const register: Register = (on, options) => {
  optionDir = options?.['outputDir']

  on('session.start', async ($, e, next) => {
    try {
      let home: string | undefined
      try { home = await $.env.get('HOME') } catch { home = undefined }
      dir = outputDir(optionDir, home)
      try { sid = safeId(await $.session.id()) } catch { sid = null }
      let version: string | null = null
      try { version = (await $.session.version()).version ?? null } catch { version = null }
      let started: number | null = null
      try { started = startedFrom(await $.session.usage()) } catch { started = null }
      running.clear(); endedEarly.clear(); stepSums.clear()
      logQueue = []; logDue = false; snapDirty = false   // a new session's files start clean
      turnOpen = false
      const t = now()
      snap = {
        schema: 1, session_id: sid ?? '', cwd: String(e.cwd ?? '').slice(0, 1000), cc_version: version,
        session_started_ms: started, state: 'idle', tool: null, state_since_ms: t, heartbeat_ms: t, signals: {},
      }
      log({ kind: 'session_start', cwd: snap.cwd, cc_version: version, session_started_ms: started })
      log({ kind: 'state', state: 'idle', tool: null })   // the log's first state: report() below logs only changes
      report($, 'idle')
      if (heartbeat) heartbeat.cancel()
      heartbeat = $.clock.every(HEARTBEAT_MS, async () => {
        if (snap && snap.session_started_ms === null) {
          try { snap.session_started_ms = startedFrom(await $.session.usage()) } catch { /* next beat */ }
        }
        logDue = true
        if (snap) report($, snap.state, snap.tool ?? undefined)
      })
    } catch {
      // a reporter never stops the session
    }
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    try { boxChanges++; turnSeq++; turnOpen = true; report($, 'working'); signal($, 'suggest', '') } catch { /* report only */ }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try { addStepUsage(stepSums, String(e.turnId ?? ''), typeof e.agentId === 'string', r?.usage) } catch { /* report only */ }
    return r
  })

  on('turn.complete', ($, e, next) => {
    try {
      for (const s of takeTurnUsage(stepSums, String((e as { turnId?: unknown }).turnId ?? ''))) {
        log({ kind: 'usage', model: s.model, sub_agent: s.sub, input: s.input_tokens, output: s.output_tokens,
          cache_read: s.cache_read_input_tokens, cache_creation: s.cache_creation_input_tokens })
      }
      turnOpen = false
      logDue = true
      report($, 'idle')
      signal($, 'turn_end', wordValue((e as { reason?: string }).reason ?? 'answer'))
    } catch { /* report only */ }
    return next(e)
  })

  // draft: the box after each edit (the result of next is the box as the editor will show it)
  on('prompt.edit', async ($, e, next) => {
    const seen = submits
    const r = await next(e)
    try {
      if (!editIsStale(seen, submits)) {
        const v = draftValue(String(r?.text ?? ''))
        signal($, 'draft', v)
        if (v) { boxChanges++; signal($, 'suggest', '') }   // typing (or Tab taking it) replaces the suggestion
      }
    } catch { /* report only */ }
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', ($, e, next) => {
    try { submits++; boxChanges++; signal($, 'draft', ''); signal($, 'suggest', '') } catch { /* report only */ }
    try {
      if ((e as { origin?: { kind?: string } }).origin?.kind === 'task-notification') {
        let changed = false
        for (const id of backgroundEnded(String(e.text ?? ''))) changed = applyEnd(running, endedEarly, id) || changed
        if (changed) reportBackground($)
      }
    } catch { /* report only */ }
    return next(e)
  }).catch(($, e, next) => next(e))

  // command: open while the slash command runs, by name only
  on('command.run', async ($, e, next) => {
    try { signal($, 'command', String(e.command)) } catch { /* report only */ }
    try {
      return await next(e)
    } finally {
      try { signal($, 'command', '') } catch { /* report only */ }
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    try { report($, 'tool', String(e.tool)) } catch { /* report only */ }
    const result = await next(e)
    try { if (turnOpen) report($, 'working') } catch { /* report only */ }
    try {
      const r = result as { result?: unknown; isError?: boolean }
      if (!r?.isError) {
        const started = backgroundStarted(String(e.tool), r?.result)
        if (started && applyStart(running, endedEarly, started.id, started.kind)) reportBackground($)
        if (String(e.tool) === 'TaskStop') {
          const inp = (e as { input?: { task_id?: unknown; shell_id?: unknown } }).input
          const stopped = String(inp?.task_id ?? inp?.shell_id ?? '')
          if (stopped && running.delete(stopped)) reportBackground($)
        }
      }
    } catch { /* report only */ }
    return result
  }).catch(($, e, next) => next(e))   // never a refusal; when next was already called, next(e) replays its result

  // The permission prompt: tool.check's 'ask' verdict, measured 0.8 s before the dialog shows (2.1.295). The call's
  // result (tool.call above) turns it back to 'working'.
  on('tool.check', async ($, e, next) => {
    const askedIn = turnSeq
    const r = await next(e)
    try {
      if (permissionVerdictCounts(r?.decision, String(e.tool), turnOpen, askedIn, turnSeq)) report($, 'permission', String(e.tool))
    } catch { /* report only */ }
    return r
  }).catch(($, e, next) => next(e))   // never a refusal, never an approval: the verdict goes on as it came

  // the dim suggestion: only WHETHER it shows, never its text
  on('prompt.suggest', async ($, e, next) => {
    const seen = boxChanges
    const r = await next(e)
    try { if (!editIsStale(seen, boxChanges)) signal($, 'suggest', suggestValue(r?.isShown)) } catch { /* report only */ }
    return r
  }).catch(($, e, next) => next(e))

  // Kept registered although they did not reach a mod live on 2.1.294-2.1.295 (see the README): a later engine that
  // delivers them adds rows with no change here.
  on('classic.StopFailure', ($, e, next) => {
    try { signal($, 'api_error', wordValue((e as { error?: string }).error)) } catch { /* report only */ }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', ($, e, next) => {
    try { signal($, 'notice', wordValue((e as { notification_type?: string }).notification_type)) } catch { /* report only */ }
    return next(e)
  }).catch(($, e, next) => next(e))

  // the 5-hour / weekly window fill and the context fill, when a whole point moves
  on('session.measure', ($, e, next) => {
    try {
      for (const w of e.rateLimits ?? []) {
        const name = quotaSignal(String(w.kind))
        if (name) signal($, name, numberValue(w.percentUsed))
      }
      signal($, 'context', numberValue(e.context?.percent))
    } catch { /* report only */ }
    return next(e)
  })

  // session.end has a short bound: the last snapshot and log lines are awaited up to 1 s, not queued
  on('session.end', async ($, e, next) => {
    try {
      if (heartbeat) { heartbeat.cancel(); heartbeat = null }
      if (snap) {
        const reason = wordValue(e.reason)
        snap.signals['session_end'] = { value: reason, at_ms: now() }
        log({ kind: 'signal', signal: 'session_end', value: reason })
        snap.state = 'ended'; snap.tool = null; snap.state_since_ms = now(); snap.heartbeat_ms = now()
        log({ kind: 'state', state: 'ended', tool: null })
        snapDirty = true
        logDue = true
        if (!inFlight) {
          inFlight = true
          await Promise.race([
            Promise.resolve().then(() => writeOnce($)).catch(() => undefined),
            Promise.resolve().then(() => $.clock.sleep(SESSION_END_BUDGET_MS)).catch(() => undefined),   // no Node timers in a mod
          ])
          inFlight = false
        }
      }
    } catch { /* report only */ }
    return next(e)
  })
}
