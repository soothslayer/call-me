/**
 * Tests for the inbound agent menu and the Omarchy backend.
 *
 * Run with `bun test`. "Omarchy" is not a word any transcriber knows, so
 * the menu has to accept the ways it comes back over a phone line.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  bareAgentName,
  menuPromptFor,
  menuRetryPromptFor,
  pickAgent,
  pickMenuAgent,
} from './inbound.js';
import { omarchyCommand, shellQuote, supportsStreaming, type AgentBackend } from './backends.js';

const MENU: AgentBackend[] = ['claude-code', 'hermes', 'omarchy'];

describe('agent menu', () => {
  test('offers all three agents, then their digits after a miss', () => {
    expect(menuPromptFor(MENU)).toBe('Say Claude, Hermes, or Omarchy.');
    expect(menuRetryPromptFor(MENU)).toBe('Say 1 for Claude, 2 for Hermes, or 3 for Omarchy.');
  });

  test('two agents still read naturally', () => {
    expect(menuPromptFor(['claude-code', 'hermes'])).toBe('Say Claude or Hermes.');
  });

  test.each([
    'Omarchy.',
    'Oh Marky.',
    'Omar key',
    'Omachi',
    'O Marchy',
    'Anarchy.',
    'Monarchy',
    'Omar.',
  ])('hears %p as Omarchy', (heard) => {
    expect(pickMenuAgent(heard, MENU)).toBe('omarchy');
  });

  test('3 and "three" pick Omarchy', () => {
    expect(pickMenuAgent('3', MENU)).toBe('omarchy');
    expect(pickMenuAgent('Three.', MENU)).toBe('omarchy');
  });

  test('the other agents are still reachable by name and digit', () => {
    expect(pickMenuAgent('Claude.', MENU)).toBe('claude-code');
    expect(pickMenuAgent('Blob code.', MENU)).toBe('claude-code');
    expect(pickMenuAgent('Hermes', MENU)).toBe('hermes');
    expect(pickMenuAgent('one', MENU)).toBe('claude-code');
    expect(pickMenuAgent('2', MENU)).toBe('hermes');
  });

  test('a digit past the end of the menu picks nothing', () => {
    expect(pickMenuAgent('4', MENU)).toBeUndefined();
  });
});

describe('switching to Omarchy mid-call', () => {
  test('"switch to Omarchy" and a bare "Omarchy" both switch', () => {
    expect(pickAgent('Switch to Omarchy.', MENU)).toBe('omarchy');
    expect(bareAgentName('Omarchy.', MENU)).toBe('omarchy');
    expect(bareAgentName('Oh Marky', MENU)).toBe('omarchy');
  });

  test('a conversation about anarchy is not a switch', () => {
    // The menu accepts "anarchy"; mid-call matching must not.
    expect(pickAgent("Let's talk about anarchy", MENU)).toBeUndefined();
    expect(bareAgentName('Anarchy.', MENU)).toBeUndefined();
  });
});

describe('omarchyCommand', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ['CALLME_OMARCHY_HOST', 'CALLME_OMARCHY_SSH_ARGS', 'CALLME_OMARCHY_COMMAND']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test('runs Claude in the VM over ssh, failing fast instead of prompting', () => {
    process.env.CALLME_OMARCHY_HOST = 'buck@192.168.68.64';
    process.env.CALLME_OMARCHY_SSH_ARGS = '-i /Users/buck/.ssh/id_ed25519';
    delete process.env.CALLME_OMARCHY_COMMAND;
    const argv = omarchyCommand('hi');
    expect(argv[0]).toBe('ssh');
    expect(argv).toContain('BatchMode=yes');
    expect(argv.slice(-4)).toEqual([
      '-i',
      '/Users/buck/.ssh/id_ed25519',
      'buck@192.168.68.64',
      "~/.local/bin/claude --dangerously-skip-permissions -p 'hi'",
    ]);
  });

  test('without a host it refuses rather than guessing', () => {
    delete process.env.CALLME_OMARCHY_HOST;
    expect(() => omarchyCommand('hi')).toThrow('CALLME_OMARCHY_HOST');
  });

  test('takes the blocking path, not streaming', () => {
    expect(supportsStreaming('omarchy')).toBe(false);
  });
});

describe('shellQuote', () => {
  // ssh hands the remote command to a shell, so the prompt must survive one
  // round of shell parsing intact: quotes, $vars, backticks, newlines.
  test('a prompt survives the remote shell unchanged', async () => {
    const prompt = `Buck: what's in $HOME? Try \`ls\` and "quotes" — don't 'break'.\nYou:`;
    const proc = Bun.spawn(['sh', '-c', `printf %s ${shellQuote(prompt)}`], { stdout: 'pipe' });
    expect(await new Response(proc.stdout).text()).toBe(prompt);
  });
});
