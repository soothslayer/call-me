/**
 * Agent backends for inbound calls.
 *
 * Each turn of the phone conversation is sent to the chosen CLI agent in
 * non-interactive mode, with the full conversation history in the prompt.
 * The agent's final message is spoken back to the caller.
 */

import { unlink } from 'node:fs/promises';

export type AgentBackend = 'claude-code' | 'codex' | 'hermes' | 'omarchy';

export const AGENT_BACKENDS: AgentBackend[] = ['claude-code', 'codex', 'hermes', 'omarchy'];

export function isAgentBackend(value: string): value is AgentBackend {
  return (AGENT_BACKENDS as string[]).includes(value);
}

/**
 * Whether runAgentTurnStream can drive this backend. Claude and Codex both
 * emit newline-delimited JSON we can parse incrementally; `hermes -z` only
 * prints its final reply, so it has to go through runAgentTurn. Omarchy is
 * Claude over ssh, and stays on the blocking path until streaming has been
 * verified end to end through the tunnel.
 */
export function supportsStreaming(backend: AgentBackend): boolean {
  return backend === 'claude-code' || backend === 'codex';
}

export function backendLabel(backend: AgentBackend): string {
  if (backend === 'claude-code') return 'Claude Code';
  if (backend === 'hermes') return 'Hermes';
  if (backend === 'omarchy') return 'Omarchy';
  return 'Codex';
}

export interface AgentTurnOptions {
  /** Wall-clock timeout per turn in ms (default: 120000). */
  timeoutMs?: number;
  /** Working directory for the agent subprocess (default: process.cwd()). */
  cwd?: string;
  /** Max characters of the agent's reply to speak (default: 1200). */
  maxReplyChars?: number;
  /** Caller's name for the prompt (default: "the caller"). */
  callerName?: string;
  /** Aborting kills the agent subprocess (caller said "stop"). */
  signal?: AbortSignal;
}

export type ConversationHistory = Array<{ speaker: 'user' | 'agent'; message: string }>;

/**
 * Build the prompt for one conversational turn. Emphasizes short,
 * speakable replies since the output goes through text-to-speech.
 */
export function buildAgentPrompt(
  backend: AgentBackend,
  history: ConversationHistory,
  userMessage: string,
  callerName: string = 'the caller'
): string {
  const caller = callerName;
  const lines = [
    `You are ${backendLabel(backend)}, speaking with ${caller} on a phone call.`,
    'Keep every reply SHORT and conversational — it will be read aloud by text-to-speech.',
    'No markdown formatting, no code blocks, no bullet lists, no headers. Plain spoken sentences only.',
    'If they ask you to do something on the computer, do it if your tools allow, then say in one or two short sentences what you did. Never read commands or code aloud.',
    '',
    'Conversation so far:',
  ];
  for (const turn of history) {
    const who = turn.speaker === 'user' ? caller : 'You';
    lines.push(`${who}: ${turn.message}`);
  }
  lines.push(`${caller}: ${userMessage}`);
  lines.push('You:');
  return lines.join('\n');
}

/**
 * Run one agent turn and return the spoken reply.
 * Throws on timeout or subprocess failure.
 */
export async function runAgentTurn(
  backend: AgentBackend,
  history: ConversationHistory,
  userMessage: string,
  options: AgentTurnOptions = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 120000;
  const maxReplyChars = options.maxReplyChars ?? 1200;
  const cwd = options.cwd ?? process.cwd();
  const prompt = buildAgentPrompt(backend, history, userMessage, options.callerName);

  let stdout: string;
  if (backend === 'claude-code') {
    // Extra CLI flags, e.g. CALLME_CLAUDE_EXTRA_ARGS="--dangerously-skip-permissions"
    const extraArgs = (process.env.CALLME_CLAUDE_EXTRA_ARGS || '').split(/\s+/).filter(Boolean);
    stdout = await runSubprocess('claude', [...extraArgs, '-p', prompt], { timeoutMs, cwd, signal: options.signal });
  } else if (backend === 'hermes') {
    // One-shot mode prints only the final reply. Extra flags, e.g.
    // CALLME_HERMES_EXTRA_ARGS="--yolo" to skip command approval prompts
    const extraArgs = (process.env.CALLME_HERMES_EXTRA_ARGS || '').split(/\s+/).filter(Boolean);
    stdout = await runSubprocess('hermes', [...extraArgs, '-z', prompt], { timeoutMs, cwd, signal: options.signal });
  } else if (backend === 'omarchy') {
    const [command, ...args] = omarchyCommand(prompt);
    try {
      stdout = await runSubprocess(command, args, { timeoutMs, cwd, signal: options.signal });
    } catch (error) {
      // The VM's Claude has its own login. Say so, rather than the generic
      // "hit a snag", since nothing on the phone can fix it.
      if (!(error instanceof Error && /not logged in/i.test(error.message))) throw error;
      stdout = "Claude in the Omarchy VM isn't logged in yet. Someone needs to log in there first.";
    }
  } else {
    // -o writes only the final agent message to a file (keeps the live
    // action log on stderr out of the reply). read-only sandbox avoids
    // approval prompts stalling the call. stdin is closed so codex never
    // blocks waiting for input.
    const outFile = `/tmp/callme-codex-${process.pid}-${Date.now()}.txt`;
    try {
      await runSubprocess(
        'codex',
        ['exec', '-o', outFile, '--skip-git-repo-check', '-s', 'read-only', '--color', 'never', prompt],
        { timeoutMs, cwd, signal: options.signal }
      );
      stdout = await Bun.file(outFile).text();
    } finally {
      try { await unlink(outFile); } catch { /* ignore */ }
    }
  }

  const cleaned = cleanSpokenReply(stdout, maxReplyChars);
  if (!cleaned) {
    throw new Error(`${backendLabel(backend)} returned an empty reply`);
  }
  return cleaned;
}

/** Quote one word for a POSIX shell, so ssh can't split or expand it. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * argv for an Omarchy turn: Claude Code inside the Omarchy VM, over ssh.
 *
 *   CALLME_OMARCHY_HOST      user@host to ssh to (e.g. buck@192.168.68.64)
 *   CALLME_OMARCHY_SSH_ARGS  extra ssh flags (e.g. -i ~/.ssh/id_ed25519)
 *   CALLME_OMARCHY_COMMAND   remote command; the prompt is appended as -p '...'
 *
 * ssh joins its arguments into one string for the remote shell, so the
 * prompt has to be quoted for that shell, not just passed as an argv entry.
 * BatchMode makes a missing key fail fast instead of waiting on a password
 * prompt nobody on the phone can answer.
 */
export function omarchyCommand(prompt: string): string[] {
  const host = process.env.CALLME_OMARCHY_HOST;
  if (!host) throw new Error('CALLME_OMARCHY_HOST is not set');
  const sshArgs = (process.env.CALLME_OMARCHY_SSH_ARGS || '').split(/\s+/).filter(Boolean);
  const remote =
    process.env.CALLME_OMARCHY_COMMAND || '~/.local/bin/claude --dangerously-skip-permissions';
  return [
    'ssh',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    ...sshArgs,
    host,
    `${remote} -p ${shellQuote(prompt)}`,
  ];
}

/**
 * Make raw agent output safe for TTS: strip code fences, collapse
 * whitespace, and truncate to a speakable length.
 */
export function cleanSpokenReply(raw: string, maxChars: number): string {
  let text = raw
    .replace(/```[\s\S]*?```/g, ' ')   // fenced code blocks
    .replace(/`([^`]+)`/g, '$1')        // inline code
    .replace(/^#{1,6}\s+/gm, '')        // markdown headers
    .replace(/[*_~]{1,3}/g, '')         // emphasis markers
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).trimEnd() + '…';
  }
  return text;
}

interface SubprocessOptions {
  timeoutMs: number;
  cwd: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Streaming turns: agent stdout (JSONL) -> sentences -> TTS
//
// Both CLIs can emit their reply incrementally as newline-delimited JSON:
//   claude -p --output-format stream-json   (one JSON object per line)
//   codex exec --json                       (JSONL events)
// We parse partial text, split it into sentences, and yield each sentence as
// soon as it completes so TTS/playback starts before the agent finishes.
// If a CLI only emits its reply at the end, this degrades gracefully to the
// old behavior (one chunk at process exit).
// ---------------------------------------------------------------------------

/** Abbreviations that must not end a sentence. */
const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'vs', 'etc', 'e.g', 'i.e',
  'no', 'fig', 'approx', 'dept', 'est', 'inc', 'ltd', 'co', 'gov',
]);

/**
 * Split off complete sentences, returning the unconsumed tail.
 *
 * `final` matters: mid-stream, the end of the buffer is NOT a sentence end,
 * because more text is probably coming. Treating it as one splits numbers at
 * delta boundaries — "macOS version 26.6.2" arrived as "...version 26." then
 * "6.2.", and was spoken as two sentences. Only the end-of-turn flush may
 * treat a trailing period as terminal.
 */
function splitSentences(text: string, final: boolean): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  // Sentence end: . ! ? (optionally quoted/parenthesized), followed by
  // whitespace + capital/digit/quote/paren — plus, at end of turn only,
  // trailing whitespace + end of string.
  const re = final
    ? /[.!?]+["'”’)\]]?(?=\s+[A-Z0-9"“"(\[]|\s*$)/g
    : /[.!?]+["'”’)\]]?(?=\s+[A-Z0-9"“"(\[])/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const punct = m[0];
    // Abbreviation guard: word immediately before the punctuation.
    const word = text.slice(lastIndex, m.index).match(/([A-Za-z.]{1,6})$/)?.[1]?.toLowerCase();
    if (punct[0] === '.' && word && ABBREV.has(word)) continue;
    const s = text.slice(lastIndex, m.index + punct.length).trim().replace(/\s+/g, ' ');
    if (s) sentences.push(s);
    lastIndex = m.index + punct.length;
  }
  return { sentences, rest: text.slice(lastIndex) };
}

/**
 * Accumulates streamed text deltas and emits complete sentences.
 * Suppresses fenced code blocks (the voice prompt forbids them, but the
 * model sometimes emits them anyway — never read code aloud).
 */
export class SentenceBuffer {
  private buf = '';

  /** Push a text delta; returns newly completed sentences. */
  push(delta: string): string[] {
    this.buf += delta;
    // Drop complete fenced blocks; hold everything from an unclosed fence.
    const b = this.buf.replace(/```[\s\S]*?```/g, ' ');
    const fenceIdx = b.indexOf('```');
    const held = fenceIdx === -1 ? '' : b.slice(fenceIdx);
    const processable = fenceIdx === -1 ? b : b.slice(0, fenceIdx);

    const { sentences, rest } = splitSentences(processable, false);

    // Force-flush very long unpunctuated runs at a word boundary so a
    // run-on reply can't stall playback indefinitely.
    let r = rest;
    const forced: string[] = [];
    while (r.length > 400) {
      const cut = r.lastIndexOf(' ', 400);
      if (cut <= 0) break;
      forced.push(r.slice(0, cut).trim());
      r = r.slice(cut + 1);
    }

    this.buf = (r + held).replace(/ {2,}/g, ' ');
    return [...sentences, ...forced];
  }

  /** Emit whatever remains (end of turn). */
  flush(): string[] {
    const b = this.buf
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/```[\s\S]*$/g, '');
    const { sentences, rest } = splitSentences(b, true);
    const tail = rest.trim().replace(/\s+/g, ' ');
    return tail ? [...sentences, tail] : sentences;
  }
}

/** Per-turn parser state: text seen so far, and whether deltas are flowing. */
interface StreamState {
  seen: string;
  streamed?: boolean;
}

/** Cumulative-diff: turn a cumulative text payload into the new delta. */
function diffCumulative(st: StreamState, text: string): string | null {
  if (!text || text === st.seen) return null;
  const delta = text.startsWith(st.seen) ? text.slice(st.seen.length) : text;
  st.seen = text;
  return delta || null;
}

/** Extract new text from a claude -p --output-format stream-json event. */
export function extractClaudeText(evt: any, st: StreamState): string | null {
  // --include-partial-messages wraps the raw API stream in {type:"stream_event",
  // event:{...}}. content_block_delta/text_delta is the incremental text, and
  // it's the only shape that actually arrives mid-generation; the "assistant"
  // event below carries the whole message and lands at the end.
  if (evt?.type === 'stream_event') {
    const inner = evt.event;
    if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
      const t = inner.delta.text;
      if (typeof t === 'string' && t) {
        st.seen += t; // deltas are incremental, not cumulative
        st.streamed = true;
        return t;
      }
    }
    return null;
  }
  // Once deltas are flowing, the complete "assistant" messages are redundant.
  // On a turn with tool calls there is one per message, and each would
  // re-emit text we already spoke, so ignore them entirely.
  if (st.streamed && evt?.type === 'assistant') return null;
  if (evt?.type === 'assistant') {
    const blocks = evt.message?.content;
    if (Array.isArray(blocks)) {
      const text = blocks
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text ?? '')
        .join('');
      return diffCumulative(st, text);
    }
    return null;
  }
  if (evt?.type === 'result' && typeof evt.result === 'string') {
    // Fallback: if we never saw assistant text, use the final result.
    if (!st.seen) return diffCumulative(st, evt.result);
  }
  return null;
}

/** Extract new text from a codex exec --json event (defensive: schema varies). */
export function extractCodexText(evt: any, st: StreamState): string | null {
  const item = evt?.item;
  if (item?.type === 'agent_message' && typeof item.text === 'string') {
    return diffCumulative(st, item.text);
  }
  // Possible delta-style shapes in newer versions.
  const deltaText =
    (evt?.delta?.type === 'text' && evt.delta.text) ||
    (item?.delta?.type === 'text' && item.delta.text) ||
    undefined;
  if (typeof deltaText === 'string' && deltaText) {
    const out = deltaText;
    st.seen += out; // deltas are incremental, not cumulative
    return out;
  }
  return null;
}

/** Light per-sentence cleanup for TTS (fences already stripped by SentenceBuffer). */
function lightCleanSentence(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function* readLines(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      yield buf.slice(0, idx);
      buf = buf.slice(idx + 1);
    }
  }
  buf += decoder.decode();
  if (buf) yield buf;
}

/**
 * Run one agent turn, yielding speakable sentences as the agent produces
 * them. Throws if the agent produces no text or the backend binary fails.
 */
export async function* runAgentTurnStream(
  backend: AgentBackend,
  history: ConversationHistory,
  userMessage: string,
  options: AgentTurnOptions = {}
): AsyncGenerator<string> {
  const timeoutMs = options.timeoutMs ?? 120000;
  const maxChars = options.maxReplyChars ?? 1200;
  const cwd = options.cwd ?? process.cwd();
  const prompt = buildAgentPrompt(backend, history, userMessage, options.callerName);

  if (!supportsStreaming(backend)) {
    // hermes -z has no JSONL mode, and omarchy is unverified over ssh;
    // callers should check supportsStreaming()
    // and use runAgentTurn instead. Guard so a future backend can't silently
    // get spawned as the wrong binary.
    throw new Error(`${backendLabel(backend)} does not support streaming`);
  }

  const command = backend === 'claude-code' ? 'claude' : 'codex';
  const args =
    backend === 'claude-code'
      ? [
          // Same extra flags as the non-streaming path — without these the
          // phone turn loses --dangerously-skip-permissions and the MCP trim.
          ...(process.env.CALLME_CLAUDE_EXTRA_ARGS || '').split(/\s+/).filter(Boolean),
          '-p',
          // --verbose is REQUIRED with --output-format=stream-json under
          // --print; without it claude exits immediately with an error on
          // stderr and an empty stdout. --include-partial-messages is what
          // makes the reply arrive as text deltas rather than one block at
          // the end, which is the entire point of streaming.
          '--verbose',
          '--include-partial-messages',
          '--output-format',
          'stream-json',
          prompt,
        ]
      : ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '--color', 'never', prompt];

  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdin: 'ignore', // closed stdin: agents must never block waiting for input
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });

  const st: StreamState = { seen: '' };
  const sentences = new SentenceBuffer();
  const stderrChunks: Buffer[] = [];
  let emittedChars = 0;
  let gotText = false;
  let timedOut = false;

  const killTimer = setTimeout(() => {
    timedOut = true;
    console.error(`[backend] ${command} timed out after ${timeoutMs}ms, killing`);
    try { proc.kill('SIGKILL'); } catch { /* already exited */ }
  }, timeoutMs);

  // The caller said "stop": kill the agent so it isn't left running after we
  // stop reading. Matches runSubprocess's behaviour.
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    console.error(`[backend] ${command} stopped by caller, killing`);
    try { proc.kill('SIGTERM'); } catch { /* already exited */ }
  };
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const drainStderr = (async () => {
    for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) {
      stderrChunks.push(Buffer.from(chunk));
    }
  })();

  try {
    for await (const line of readLines(proc.stdout as AsyncIterable<Uint8Array>)) {
      const t = line.trim();
      if (!t.startsWith('{')) continue; // skip human-readable headers
      let evt: any;
      try {
        evt = JSON.parse(t);
      } catch {
        continue;
      }
      const delta =
        backend === 'claude-code' ? extractClaudeText(evt, st) : extractCodexText(evt, st);
      if (!delta) continue;
      gotText = true;
      for (const s of sentences.push(delta)) {
        if (emittedChars >= maxChars) break;
        const clean = lightCleanSentence(s);
        if (!clean) continue;
        emittedChars += clean.length;
        yield clean;
      }
      if (emittedChars >= maxChars) break;
    }

    for (const s of sentences.flush()) {
      if (emittedChars >= maxChars) break;
      const clean = lightCleanSentence(s);
      if (!clean) continue;
      emittedChars += clean.length;
      yield clean;
    }
  } finally {
    clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', onAbort);
    try { proc.kill('SIGKILL'); } catch { /* already exited */ }
    await proc.exited.catch(() => {});
    await drainStderr;
    const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
    if (stderr) {
      console.error(`[backend] ${command} stderr (last 500 chars): ${stderr.slice(-500)}`);
    }
  }

  if (timedOut) {
    console.error(`[backend] ${command} turn timed out (partial reply was streamed)`);
  }
  // A stopped turn legitimately produces nothing; don't turn that into an
  // error the caller would hear as an apology.
  if (!gotText && !aborted) {
    throw new Error(`${backendLabel(backend)} produced no text output`);
  }
}

async function runSubprocess(
  command: string,
  args: string[],
  options: SubprocessOptions
): Promise<string> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    stdin: 'ignore',   // closed stdin: agents must never block waiting for input
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutReader = (async () => {
    for await (const chunk of proc.stdout) stdoutChunks.push(Buffer.from(chunk));
  })();
  const stderrReader = (async () => {
    for await (const chunk of proc.stderr) stderrChunks.push(Buffer.from(chunk));
  })();

  const timeout = setTimeout(() => {
    console.error(`[backend] ${command} timed out after ${options.timeoutMs}ms, killing`);
    proc.kill('SIGKILL');
  }, options.timeoutMs);

  const onAbort = () => {
    console.error(`[backend] ${command} stopped by caller, killing`);
    proc.kill('SIGTERM');
  };
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
  await Promise.all([stdoutReader, stderrReader]);

  const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
  const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
  if (stderr) {
    // Progress / action log — useful for debugging, never spoken.
    console.error(`[backend] ${command} stderr (last 500 chars): ${stderr.slice(-500)}`);
  }

  if (exitCode !== 0) {
    // claude -p reports some failures ("Not logged in") on stdout, not stderr.
    const detail = stderr || stdout.trim();
    throw new Error(`${command} exited with code ${exitCode}: ${detail.slice(-300)}`);
  }
  return stdout;
}
