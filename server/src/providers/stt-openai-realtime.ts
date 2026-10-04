/**
 * OpenAI Realtime STT Provider
 *
 * Uses the OpenAI Realtime API for streaming transcription with:
 * - Direct mu-law audio support (no conversion needed)
 * - Built-in server-side VAD for turn detection
 * - Low-latency streaming transcription
 */

import WebSocket from 'ws';
import type { RealtimeSTTProvider, RealtimeSTTSession, STTConfig } from './types.js';

export class OpenAIRealtimeSTTProvider implements RealtimeSTTProvider {
  readonly name = 'openai-realtime';
  private apiKey: string | null = null;
  private model: string = 'gpt-4o-transcribe';
  private silenceDurationMs: number = 800;

  initialize(config: STTConfig): void {
    if (!config.apiKey) {
      throw new Error('OpenAI API key required for Realtime STT');
    }
    this.apiKey = config.apiKey;
    this.model = config.model || 'gpt-4o-transcribe';
    this.silenceDurationMs = config.silenceDurationMs || 800;
    console.error(`STT provider: OpenAI Realtime (${this.model}, silence: ${this.silenceDurationMs}ms)`);
  }

  createSession(): RealtimeSTTSession {
    if (!this.apiKey) throw new Error('OpenAI Realtime STT not initialized');
    return new OpenAIRealtimeSTTSession(this.apiKey, this.model, this.silenceDurationMs);
  }
}

class OpenAIRealtimeSTTSession implements RealtimeSTTSession {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private model: string;
  private silenceDurationMs: number;
  private connected = false;
  private pendingTranscript = '';
  private onTranscriptCallback: ((transcript: string) => void) | null = null;
  private onPartialCallback: ((partial: string) => void) | null = null;
  private onSpeechStartCallback: (() => void) | null = null;
  private onUnclaimedCallback: ((transcript: string) => boolean) | null = null;
  // Transcripts that finished while nobody was waiting (caller spoke while the
  // agent was talking or thinking). Handed to the next waitForTranscript.
  private queuedTranscripts: string[] = [];
  private waitTimeout: ReturnType<typeof setTimeout> | null = null;
  private closed = false;  // True when intentionally closed
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelayMs = 1000;

  constructor(apiKey: string, model: string, silenceDurationMs: number) {
    this.apiKey = apiKey;
    this.model = model;
    this.silenceDurationMs = silenceDurationMs;
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = 'wss://api.openai.com/v1/realtime?intent=transcription';

      this.ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      this.ws.on('open', () => {
        console.error('[RealtimeSTT] WebSocket connected');
        this.connected = true;
        this.reconnectAttempts = 0;  // Reset on successful connection

        // Configure the transcription session (GA API shape; the beta
        // `transcription_session.update` shape was shut off by OpenAI)
        this.sendEvent({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcmu' },
                transcription: {
                  model: this.model,
                },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: this.silenceDurationMs,
                },
              },
            },
          },
        });

        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleEvent(event);
        } catch (e) {
          console.error('[RealtimeSTT] Failed to parse event:', e);
        }
      });

      this.ws.on('error', (error) => {
        console.error('[RealtimeSTT] WebSocket error:', error);
        if (!this.connected) reject(error);
      });

      this.ws.on('close', (code, reason) => {
        console.error(`[RealtimeSTT] WebSocket closed (code: ${code}, reason: ${reason || 'none'})`);
        this.connected = false;

        // Attempt reconnection if not intentionally closed
        if (!this.closed) {
          this.attemptReconnect();
        }
      });

      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('Realtime STT connection timeout'));
        }
      }, 10000);
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) {
      console.error('[RealtimeSTT] Not reconnecting - session intentionally closed');
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[RealtimeSTT] Max reconnect attempts (${this.maxReconnectAttempts}) reached, giving up`);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);  // Exponential backoff
    console.error(`[RealtimeSTT] Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);

    await new Promise(resolve => setTimeout(resolve, delay));

    if (this.closed) {
      console.error('[RealtimeSTT] Reconnect cancelled - session was closed');
      return;
    }

    try {
      await this.doConnect();
      console.error('[RealtimeSTT] Reconnected successfully');
    } catch (error) {
      console.error('[RealtimeSTT] Reconnect failed:', error);
      // The close handler will trigger another reconnect attempt
    }
  }

  private handleEvent(event: any): void {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
      case 'transcription_session.created':
      case 'transcription_session.updated':
        console.error(`[RealtimeSTT] ${event.type}`);
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) {
          this.pendingTranscript += event.delta;
          this.onPartialCallback?.(this.pendingTranscript);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        console.error(`[RealtimeSTT] Transcript: ${event.transcript}`);
        if (event.transcript) {
          if (this.onTranscriptCallback) {
            this.onTranscriptCallback(event.transcript);
          } else if (!this.onUnclaimedCallback?.(event.transcript)) {
            this.queuedTranscripts.push(event.transcript);
          }
        }
        this.pendingTranscript = '';
        break;

      case 'input_audio_buffer.speech_started':
        console.error('[RealtimeSTT] Speech started');
        this.pendingTranscript = '';
        this.onSpeechStartCallback?.();
        break;

      case 'input_audio_buffer.speech_stopped':
        console.error('[RealtimeSTT] Speech stopped');
        break;

      case 'input_audio_buffer.committed':
        console.error('[RealtimeSTT] Audio committed');
        break;

      case 'error':
        console.error('[RealtimeSTT] Error:', event.error);
        break;
    }
  }

  private sendEvent(event: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  sendAudio(muLawData: Buffer): void {
    if (!this.connected) return;
    this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: muLawData.toString('base64'),
    });
  }

  onPartial(callback: (partial: string) => void): void {
    this.onPartialCallback = callback;
  }

  onSpeechStart(callback: () => void): void {
    this.onSpeechStartCallback = callback;
  }

  onUnclaimedTranscript(callback: (transcript: string) => boolean): void {
    this.onUnclaimedCallback = callback;
  }

  async waitForTranscript(timeoutMs: number = 30000): Promise<string> {
    const queued = this.queuedTranscripts.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.onTranscriptCallback = null;
        this.waitTimeout = null;
        reject(new Error('Transcript timeout'));
      }, timeoutMs);
      this.waitTimeout = timeout;

      this.onTranscriptCallback = (transcript) => {
        clearTimeout(timeout);
        this.waitTimeout = null;
        this.onTranscriptCallback = null;
        resolve(transcript);
      };
    });
  }

  cancelWait(): void {
    if (this.waitTimeout) clearTimeout(this.waitTimeout);
    this.waitTimeout = null;
    this.onTranscriptCallback = null;
  }

  close(): void {
    this.closed = true;  // Prevent reconnection attempts
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
