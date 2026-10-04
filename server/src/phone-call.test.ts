/**
 * Regression tests for the streamed-reply path.
 *
 * Run with `bun test`. These are deliberately narrow: they cover the two
 * bugs that reached a real phone call, where the behaviour looked correct
 * by inspection.
 */

import { describe, expect, test } from 'bun:test';
import { CallManager, chimePcm } from './phone-call.js';
import { SentenceBuffer } from './backends.js';

function fakeState(): any {
  return {
    callId: 'test',
    callControlId: null,
    userPhoneNumber: '+10000000000',
    ws: null,
    streamSid: null,
    streamingReady: true,
    wsToken: '',
    conversationHistory: [],
    startTime: Date.now(),
    hungUp: false,
    sttSession: null,
    speaking: false,
    interrupted: false,
    stoppedBySpeech: false,
  };
}

function fakeManager(synthesized: string[]) {
  const config: any = {
    providers: {
      tts: {
        async synthesize(text: string) {
          synthesized.push(text);
          return Buffer.alloc(480);
        },
      },
      phone: {},
      stt: {},
    },
    transcriptTimeoutMs: 1000,
  };
  return { mgr: new CallManager(config) as any, config };
}

describe('speakReplyStream', () => {
  test('a spoken "stop" cuts a streamed reply off', async () => {
    const synthesized: string[] = [];
    const { mgr, config } = fakeManager(synthesized);
    const state = fakeState();

    // The caller says "stop" while the first sentence is being synthesized.
    // state.speaking must already be true, or handleSpokenStop discards it.
    let speakingDuringFirst: boolean | undefined;
    let stopConsumed: boolean | undefined;
    const realSynthesize = config.providers.tts.synthesize;
    config.providers.tts.synthesize = async function (text: string) {
      if (speakingDuringFirst === undefined) {
        speakingDuringFirst = state.speaking;
        stopConsumed = mgr.handleSpokenStop(state, 'Stop.');
      }
      return realSynthesize.call(this, text);
    };

    let pulled = 0;
    async function* sentences() {
      for (const s of ['One.', 'Two.', 'Three.', 'Four.']) {
        pulled++;
        yield s;
      }
    }

    const spoken = await mgr.speakReplyStream(state, sentences());

    expect(speakingDuringFirst).toBe(true);
    expect(stopConsumed).toBe(true);
    expect(state.interrupted).toBe(true);
    expect(state.stoppedBySpeech).toBe(true);
    // Stop pulling from the agent instead of speaking the rest of the reply.
    expect(pulled).toBe(1);
    expect(synthesized).toEqual(['One.']);
    expect(spoken).toBe('One.');
    // The flag has to be cleared, or the next turn starts "already speaking".
    expect(state.speaking).toBe(false);
  });

  test('an uninterrupted reply speaks every sentence', async () => {
    const synthesized: string[] = [];
    const { mgr } = fakeManager(synthesized);
    const state = fakeState();

    async function* sentences() {
      yield 'First.';
      yield 'Second.';
    }

    const spoken = await mgr.speakReplyStream(state, sentences());
    expect(synthesized).toEqual(['First.', 'Second.']);
    expect(spoken).toBe('First. Second.');
    expect(state.interrupted).toBe(false);
    expect(state.speaking).toBe(false);
  });

  test('being stopped before any sentence is not an error', async () => {
    const synthesized: string[] = [];
    const { mgr } = fakeManager(synthesized);
    const state = fakeState();

    // The caller stops while the agent is still thinking, so the stream ends
    // without ever yielding a sentence.
    async function* sentences(): AsyncGenerator<string> {
      mgr.handleSpokenStop(state, 'stop');
      return;
    }

    // Must not throw: the throw propagates out of the turn and ends the call.
    const spoken = await mgr.speakReplyStream(state, sentences());
    expect(spoken).toBe('');
    expect(state.interrupted).toBe(true);
    expect(synthesized).toEqual([]);
  });
});

describe('handleSpokenStop', () => {
  const withBargeIn = (value: string | undefined, fn: () => void) => {
    const prev = process.env.CALLME_BARGE_IN;
    if (value === undefined) delete process.env.CALLME_BARGE_IN;
    else process.env.CALLME_BARGE_IN = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.CALLME_BARGE_IN;
      else process.env.CALLME_BARGE_IN = prev;
    }
  };

  function speakingState() {
    const state = fakeState();
    state.speaking = true;
    let cleared = 0;
    state.sttSession = { clearQueued: () => { cleared++; } };
    return { state, cleared: () => cleared };
  }

  test('"stop" drops queued transcripts, so a stale request cannot preempt the next one', () => {
    const { mgr } = fakeManager([]);
    const { state, cleared } = speakingState();
    withBargeIn('false', () => {
      expect(mgr.handleSpokenStop(state, 'Stop')).toBe(true);
      expect(state.stoppedBySpeech).toBe(true);
      expect(state.interrupted).toBe(true);
      expect(cleared()).toBe(1);
    });
  });

  test('a fragment heard mid-playback is discarded, not queued as the next turn', () => {
    const { mgr } = fakeManager([]);
    const { state, cleared } = speakingState();
    withBargeIn('false', () => {
      // "Tell me a story about a pirate" committed as just "Tell me" because
      // the caller paused on hearing the agent still talking.
      expect(mgr.handleSpokenStop(state, 'Tell me')).toBe(true);
      expect(state.interrupted).toBe(false);
      expect(state.stoppedBySpeech).toBe(false);
      expect(cleared()).toBe(0); // discarding one is not flushing the queue
    });
  });

  test('with barge-in on, mid-playback speech is kept for the next turn', () => {
    const { mgr } = fakeManager([]);
    const { state } = speakingState();
    withBargeIn(undefined, () => {
      expect(mgr.handleSpokenStop(state, 'Tell me')).toBe(false);
    });
  });

  test('speech while the agent is silent is left alone', () => {
    const { mgr } = fakeManager([]);
    const state = fakeState(); // speaking = false
    withBargeIn('false', () => {
      expect(mgr.handleSpokenStop(state, 'Tell me')).toBe(false);
      expect(mgr.handleSpokenStop(state, 'Stop')).toBe(false);
    });
  });
});

describe('chimePcm', () => {
  const samples = (b: Buffer) => {
    const out: number[] = [];
    for (let i = 0; i + 1 < b.length; i += 2) out.push(b.readInt16LE(i));
    return out;
  };

  test('is two 90ms notes of 24kHz mono 16-bit PCM', () => {
    // 24000 Hz * 0.09 s * 2 notes * 2 bytes
    expect(chimePcm('yourTurn').length).toBe(Math.round(24000 * 0.09) * 2 * 2);
  });

  test('is audible but well below full scale', () => {
    const peak = Math.max(...samples(chimePcm('yourTurn')).map(Math.abs));
    expect(peak).toBeGreaterThan(1000);
    expect(peak).toBeLessThan(32767 * 0.3);
  });

  test('ramps in and out, so it does not click', () => {
    const s = samples(chimePcm('gotIt'));
    expect(Math.abs(s[0])).toBeLessThan(200);
    expect(Math.abs(s[s.length - 1])).toBeLessThan(200);
  });

  test('the two chimes are distinguishable', () => {
    // Same notes in opposite order: rising vs falling.
    expect(chimePcm('yourTurn').equals(chimePcm('gotIt'))).toBe(false);
    const half = chimePcm('yourTurn').length / 2;
    const risingFirst = chimePcm('yourTurn').subarray(0, half);
    const fallingSecond = chimePcm('gotIt').subarray(half);
    expect(risingFirst.equals(fallingSecond)).toBe(true);
  });
});

describe('SentenceBuffer', () => {
  const collect = (deltas: string[]): string[] => {
    const sb = new SentenceBuffer();
    const out: string[] = [];
    for (const d of deltas) out.push(...sb.push(d));
    out.push(...sb.flush());
    return out;
  };

  test('does not split a version number at a delta boundary', () => {
    // Mid-stream, "...version 26." looked like a complete sentence.
    expect(collect(['This Mac runs macOS 26.', '6.2.', " That's Tahoe."])).toEqual([
      'This Mac runs macOS 26.6.2.',
      "That's Tahoe.",
    ]);
  });

  test('does not split a decimal', () => {
    expect(collect(['The total is $4.', '50 even. ', 'Thanks.'])).toEqual([
      'The total is $4.50 even.',
      'Thanks.',
    ]);
  });

  test('splits ordinary sentences', () => {
    expect(collect(['Hello there. ', 'How are you? ', 'Fine.'])).toEqual([
      'Hello there.',
      'How are you?',
      'Fine.',
    ]);
  });

  test('keeps an abbreviation attached to its sentence', () => {
    expect(collect(['I saw Dr. ', 'Smith today. ', 'He was late.'])).toEqual([
      'I saw Dr. Smith today.',
      'He was late.',
    ]);
  });

  test('never emits a code fence', () => {
    const out = collect(['Here you go. ', '```\nrm -rf /\n```', ' All done.']);
    expect(out.join(' ')).not.toContain('rm -rf');
  });
});
