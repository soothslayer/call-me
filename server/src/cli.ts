#!/usr/bin/env bun

/**
 * CallMe CLI
 *
 * Standalone driver for CallMe phone calls — no MCP client required.
 * Lets any shell-capable agent (Muse, cron jobs, plain scripts) phone the user.
 *
 * Startup mirrors server/src/index.ts (the MCP server path is untouched).
 *
 * Usage:
 *   bun run src/cli.ts --message "Hey! Your build finished."
 *   bun run src/cli.ts --message "Quick question" --goodbye "Talk soon!" --interactive
 *
 * Environment variables are the same CALLME_* vars documented in the README.
 * Human-readable logs go to stderr; the call transcript goes to stdout.
 */

import { CallManager, loadServerConfig } from './phone-call.js';
import { startNgrok, stopNgrok } from './ngrok.js';
import { ensureKokoroRunning } from './providers/tts-kokoro.js';
import { loadProviderConfig } from './providers/index.js';
import * as readline from 'node:readline';

function printUsage(): void {
  console.error(`CallMe CLI — phone the user without an MCP client.

Usage:
  bun run src/cli.ts --message <text> [--goodbye <text>] [--interactive]

Options:
  --message <text>    What to say when the call connects (required).
  --goodbye <text>    Closing line before hanging up (default: "Goodbye!").
  --interactive       After the first reply, keep prompting on stdin for
                      follow-ups. Empty line ends the call.
  --help              Show this help.

The user's spoken replies are printed to stdout, so a calling agent can
capture and act on them. Set CALLME_TRANSCRIPT_TIMEOUT_MS to bound how
long each listen waits (default 180000 ms).
`);
}

function parseArgs(argv: string[]): { message: string; goodbye: string; interactive: boolean } {
  let message: string | null = null;
  let goodbye = 'Goodbye!';
  let interactive = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg === '--message' && i + 1 < argv.length) {
      message = argv[++i];
    } else if (arg.startsWith('--message=')) {
      message = arg.slice('--message='.length);
    } else if (arg === '--goodbye' && i + 1 < argv.length) {
      goodbye = argv[++i];
    } else if (arg.startsWith('--goodbye=')) {
      goodbye = arg.slice('--goodbye='.length);
    } else if (arg === '--interactive') {
      interactive = true;
    } else {
      console.error(`Unknown argument: ${arg}\n`);
      printUsage();
      process.exit(1);
    }
  }

  if (!message) {
    console.error('Error: --message is required.\n');
    printUsage();
    process.exit(1);
  }

  return { message, goodbye, interactive };
}

async function main() {
  const { message, goodbye, interactive } = parseArgs(process.argv.slice(2));

  // --- Startup (mirrors index.ts) ---
  const port = parseInt(process.env.CALLME_PORT || '0', 10);

  const providerConfig = loadProviderConfig();
  if (providerConfig.ttsProvider === 'kokoro' && !providerConfig.kokoroUrl) {
    try {
      const kokoroBaseUrl = await ensureKokoroRunning();
      process.env.CALLME_KOKORO_URL = `${kokoroBaseUrl}/v1`;
    } catch (error) {
      console.error('Kokoro setup failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  let serverConfig;
  try {
    serverConfig = loadServerConfig('');
  } catch (error) {
    console.error('Configuration error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  const callManager = new CallManager(serverConfig);
  let actualPort: number;
  try {
    actualPort = await callManager.startServer();
  } catch (error) {
    console.error('Failed to start HTTP server:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  console.error('Starting ngrok tunnel...');
  try {
    const publicUrl = await startNgrok(actualPort, (newUrl) => {
      console.error(`[ngrok] Updating public URL to: ${newUrl}`);
      callManager.setPublicUrl(newUrl);
    });
    callManager.setPublicUrl(publicUrl);
    console.error(`ngrok tunnel: ${publicUrl}`);
  } catch (error) {
    console.error('Failed to start ngrok:', error instanceof Error ? error.message : error);
    await callManager.shutdown();
    process.exit(1);
  }

  const shutdown = async (exitCode = 0): Promise<never> => {
    await callManager.shutdown();
    await stopNgrok();
    process.exit(exitCode);
  };
  process.on('SIGINT', () => shutdown(130));
  process.on('SIGTERM', () => shutdown(143));

  // --- Call flow ---
  let callId: string;
  try {
    console.error(`Calling ${serverConfig.userPhoneNumber}...`);
    const result = await callManager.initiateCall(message);
    callId = result.callId;
    console.log(`USER: ${result.response}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes('hung up')) {
      console.error('User hung up during the greeting.');
      await shutdown(0);
    }
    console.error(`Call failed: ${msg}`);
    await shutdown(1);
  }

  if (interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      for (;;) {
        const line: string = await new Promise((resolve) => rl.question('you> ', resolve));
        if (!line.trim()) break;
        try {
          const response = await callManager.continueCall(callId!, line);
          console.log(`USER: ${response}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.toLowerCase().includes('hung up')) {
            console.error('User hung up.');
            break;
          }
          throw error;
        }
      }
    } finally {
      rl.close();
    }
  }

  try {
    const { durationSeconds } = await callManager.endCall(callId!, goodbye);
    console.error(`Call ended. Duration: ${durationSeconds}s`);
  } catch (error) {
    console.error('Call already ended.');
  }

  await shutdown(0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
