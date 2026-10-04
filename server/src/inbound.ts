#!/usr/bin/env bun
/**
 * call-me inbound mode: dial your Telnyx number and talk to an agent.
 *
 * Answers incoming calls on your Telnyx number and bridges the caller into a
 * voice conversation with Claude Code or Codex. Each turn: your speech is
 * transcribed, sent to the agent CLI in non-interactive mode (with full
 * conversation history), and the agent's reply is spoken back.
 *
 * Usage:
 *   bun run inbound --backend claude-code
 *   bun run inbound --backend codex --greeting "Hey! Codex here."
 *
 * Security: by default only CALLME_USER_PHONE_NUMBER may call in. Extra
 * numbers via CALLME_INBOUND_ALLOW_FROM (comma-separated E.164). Set
 * CALLME_INBOUND_ALLOW_FROM to empty to allow any caller (not recommended).
 */

import { CallManager, loadServerConfig } from './phone-call.js';
import { startNgrok, stopNgrok } from './ngrok.js';
import {
  AGENT_BACKENDS,
  isAgentBackend,
  backendLabel,
  runAgentTurn,
  runAgentTurnStream,
  supportsStreaming,
  type AgentBackend,
  type ConversationHistory,
} from './backends.js';

interface InboundArgs {
  backend: AgentBackend;
  greeting: string;
  farewell: string;
  backendTimeoutMs: number;
  cwd: string;
  noStream: boolean;
  help: boolean;
}

function printHelp(): void {
  console.log(`
call-me inbound mode — dial your Telnyx number and talk to an agent.

Usage:
  bun run inbound --backend <claude-code|codex|hermes> [options]

Options:
  --backend <name>        Agent to talk to: claude-code or codex (required)
  --greeting <text>       Spoken when the call is answered
  --farewell <text>       Spoken before hanging up
  --backend-timeout-ms N  Max ms to wait for the agent per turn (default: 120000)
  --cwd <dir>             Working directory for the agent subprocess
                          (default: current directory)
  --no-stream             Wait for the agent's full reply before speaking
                          (default: stream sentences as the agent produces
                          them, for lower perceived latency)
  --help                  Show this help

Environment:
  Same CALLME_* variables as the MCP server / CLI (see README), plus:
  CALLME_BARGE_IN             true (default) lets the caller interrupt the agent
                              mid-sentence; false turns that off.
  CALLME_INBOUND_MENU         Comma-separated agents (e.g. claude-code,hermes).
                              Callers to an unrouted number are asked which
                              one they want, and can say "switch to ..." later.
  CALLME_INBOUND_ROUTES       Comma-separated number=agent pairs, so each dialed
                              number reaches its own agent. Others use --backend.
  CALLME_HERMES_EXTRA_ARGS    Extra flags for the hermes CLI (e.g. --yolo).
  CALLME_INBOUND_PIN          If set, callers must say this PIN before reaching
                              the agent (3 tries, then hang up).
  CALLME_CLAUDE_EXTRA_ARGS    Extra flags for the claude CLI, space-separated
                              (e.g. --dangerously-skip-permissions).
  CALLME_CALLER_NAMES         Comma-separated number=name pairs, so each caller
                              is greeted by name (e.g. +15551234567=Alice).
  CALLME_INBOUND_ALLOW_FROM   Comma-separated E.164 numbers allowed to call in.
                              Defaults to CALLME_USER_PHONE_NUMBER (just you).
  CALLME_STT_PROMPT           Vocabulary hint for the transcriber. Defaults to
                              naming the agents, which is what lets a one-word
                              "Claude" survive the phone codec.

Setup:
  1. In the Telnyx portal, point your number's Voice API application webhook
     at https://<your-ngrok-url>/twiml (same URL the outbound mode uses).
  2. Run this command, then dial your Telnyx number (CALLME_PHONE_NUMBER).
  3. Say "goodbye" (or hang up) to end the call.

Notes:
  - Codex runs with a read-only sandbox so approval prompts can't stall a call.
  - Claude Code follows your normal CLI permissions for tool use.
  - Each agent turn spawns a fresh non-interactive run; conversation history
    is carried in the prompt.
`);
}

function parseArgs(args: string[]): InboundArgs {
  const result: InboundArgs = {
    backend: '' as AgentBackend,
    greeting: '',
    farewell: 'Talk soon!',
    backendTimeoutMs: 120000,
    cwd: process.cwd(),
    noStream: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        result.help = true;
        break;
      case '--backend':
        result.backend = args[++i] as AgentBackend;
        break;
      case '--greeting':
        result.greeting = args[++i];
        break;
      case '--farewell':
        result.farewell = args[++i];
        break;
      case '--backend-timeout-ms':
        result.backendTimeoutMs = parseInt(args[++i], 10);
        break;
      case '--cwd':
        result.cwd = args[++i];
        break;
      case '--no-stream':
        result.noStream = true;
        break;
      default:
        if (arg.startsWith('--backend=')) result.backend = arg.slice('--backend='.length) as AgentBackend;
        else if (arg.startsWith('--greeting=')) result.greeting = arg.slice('--greeting='.length);
        else if (arg.startsWith('--farewell=')) result.farewell = arg.slice('--farewell='.length);
        else if (arg.startsWith('--cwd=')) result.cwd = arg.slice('--cwd='.length);
        else {
          console.error(`Unknown argument: ${arg}`);
          printHelp();
          process.exit(1);
        }
    }
  }
  return result;
}

/** Normalize a phone number for comparison (digits only). */
function normalizeNumber(n: string): string {
  return n.replace(/\D/g, '');
}

function allowedCallers(): string[] | null {
  // null = allow everyone (explicit opt-in via empty env var)
  const raw = process.env.CALLME_INBOUND_ALLOW_FROM;
  if (raw !== undefined) {
    const list = raw.split(',').map((s) => normalizeNumber(s.trim())).filter(Boolean);
    return list.length > 0 ? list : null;
  }
  const mine = process.env.CALLME_USER_PHONE_NUMBER;
  return mine ? [normalizeNumber(mine)] : [];
}

/**
 * Parse CALLME_CALLER_NAMES ("+15551234567=Alice,+15557654321=Bob") into
 * a digits-only number -> name map, used to greet each caller by name.
 */
function callerNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const entry of (process.env.CALLME_CALLER_NAMES || '').split(',')) {
    const [num, name] = entry.split('=').map((s) => s.trim());
    if (num && name) names.set(normalizeNumber(num), name);
  }
  return names;
}

/**
 * Parse CALLME_INBOUND_ROUTES ("+15551234567=claude-code,+15557654321=hermes")
 * so each dialed number reaches its own agent. Unlisted numbers use --backend.
 */
function numberRoutes(): Map<string, AgentBackend> {
  const routes = new Map<string, AgentBackend>();
  for (const entry of (process.env.CALLME_INBOUND_ROUTES || '').split(',')) {
    const [num, backend] = entry.split('=').map((s) => s.trim());
    if (!num || !backend) continue;
    if (!isAgentBackend(backend)) {
      console.error(`Warning: CALLME_INBOUND_ROUTES has unknown agent "${backend}", ignoring`);
      continue;
    }
    routes.set(normalizeNumber(num), backend);
  }
  return routes;
}

/** Short spoken name for the menu ("Say Claude or Hermes"). */
function shortName(backend: AgentBackend): string {
  return backend === 'claude-code' ? 'Claude' : backendLabel(backend);
}

/** How each agent's name tends to come back from speech-to-text. */
const AGENT_NAME_RE: Record<AgentBackend, RegExp> = {
  'claude-code': /\b(claude|cloud|clawed|clod|claud)\b/i,
  hermes: /\b(hermes|herm[eè]s|her ?mees|her ?mess|hermis|hermies)\b/i,
  codex: /\b(codex|code ?x)\b/i,
};

/**
 * Looser patterns for the menu step only. A one-word answer over a phone
 * codec is the worst case for STT: "Claude" was observed coming back as
 * "Bob", "blob", "klob", "odd", "quad" and "Blob code." At the menu the only
 * choices are these agents, so a false positive is harmless — but failing to
 * match leaves the caller stuck re-saying one word. Not used for mid-call
 * switching, where AGENT_NAME_RE stays strict.
 */
const AGENT_MENU_RE: Record<AgentBackend, RegExp> = {
  'claude-code':
    /\b(claude|claud|clause|cloud|clawed|claw|clod|cod|code|coad|bob|blob|klob|clob|glob|odd|aud|quad|laud|lord|flawed|fraud|god)\b/i,
  hermes: /\b(hermes|herm[eè]s|her ?mees|her ?mess|hermis|hermies|herpes|hermeez|harmies)\b/i,
  codex: /\b(codex|code ?x|kodex)\b/i,
};

/** Which menu agent, if any, the caller named. */
function pickAgent(transcript: string, menu: AgentBackend[]): AgentBackend | undefined {
  return menu.find((b) => AGENT_NAME_RE[b].test(transcript));
}

/**
 * Menu selection: the agent's name (loosely matched), or its position in the
 * menu as a digit — "one", "1", "two". Digits survive the phone codec far
 * better than a single proper noun, so they're the fallback we offer after a
 * failed attempt.
 */
function pickMenuAgent(transcript: string, menu: AgentBackend[]): AgentBackend | undefined {
  const byName = menu.find((b) => AGENT_MENU_RE[b].test(transcript));
  if (byName) return byName;
  const digits = spokenDigits(transcript);
  if (digits.length === 1) {
    const idx = Number(digits) - 1;
    if (idx >= 0 && idx < menu.length) return menu[idx];
  }
  return undefined;
}

/** "Switch to Hermes", "talk to Claude", "give me Hermes" mid-call. */
const SWITCH_RE = /\b(switch|talk|go|change|put me through|connect me|give me|transfer)\b/i;

/**
 * Parse CALLME_INBOUND_MENU ("claude-code,hermes"): on numbers with no route,
 * the caller is asked which agent they want.
 */
function agentMenu(): AgentBackend[] {
  const menu: AgentBackend[] = [];
  for (const name of (process.env.CALLME_INBOUND_MENU || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (isAgentBackend(name)) menu.push(name);
    else console.error(`Warning: CALLME_INBOUND_MENU has unknown agent "${name}", ignoring`);
  }
  return menu;
}

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', to: '2', too: '2', three: '3',
  four: '4', for: '4', five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15',
  sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
  thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
};

/**
 * Turn a spoken PIN into digits. Handles "1234", "one two three four",
 * "twelve thirty four" and "12-34"; other words are ignored.
 */
function spokenDigits(transcript: string): string {
  return transcript
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w) => (/^\d+$/.test(w) ? w : DIGIT_WORDS[w] ?? ''))
    .join('');
}

const MAX_PIN_ATTEMPTS = 3;

const GOODBYE_RE = /^(goodbye|bye( bye)?|hang up|that'?s all|that'?s it|talk (to you )?later)\.?$/i;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!isAgentBackend(args.backend)) {
    console.error(`Error: --backend must be one of: ${AGENT_BACKENDS.join(', ')}\n`);
    printHelp();
    process.exit(1);
  }

  const names = callerNames();
  const pin = normalizeNumber(process.env.CALLME_INBOUND_PIN || '');
  const routes = numberRoutes();
  const menu = agentMenu();
  const menuPrompt = `Say ${menu.map(shortName).join(' or ')}.`;
  // After a miss, offer positions instead: single digits transcribe reliably
  // over a phone line where a bare name does not.
  const menuRetryPrompt = `Say ${menu.map((b, i) => `${i + 1} for ${shortName(b)}`).join(', or ')}.`;
  if (menu.length > 1) console.error(`Menu: unrouted numbers ask for ${menu.map(backendLabel).join(' or ')}`);
  const greetingFor = (name: string | undefined, backend: AgentBackend) =>
    args.greeting ||
    (pin
      ? `Hi${name ? ` ${name}` : ''}. Please say your PIN.`
      : `Hey${name ? ` ${name}` : ''}! You're talking to ${backendLabel(backend)}. What's on your mind?`);
  for (const [num, backend] of routes) console.error(`Route: calls to ...${num.slice(-4)} go to ${backendLabel(backend)}`);
  console.error(pin ? 'Inbound PIN: required' : 'Inbound PIN: not set (CALLME_INBOUND_PIN)');

  const allowList = allowedCallers();
  if (allowList === null) {
    console.error('Warning: CALLME_INBOUND_ALLOW_FROM is empty — ANY caller can talk to your agent.');
  } else {
    console.error(`Inbound allowlist: ${allowList.join(', ') || '(none — all calls will be rejected)'}`);
  }

  // Same startup path as the CLI: config, HTTP server, ngrok tunnel.
  const config = loadServerConfig('');
  const callManager = new CallManager(config);
  const port = await callManager.startServer();
  const publicUrl = await startNgrok(port);
  callManager.setPublicUrl(publicUrl);

  console.error(`\nInbound mode ready. Dial ${config.phoneNumber} to talk to ${backendLabel(args.backend)}.`);
  console.error('Press Ctrl+C to stop.\n');

  callManager.onInboundCall = async (callControlId: string, from: string, to: string) => {
    if (allowList !== null && !allowList.includes(normalizeNumber(from))) {
      console.error(`[inbound] Rejecting call from ${from} (not on allowlist)`);
      try {
        await config.providers.phone.hangup(callControlId);
      } catch (error) {
        console.error('[inbound] Failed to hang up rejected call:', error instanceof Error ? error.message : error);
      }
      return;
    }

    const callerName = names.get(normalizeNumber(from));
    const routed = routes.get(normalizeNumber(to));
    const useMenu = !routed && menu.length > 1;
    let backend = routed ?? args.backend;
    let chosen = !useMenu;
    console.error(`[inbound] Caller: ${callerName ?? 'unnamed'} (${from}), agent: ${useMenu ? 'menu' : backendLabel(backend)}`);

    let verified = !pin;
    let pinAttempts = 0;
    let menuMisses = 0;

    const ready = (b: AgentBackend) => `You're talking to ${backendLabel(b)}. What's on your mind?`;
    const choose = (b: AgentBackend, history: ConversationHistory) => {
      backend = b;
      chosen = true;
      hooks.thinkingNotice = `${backendLabel(b)} is thinking. Say stop to interrupt.`;
      history.length = 0;  // each agent starts the conversation fresh
      console.error(`[inbound] ${from} chose ${backendLabel(b)}`);
    };

    const hooks = {
      greeting: !pin && useMenu
        ? `Hi${callerName ? ` ${callerName}` : ''}. ${menuPrompt}`
        : greetingFor(callerName, backend),
      farewell: args.farewell,
      thinkingNotice: `${backendLabel(backend)} is thinking. Say stop to interrupt.`,
      stoppedNotice: 'Listening.',
      onUserMessage: async (transcript: string, history: ConversationHistory, signal: AbortSignal) => {
        const trimmed = transcript.trim();

        if (!verified) {
          // Keep the PIN out of the history that gets sent to the agent
          history.length = 0;
          if (spokenDigits(trimmed).includes(pin)) {
            verified = true;
            console.error(`[inbound] PIN accepted from ${from}`);
            return chosen ? `Thanks. ${ready(backend)}` : `Thanks. ${menuPrompt}`;
          }
          pinAttempts++;
          console.error(`[inbound] Wrong PIN from ${from} (attempt ${pinAttempts}/${MAX_PIN_ATTEMPTS})`);
          if (pinAttempts >= MAX_PIN_ATTEMPTS) {
            hooks.farewell = "Sorry, that's not right. Goodbye.";
            return null;
          }
          return "Sorry, that's not right. Please say your PIN again.";
        }

        if (GOODBYE_RE.test(trimmed)) {
          return null; // triggers farewell + hangup
        }

        if (!chosen) {
          const picked = pickMenuAgent(trimmed, menu);
          if (!picked) {
            history.length = 0;
            menuMisses += 1;
            console.error(`[inbound] menu: no match for ${JSON.stringify(trimmed)}`);
            return `Sorry. ${menuMisses === 1 ? menuPrompt : menuRetryPrompt}`;
          }
          choose(picked, history);
          return ready(picked);
        }

        // Mid-call switch, e.g. "switch to Hermes". Only short commands, so
        // "let's talk about cloud storage" isn't taken as a switch to Claude.
        if (useMenu && SWITCH_RE.test(trimmed) && trimmed.split(/\s+/).length <= 6) {
          const picked = pickAgent(trimmed, menu);
          if (picked && picked !== backend) {
            choose(picked, history);
            return `Switching. ${ready(picked)}`;
          }
        }

        // `backend`, not args.backend: the caller may have chosen from the
        // menu or switched agents mid-call.
        const turnOptions = {
          timeoutMs: args.backendTimeoutMs,
          cwd: args.cwd,
          callerName,
          signal,
        };
        // hermes has no JSONL mode, so it always takes the blocking path.
        if (args.noStream || !supportsStreaming(backend)) {
          try {
            return await runAgentTurn(backend, history, trimmed, turnOptions);
          } catch (error) {
            if (signal.aborted) return '';  // caller said stop; the call manager handles it
            console.error(`[inbound] Agent turn failed:`, error instanceof Error ? error.message : error);
            return "Sorry, I hit a snag on that one. What else is on your mind?";
          }
        }
        // Streaming: sentences are spoken as the agent produces them. A
        // failure before anything was spoken degrades to an apology; if the
        // caller said stop, stay silent and let the call manager handle it.
        return (async function* () {
          let yielded = false;
          try {
            for await (const sentence of runAgentTurnStream(backend, history, trimmed, turnOptions)) {
              yielded = true;
              yield sentence;
            }
          } catch (error) {
            if (signal.aborted) return;
            console.error(`[inbound] Agent stream failed:`, error instanceof Error ? error.message : error);
          }
          if (!yielded && !signal.aborted) {
            yield "Sorry, I hit a snag on that one. What else is on your mind?";
          }
        })();
      },
    };

    await callManager.runInboundConversation(callControlId, from, hooks);
  };

  const shutdown = async () => {
    console.error('\nShutting down...');
    await stopNgrok().catch(() => {});
    await callManager.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Run until killed.
  await new Promise(() => {});
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
