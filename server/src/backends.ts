/**
 * Agent backends for inbound calls.
 *
 * Each turn of the phone conversation is sent to the chosen CLI agent in
 * non-interactive mode, with the full conversation history in the prompt.
 * The agent's final message is spoken back to the caller.
 */

import { unlink } from 'node:fs/promises';

export type AgentBackend = 'claude-code' | 'codex';

export const AGENT_BACKENDS: AgentBackend[] = ['claude-code', 'codex'];

export function isAgentBackend(value: string): value is AgentBackend {
  return (AGENT_BACKENDS as string[]).includes(value);
}

export function backendLabel(backend: AgentBackend): string {
  return backend === 'claude-code' ? 'Claude Code' : 'Codex';
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
    stdout = await runSubprocess('claude', [...extraArgs, '-p', prompt], { timeoutMs, cwd });
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
        { timeoutMs, cwd }
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

  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timeout);
  }
  await Promise.all([stdoutReader, stderrReader]);

  const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
  const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
  if (stderr) {
    // Progress / action log — useful for debugging, never spoken.
    console.error(`[backend] ${command} stderr (last 500 chars): ${stderr.slice(-500)}`);
  }

  if (exitCode !== 0) {
    throw new Error(`${command} exited with code ${exitCode}: ${stderr.slice(-300)}`);
  }
  return stdout;
}
