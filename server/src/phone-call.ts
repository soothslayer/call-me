import WebSocket, { WebSocketServer } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import {
  loadProviderConfig,
  createProviders,
  validateProviderConfig,
  type ProviderRegistry,
  type ProviderConfig,
  type RealtimeSTTSession,
} from './providers/index.js';
import {
  validateTwilioSignature,
  validateTelnyxSignature,
  generateWebSocketToken,
  validateWebSocketToken,
} from './webhook-security.js';

interface CallState {
  callId: string;
  callControlId: string | null;
  userPhoneNumber: string;
  ws: WebSocket | null;
  streamSid: string | null;  // Twilio media stream ID (required for sending audio)
  streamingReady: boolean;  // True when streaming.started event received (Telnyx)
  wsToken: string;  // Security token for WebSocket authentication
  conversationHistory: Array<{ speaker: 'claude' | 'user'; message: string }>;
  startTime: number;
  hungUp: boolean;
  sttSession: RealtimeSTTSession | null;
  speaking: boolean;  // True while agent audio is being sent
  interrupted: boolean;  // Set when the caller talks over the agent (barge-in)
  stoppedBySpeech: boolean;  // Set when the caller said "stop" mid-sentence
}

export interface ServerConfig {
  publicUrl: string;
  port: number;
  phoneNumber: string;
  userPhoneNumber: string;
  providers: ProviderRegistry;
  providerConfig: ProviderConfig;  // For webhook signature verification
  transcriptTimeoutMs: number;
}

/**
 * Hooks for an inbound call conversation. Provided by the inbound entrypoint.
 */
export interface InboundHooks {
  /** Spoken once, right after the call is answered. */
  greeting: string;
  /** Spoken just before hanging up (skipped if the caller already hung up). */
  farewell: string;
  /**
   * Turn a caller utterance into the agent's spoken reply.
   * Return null to end the call (farewell is spoken, then hangup).
   * May alternatively return an AsyncIterable of sentences, which are
   * spoken as they arrive (streaming mode).
   */
  onUserMessage: (
    transcript: string,
    history: Array<{ speaker: 'user' | 'agent'; message: string }>,
    signal: AbortSignal
  ) => Promise<string | AsyncIterable<string> | null>;
  /**
   * Spoken if the caller talks while the agent is still thinking, e.g.
   * "Claude Code is thinking. Say stop to interrupt." Saying "stop" then
   * aborts the turn. Leave unset to just queue that speech as the next turn.
   */
  thinkingNotice?: string;
  /** Spoken after the caller stops the agent (default: "Listening."). */
  stoppedNotice?: string;
}

const STOP_RE = /^\W*(please\W+)?(stop|cancel)\b/i;
const STOPPED = Symbol('stopped');

export function loadServerConfig(publicUrl: string): ServerConfig {
  const providerConfig = loadProviderConfig();
  const errors = validateProviderConfig(providerConfig);

  if (!process.env.CALLME_USER_PHONE_NUMBER) {
    errors.push('Missing CALLME_USER_PHONE_NUMBER (where to call you)');
  }

  if (errors.length > 0) {
    throw new Error(`Missing required configuration:\n  - ${errors.join('\n  - ')}`);
  }

  const providers = createProviders(providerConfig);

  // Default 3 minutes for transcript timeout
  const transcriptTimeoutMs = parseInt(process.env.CALLME_TRANSCRIPT_TIMEOUT_MS || '180000', 10);

  return {
    publicUrl,
    port: parseInt(process.env.CALLME_PORT || '0', 10),
    phoneNumber: providerConfig.phoneNumber,
    userPhoneNumber: process.env.CALLME_USER_PHONE_NUMBER!,
    providers,
    providerConfig,
    transcriptTimeoutMs,
  };
}

export class CallManager {
  private activeCalls = new Map<string, CallState>();
  private callControlIdToCallId = new Map<string, string>();
  private wsTokenToCallId = new Map<string, string>();  // For WebSocket auth
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private config: ServerConfig;
  private currentCallId = 0;

  /**
   * Optional handler for inbound calls. When set (inbound mode), Telnyx
   * `call.initiated` webhooks with direction=incoming are routed here.
   * The handler is responsible for running the conversation via
   * runInboundConversation(). Outbound MCP flows are unaffected.
   */
  public onInboundCall: ((callControlId: string, from: string, to: string) => Promise<void>) | null = null;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  setPublicUrl(url: string): void {
    this.config.publicUrl = url;
  }

  startServer(): Promise<number> {
    return new Promise((resolve, reject) => {
    this.httpServer = createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);

      if (url.pathname === '/twiml') {
        this.handlePhoneWebhook(req, res);
        return;
      }

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', activeCalls: this.activeCalls.size }));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (request: IncomingMessage, socket: any, head: Buffer) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      if (url.pathname === '/media-stream') {
        // Try to find the call ID from token
        const token = url.searchParams.get('token');
        let callId = token ? this.wsTokenToCallId.get(token) : null;

        // Validate token if provided
        if (token && callId) {
          const state = this.activeCalls.get(callId);
          if (!state || !validateWebSocketToken(state.wsToken, token)) {
            console.error('[Security] Rejecting WebSocket: token validation failed');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          console.error(`[Security] WebSocket token validated for call ${callId}`);
        } else if (!callId) {
          // Token missing or not found - only allow fallback for ngrok free tier
          const isNgrokFreeTier = new URL(this.config.publicUrl).hostname.endsWith('.ngrok-free.dev');
          if (isNgrokFreeTier) {
            // Fallback: find the most recent active call (ngrok compatibility mode)
            // Token lookup can fail due to timing issues with ngrok's free tier
            const activeCallIds = Array.from(this.activeCalls.keys());
            if (activeCallIds.length > 0) {
              callId = activeCallIds[activeCallIds.length - 1];
              console.error(`[WebSocket] Token not found, using fallback call ID: ${callId} (ngrok compatibility mode)`);
            } else {
              // No active calls yet - create a placeholder and accept anyway
              // The connection handler will associate it with the correct call
              callId = `pending-${Date.now()}`;
              console.error(`[WebSocket] No active calls, using placeholder: ${callId} (ngrok compatibility mode)`);
            }
          } else {
            console.error('[Security] Rejecting WebSocket: missing or invalid token');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
        }

        // Accept WebSocket connection
        console.error(`[WebSocket] Accepting connection for: ${callId}`);
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request, callId);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws: WebSocket, _request: IncomingMessage, callId: string) => {
      console.error(`Media stream WebSocket connected for call ${callId}`);

      // Associate the WebSocket with the call immediately (token already validated)
      const state = this.activeCalls.get(callId);
      if (state) {
        state.ws = ws;
      }

      ws.on('message', (message: Buffer | string) => {
        const msgBuffer = Buffer.isBuffer(message) ? message : Buffer.from(message);

        // Parse JSON messages from Twilio to capture streamSid and handle events
        if (msgBuffer.length > 0 && msgBuffer[0] === 0x7b) {
          try {
            const msg = JSON.parse(msgBuffer.toString());
            const msgState = this.activeCalls.get(callId);

            // Capture streamSid from "start" event (required for sending audio back)
            if (msg.event === 'start' && msg.streamSid && msgState) {
              msgState.streamSid = msg.streamSid;
              console.error(`[${callId}] Captured streamSid: ${msg.streamSid}`);
            }

            // Handle "stop" event when call ends
            if (msg.event === 'stop' && msgState) {
              console.error(`[${callId}] Stream stopped`);
              msgState.hungUp = true;
            }
          } catch { }
        }

        // Forward audio to realtime transcription session
        const audioState = this.activeCalls.get(callId);
        if (audioState?.sttSession) {
          const audioData = this.extractInboundAudio(msgBuffer);
          if (audioData) {
            audioState.sttSession.sendAudio(audioData);
          }
        }
      });

      ws.on('close', () => {
        console.error('Media stream WebSocket closed');
      });
    });

    this.httpServer.once('error', (err: NodeJS.ErrnoException) => {
      reject(err);
    });

    this.httpServer.listen(this.config.port, () => {
      const addr = this.httpServer!.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : this.config.port;
      console.error(`HTTP server listening on port ${boundPort}`);
      resolve(boundPort);
    });
    }); // end Promise
  }

  /**
   * Extract INBOUND audio data from WebSocket message (filters out outbound/TTS audio)
   */
  private extractInboundAudio(msgBuffer: Buffer): Buffer | null {
    if (msgBuffer.length === 0) return null;

    // Binary audio (doesn't start with '{') - can't determine track, skip
    if (msgBuffer[0] !== 0x7b) {
      return null;
    }

    // JSON format - only extract inbound track (user's voice)
    try {
      const msg = JSON.parse(msgBuffer.toString());
      if (msg.event === 'media' && msg.media?.payload) {
        const track = msg.media?.track;
        if (track === 'inbound' || track === 'inbound_track') {
          return Buffer.from(msg.media.payload, 'base64');
        }
      }
    } catch { }

    return null;
  }

  private handlePhoneWebhook(req: IncomingMessage, res: ServerResponse): void {
    const contentType = req.headers['content-type'] || '';

    // Telnyx sends JSON webhooks
    if (contentType.includes('application/json')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          // Validate Telnyx signature if public key is configured
          const telnyxPublicKey = this.config.providerConfig.telnyxPublicKey;
          if (telnyxPublicKey) {
            const signature = req.headers['telnyx-signature-ed25519'] as string | undefined;
            const timestamp = req.headers['telnyx-timestamp'] as string | undefined;

            if (!validateTelnyxSignature(telnyxPublicKey, signature, timestamp, body)) {
              console.error('[Security] Rejecting Telnyx webhook: invalid signature');
              res.writeHead(401);
              res.end('Invalid signature');
              return;
            }
          } else {
            console.error('[Security] Warning: CALLME_TELNYX_PUBLIC_KEY not set, skipping signature verification');
          }

          const event = JSON.parse(body);
          await this.handleTelnyxWebhook(event, res);
        } catch (error) {
          console.error('Error parsing webhook:', error);
          res.writeHead(400);
          res.end('Invalid JSON');
        }
      });
      return;
    }

    // Twilio sends form-urlencoded webhooks
    if (contentType.includes('application/x-www-form-urlencoded')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const params = new URLSearchParams(body);

          // Validate Twilio signature
          const authToken = this.config.providerConfig.phoneAuthToken;
          const signature = req.headers['x-twilio-signature'] as string | undefined;
          // Use the known public URL directly - reconstructing from headers fails with ngrok
          // because ngrok doesn't preserve headers exactly as Twilio sends them
          const webhookUrl = `${this.config.publicUrl}/twiml`;

          if (!validateTwilioSignature(authToken, signature, webhookUrl, params)) {
            const isNgrokFreeTier = new URL(this.config.publicUrl).hostname.endsWith('.ngrok-free.dev');
            if (isNgrokFreeTier) {
              // Only log if ngrok free tier is used
              // Log for debugging but proceed anyway - ngrok free tier causes signature mismatches
              console.error('[Security] Twilio signature validation failed (proceeding anyway for ngrok compatibility)');
            } else {
              console.error('[Security] Rejecting Twilio webhook: invalid signature');
              res.writeHead(401);
              res.end('Invalid signature');
              return;
            }
          }

          await this.handleTwilioWebhook(params, res);
        } catch (error) {
          console.error('Error parsing Twilio webhook:', error);
          res.writeHead(400);
          res.end('Invalid form data');
        }
      });
      return;
    }

    // Fallback: Reject unknown content types
    console.error('[Security] Rejecting webhook with unknown content type:', contentType);
    res.writeHead(400);
    res.end('Invalid content type');
  }

  private async handleTwilioWebhook(params: URLSearchParams, res: ServerResponse): Promise<void> {
    const callSid = params.get('CallSid');
    const callStatus = params.get('CallStatus');

    console.error(`Twilio webhook: CallSid=${callSid}, CallStatus=${callStatus}`);

    // Handle call status updates
    if (callStatus === 'completed' || callStatus === 'busy' || callStatus === 'no-answer' || callStatus === 'failed') {
      // Call ended - find and mark as hung up
      if (callSid) {
        const callId = this.callControlIdToCallId.get(callSid);
        if (callId) {
          this.callControlIdToCallId.delete(callSid);
          const state = this.activeCalls.get(callId);
          if (state) {
            state.hungUp = true;
            state.ws?.close();
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }

    // For 'in-progress' or 'ringing' status, return TwiML to start media stream
    // Include security token in the stream URL
    let streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;

    // Find the call state to get the WebSocket token
    if (callSid) {
      const callId = this.callControlIdToCallId.get(callSid);
      if (callId) {
        const state = this.activeCalls.get(callId);
        if (state) {
          streamUrl += `?token=${encodeURIComponent(state.wsToken)}`;
        }
      }
    }

    const xml = this.config.providers.phone.getStreamConnectXml(streamUrl);
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xml);
  }

  private async handleTelnyxWebhook(event: any, res: ServerResponse): Promise<void> {
    const eventType = event.data?.event_type;
    const callControlId = event.data?.payload?.call_control_id;

    console.error(`Phone webhook: ${eventType}`);

    // Always respond 200 OK immediately
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));

    if (!callControlId) return;

    try {
      switch (eventType) {
        case 'call.initiated': {
          // Route inbound calls to the registered handler (inbound mode).
          // Outbound calls initiated via the API have direction=outgoing.
          const direction = event.data?.payload?.direction;
          // Call Control v2 sends `from` as a plain E.164 string; older payloads nested it
          const rawFrom = event.data?.payload?.from;
          const from = (typeof rawFrom === 'string' ? rawFrom : rawFrom?.phone_number) || 'unknown';
          const rawTo = event.data?.payload?.to;
          const to = (typeof rawTo === 'string' ? rawTo : rawTo?.phone_number) || '';
          if (direction === 'incoming' && this.onInboundCall) {
            console.error(`Inbound call from ${from} to ${to} (${callControlId})`);
            this.onInboundCall(callControlId, from, to).catch((err) =>
              console.error('[inbound] handler error:', err instanceof Error ? err.message : err)
            );
          }
          break;
        }

        case 'call.answered':
          // Include security token in the stream URL
          let streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;
          const callId = this.callControlIdToCallId.get(callControlId);
          if (callId) {
            const state = this.activeCalls.get(callId);
            if (state) {
              streamUrl += `?token=${encodeURIComponent(state.wsToken)}`;
            }
          }
          await this.config.providers.phone.startStreaming(callControlId, streamUrl);
          console.error(`Started streaming for call ${callControlId}`);
          break;

        case 'call.hangup':
          const hangupCallId = this.callControlIdToCallId.get(callControlId);
          if (hangupCallId) {
            this.callControlIdToCallId.delete(callControlId);
            const hangupState = this.activeCalls.get(hangupCallId);
            if (hangupState) {
              hangupState.hungUp = true;
              hangupState.ws?.close();
            }
          }
          break;

        case 'call.machine.detection.ended':
          const result = event.data?.payload?.result;
          console.error(`AMD result: ${result}`);
          break;

        case 'streaming.started':
          const streamCallId = this.callControlIdToCallId.get(callControlId);
          if (streamCallId) {
            const streamState = this.activeCalls.get(streamCallId);
            if (streamState) {
              streamState.streamingReady = true;
              console.error(`[${streamCallId}] Streaming ready`);
            }
          }
          break;

        case 'streaming.stopped':
          break;
      }
    } catch (error) {
      console.error(`Error handling webhook ${eventType}:`, error);
    }
  }

  async initiateCall(message: string): Promise<{ callId: string; response: string }> {
    const callId = `call-${++this.currentCallId}-${Date.now()}`;

    // Create realtime transcription session via provider
    const sttSession = this.config.providers.stt.createSession();
    await sttSession.connect();
    console.error(`[${callId}] STT session connected`);

    // Generate secure token for WebSocket authentication
    const wsToken = generateWebSocketToken();

    const state: CallState = {
      callId,
      callControlId: null,
      userPhoneNumber: this.config.userPhoneNumber,
      ws: null,
      streamSid: null,
      streamingReady: false,
      wsToken,
      conversationHistory: [],
      startTime: Date.now(),
      hungUp: false,
      sttSession,
      speaking: false,
      interrupted: false,
      stoppedBySpeech: false,
    };

    this.activeCalls.set(callId, state);
    sttSession.onSpeechStart?.(() => this.handleBargeIn(state));
    sttSession.onUnclaimedTranscript?.((text) => this.handleSpokenStop(state, text));

    try {
      const callControlId = await this.config.providers.phone.initiateCall(
        this.config.userPhoneNumber,
        this.config.phoneNumber,
        `${this.config.publicUrl}/twiml`
      );

      state.callControlId = callControlId;
      this.callControlIdToCallId.set(callControlId, callId);
      this.wsTokenToCallId.set(wsToken, callId);

      console.error(`Call initiated: ${callControlId} -> ${this.config.userPhoneNumber}`);

      // Start TTS generation in parallel with waiting for connection
      // This reduces latency by generating audio while Twilio establishes the stream
      const ttsPromise = this.generateTTSAudio(message);

      await this.waitForConnection(callId, 15000);

      // Send the pre-generated audio and listen for response
      const audioData = await ttsPromise;
      await this.sendPreGeneratedAudio(state, audioData);
      const response = await this.listen(state);
      state.conversationHistory.push({ speaker: 'claude', message });
      state.conversationHistory.push({ speaker: 'user', message: response });

      return { callId, response };
    } catch (error) {
      state.sttSession?.close();
      this.activeCalls.delete(callId);
      throw error;
    }
  }

  async continueCall(callId: string, message: string): Promise<string> {
    const state = this.activeCalls.get(callId);
    if (!state) throw new Error(`No active call: ${callId}`);

    const response = await this.speakAndListen(state, message);
    state.conversationHistory.push({ speaker: 'claude', message });
    state.conversationHistory.push({ speaker: 'user', message: response });

    return response;
  }

  async speakOnly(callId: string, message: string): Promise<void> {
    const state = this.activeCalls.get(callId);
    if (!state) throw new Error(`No active call: ${callId}`);

    await this.speak(state, message);
    state.conversationHistory.push({ speaker: 'claude', message });
  }

  async endCall(callId: string, message: string): Promise<{ durationSeconds: number }> {
    const state = this.activeCalls.get(callId);
    if (!state) throw new Error(`No active call: ${callId}`);

    await this.speak(state, message);

    // Wait for audio to finish playing before hanging up (prevent cutoff)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Hang up the call via phone provider
    if (state.callControlId) {
      await this.config.providers.phone.hangup(state.callControlId);
    }

    this.cleanupCallState(state);

    const durationSeconds = Math.round((Date.now() - state.startTime) / 1000);
    this.activeCalls.delete(state.callId);

    return { durationSeconds };
  }

  /**
   * Release all resources held by a call: STT session, media WebSocket,
   * and the security-token / call-control-ID mappings. Idempotent.
   */
  private cleanupCallState(state: CallState): void {
    try {
      state.sttSession?.close();
    } catch { /* already closed */ }
    try {
      state.ws?.close();
    } catch { /* already closed */ }
    state.hungUp = true;

    // Clean up security token mapping
    this.wsTokenToCallId.delete(state.wsToken);
    if (state.callControlId) {
      this.callControlIdToCallId.delete(state.callControlId);
    }
    this.activeCalls.delete(state.callId);
  }

  /**
   * Run a full inbound call conversation: answer the call, wait for the
   * media stream, then loop listen -> onUserMessage -> speak until the
   * hook returns null or the caller hangs up.
   *
   * The Telnyx `call.answered` webhook (fired after answerCall) triggers the
   * existing startStreaming flow, so no special webhook handling is needed
   * beyond the mapping registered here.
   */
  async runInboundConversation(
    callControlId: string,
    from: string,
    hooks: InboundHooks
  ): Promise<void> {
    const callId = `inbound-${++this.currentCallId}-${Date.now()}`;

    const sttSession = this.config.providers.stt.createSession();
    await sttSession.connect();

    const wsToken = generateWebSocketToken();
    const state: CallState = {
      callId,
      callControlId,
      userPhoneNumber: from,
      ws: null,
      streamSid: null,
      streamingReady: false,
      wsToken,
      conversationHistory: [],
      startTime: Date.now(),
      hungUp: false,
      sttSession,
      speaking: false,
      interrupted: false,
      stoppedBySpeech: false,
    };
    this.activeCalls.set(callId, state);
    sttSession.onSpeechStart?.(() => this.handleBargeIn(state));
    sttSession.onUnclaimedTranscript?.((text) => this.handleSpokenStop(state, text));
    this.callControlIdToCallId.set(callControlId, callId);
    this.wsTokenToCallId.set(wsToken, callId);

    console.error(`[${callId}] Inbound call from ${from}, answering...`);

    const history: Array<{ speaker: 'user' | 'agent'; message: string }> = [];

    try {
      await this.config.providers.phone.answerCall(callControlId);
      await this.waitForConnection(callId, 20000);

      await this.speak(state, hooks.greeting);
      history.push({ speaker: 'agent', message: hooks.greeting });

      for (;;) {
        let transcript: string;
        try {
          transcript = await this.listen(state);
        } catch (error) {
          if (error instanceof Error && error.message.includes('hung up')) break;
          throw error;
        }

        // A bare "stop" (e.g. said after a barge-in cut the agent off) is not a request
        if (STOP_RE.test(transcript)) {
          await this.speak(state, hooks.stoppedNotice ?? 'Listening.');
          continue;
        }

        history.push({ speaker: 'user', message: transcript });

        const abort = new AbortController();
        const replyPromise = hooks.onUserMessage(transcript, history, abort.signal);
        const reply = hooks.thinkingNotice
          ? await this.awaitReplyWhileListening(state, replyPromise, abort, hooks.thinkingNotice)
          : await replyPromise;
        if (state.hungUp) break;
        if (reply === STOPPED) {
          history.push({ speaker: 'agent', message: '[stopped by the caller before answering]' });
          await this.speak(state, hooks.stoppedNotice ?? 'Listening.');
          continue;
        }
        if (reply === null) break;

        if (typeof reply === 'string') {
          history.push({ speaker: 'agent', message: reply });
          await this.speak(state, reply);
        } else {
          // Streaming reply: speak each sentence as the agent produces it.
          const spoken = await this.speakReplyStream(state, reply);
          history.push({ speaker: 'agent', message: spoken });
        }
        if (state.interrupted) {
          history[history.length - 1].message += ' [cut off: the caller interrupted]';
        }
        if (state.stoppedBySpeech) {
          await this.speak(state, hooks.stoppedNotice ?? 'Listening.');
        }
      }
    } catch (error) {
      console.error(`[${callId}] Inbound call error:`, error instanceof Error ? error.message : error);
    } finally {
      if (!state.hungUp) {
        try {
          await this.endCall(callId, hooks.farewell);
        } catch {
          try {
            await this.config.providers.phone.hangup(callControlId);
          } catch { /* best effort */ }
          this.cleanupCallState(state);
        }
      } else {
        this.cleanupCallState(state);
      }
      console.error(`[${callId}] Inbound call finished`);
    }
  }

  private async waitForConnection(callId: string, timeout: number): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const state = this.activeCalls.get(callId);
      // Wait for WebSocket AND streaming to be ready:
      // - Twilio: streamSid is set from "start" WebSocket event
      // - Telnyx: streamingReady is set from "streaming.started" webhook
      const wsReady = state?.ws && state.ws.readyState === WebSocket.OPEN;
      const streamReady = state?.streamSid || state?.streamingReady;
      if (wsReady && streamReady) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('WebSocket connection timeout');
  }

  /**
   * Pre-generate TTS audio (can run in parallel with connection setup)
   * Returns mu-law encoded audio ready to send to Twilio
   */
  private async generateTTSAudio(text: string): Promise<Buffer> {
    console.error(`[TTS] Generating audio for: ${text.substring(0, 50)}...`);
    const tts = this.config.providers.tts;
    const pcmData = await tts.synthesize(text);
    const resampledPcm = this.resample24kTo8k(pcmData);
    const muLawData = this.pcmToMuLaw(resampledPcm);
    console.error(`[TTS] Audio generated: ${muLawData.length} bytes`);
    return muLawData;
  }

  /**
   * Send a single audio chunk to the phone via WebSocket
   */
  private sendMediaChunk(state: CallState, audioData: Buffer): void {
    if (state.ws?.readyState !== WebSocket.OPEN) return;
    const message: Record<string, unknown> = {
      event: 'media',
      media: { payload: audioData.toString('base64') },
    };
    if (state.streamSid) {
      message.streamSid = state.streamSid;
    }
    state.ws.send(JSON.stringify(message));
  }

  /**
   * Wait for the agent's reply while still listening to the caller. If they
   * say "stop", abort the turn and return STOPPED; anything else gets the
   * thinking notice and is discarded.
   */
  private async awaitReplyWhileListening(
    state: CallState,
    replyPromise: Promise<string | null>,
    abort: AbortController,
    thinkingNotice: string
  ): Promise<string | null | typeof STOPPED> {
    const stt = state.sttSession!;
    const reply = replyPromise.then((value) => ({ kind: 'reply' as const, value }));
    for (;;) {
      const speech = stt.waitForTranscript(this.config.transcriptTimeoutMs).then(
        (text) => ({ kind: 'speech' as const, text }),
        () => ({ kind: 'timeout' as const })
      );
      const first = await Promise.race([reply, speech, this.waitForHangup(state).catch(() => ({ kind: 'hangup' as const }))]);

      if (first.kind === 'reply') {
        stt.cancelWait?.();
        return first.value;
      }
      if (first.kind === 'hangup') {
        stt.cancelWait?.();
        abort.abort();
        await replyPromise.catch(() => {});
        return null;
      }
      if (first.kind === 'speech') {
        console.error(`[${state.callId}] Caller spoke while agent was thinking: ${first.text}`);
        if (STOP_RE.test(first.text)) {
          abort.abort();
          await replyPromise.catch(() => {});
          return STOPPED;
        }
        await this.speak(state, thinkingNotice);
      }
    }
  }

  /**
   * Barge-in: the caller started talking while the agent was speaking.
   * Stop sending audio and tell the provider to drop what it has buffered.
   * What the caller says is queued by the STT session as the next turn.
   */
  private handleBargeIn(state: CallState): void {
    if (!state.speaking || state.interrupted || process.env.CALLME_BARGE_IN === 'false') return;
    console.error(`[${state.callId}] Barge-in: caller interrupted, stopping playback`);
    this.stopPlayback(state);
  }

  /**
   * The caller said "stop" while the agent was talking: cut playback off.
   * Returns true to consume the transcript so it isn't treated as a turn.
   */
  private handleSpokenStop(state: CallState, text: string): boolean {
    if (!state.speaking || !STOP_RE.test(text)) return false;
    console.error(`[${state.callId}] Caller said "${text}" while agent was talking, stopping playback`);
    this.stopPlayback(state);
    state.stoppedBySpeech = true;
    return true;
  }

  private stopPlayback(state: CallState): void {
    if (state.interrupted) return;
    state.interrupted = true;
    if (state.ws?.readyState === WebSocket.OPEN) {
      const clear: Record<string, unknown> = { event: 'clear' };
      if (state.streamSid) clear.streamSid = state.streamSid;
      state.ws.send(JSON.stringify(clear));
    }
  }

  private async sendPreGeneratedAudio(state: CallState, muLawData: Buffer): Promise<void> {
    console.error(`[${state.callId}] Sending pre-generated audio...`);
    state.speaking = true;
    state.interrupted = false;
    try {
      const chunkSize = 160;  // 20ms at 8kHz
      for (let i = 0; i < muLawData.length && !state.interrupted; i += chunkSize) {
        this.sendMediaChunk(state, muLawData.subarray(i, i + chunkSize));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Small delay to ensure audio finishes playing before listening
      if (!state.interrupted) await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      state.speaking = false;
    }
    console.error(`[${state.callId}] Audio sent`);
  }

  private async speakAndListen(state: CallState, text: string): Promise<string> {
    await this.speak(state, text);
    return await this.listen(state);
  }

  private async speak(state: CallState, text: string): Promise<void> {
    console.error(`[${state.callId}] Speaking: ${text.substring(0, 50)}...`);

    const tts = this.config.providers.tts;

    state.speaking = true;
    state.interrupted = false;
    state.stoppedBySpeech = false;
    try {
      // Use streaming if available for lower latency
      if (tts.synthesizeStream) {
        await this.speakStreaming(state, text, tts.synthesizeStream.bind(tts));
      } else {
        const pcmData = await tts.synthesize(text);
        await this.sendAudio(state, pcmData);
      }

      if (!state.interrupted) await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      state.speaking = false;
    }
    console.error(`[${state.callId}] Speaking ${state.interrupted ? 'interrupted' : 'done'}`);
  }

  private async speakStreaming(
    state: CallState,
    text: string,
    synthesizeStream: (text: string) => AsyncGenerator<Buffer>
  ): Promise<void> {
    async function* pcm(): AsyncGenerator<Buffer> {
      yield* synthesizeStream(text);
    }
    return this.speakPcmStream(state, pcm());
  }

  /**
   * Speak a stream of sentences, synthesizing each one as it arrives so
   * playback starts before the full reply exists. Returns the complete
   * spoken text for conversation history.
   */
  private async speakReplyStream(state: CallState, sentences: AsyncIterable<string>): Promise<string> {
    const tts = this.config.providers.tts;
    const spoken: string[] = [];

    async function* pcm(): AsyncGenerator<Buffer> {
      for await (const sentence of sentences) {
        // interrupted = stopped / barged in. Stop pulling from the agent
        // rather than synthesizing a sentence nobody will hear.
        if (state.hungUp || state.interrupted) break;
        const clean = sentence.trim();
        if (!clean) continue;
        spoken.push(clean);
        console.error(`[${state.callId}] Speaking (stream): ${clean.substring(0, 60)}...`);
        if (tts.synthesizeStream) {
          yield* tts.synthesizeStream(clean);
        } else {
          yield await tts.synthesize(clean);
        }
      }
    }

    // Same speaking lifecycle as speak(). Without it state.speaking stays
    // false for the whole streamed reply, and handleSpokenStop /
    // handleBargeIn both bail on `!state.speaking` — so "stop" was silently
    // dropped while the agent talked.
    state.speaking = true;
    state.interrupted = false;
    state.stoppedBySpeech = false;
    try {
      await this.speakPcmStream(state, pcm());
      if (!state.interrupted) await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      state.speaking = false;
    }
    console.error(`[${state.callId}] Speaking (stream) ${state.interrupted ? 'interrupted' : 'done'}`);

    // Being stopped before the first sentence is a normal outcome, not an
    // error — throwing here would propagate out and end the call.
    if (spoken.length === 0 && !state.interrupted && !state.hungUp) {
      throw new Error('Agent produced no speakable output');
    }
    return spoken.join(' ');
  }

  /**
   * Core PCM->mu-law->websocket pump shared by batch and streaming speech.
   * Jitter-buffers 100ms once at the start, then paces 20ms chunks.
   */
  private async speakPcmStream(
    state: CallState,
    pcmStream: AsyncGenerator<Buffer>
  ): Promise<void> {
    let pendingPcm = Buffer.alloc(0);
    let pendingMuLaw = Buffer.alloc(0);
    const OUTPUT_CHUNK_SIZE = 160; // 20ms at 8kHz
    const SAMPLES_PER_RESAMPLE = 6; // 6 bytes (3 samples) at 24kHz -> 1 sample at 8kHz

    // Jitter buffer: accumulate audio before starting playback to smooth out
    // timing variations from network latency and burst delivery patterns
    const JITTER_BUFFER_MS = 100; // Buffer 100ms of audio before starting
    // 8000 samples/sec ÷ 1000 ms/sec = 8 samples per ms; mu-law is 1 byte per sample
    const JITTER_BUFFER_SIZE = (8000 / 1000) * JITTER_BUFFER_MS; // 800 bytes at 8kHz mu-law
    let playbackStarted = false;

    // Helper to drain and send buffered mu-law audio in chunks
    const drainBuffer = async () => {
      while (pendingMuLaw.length >= OUTPUT_CHUNK_SIZE && !state.interrupted) {
        this.sendMediaChunk(state, pendingMuLaw.subarray(0, OUTPUT_CHUNK_SIZE));
        pendingMuLaw = pendingMuLaw.subarray(OUTPUT_CHUNK_SIZE);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    for await (const chunk of pcmStream) {
      // interrupted = barge-in / "stop"; hungUp = caller gone. Either ends playback.
      if (state.interrupted || state.hungUp) break;
      pendingPcm = Buffer.concat([pendingPcm, chunk]);

      const completeUnits = Math.floor(pendingPcm.length / SAMPLES_PER_RESAMPLE);
      if (completeUnits > 0) {
        const bytesToProcess = completeUnits * SAMPLES_PER_RESAMPLE;
        const toProcess = pendingPcm.subarray(0, bytesToProcess);
        pendingPcm = pendingPcm.subarray(bytesToProcess);

        const resampled = this.resample24kTo8k(toProcess);
        const muLaw = this.pcmToMuLaw(resampled);
        pendingMuLaw = Buffer.concat([pendingMuLaw, muLaw]);

        // Wait for jitter buffer to fill before starting playback
        if (!playbackStarted && pendingMuLaw.length < JITTER_BUFFER_SIZE) {
          continue;
        }
        playbackStarted = true;

        await drainBuffer();
      }
    }

    // Send remaining audio (including any buffered audio for short messages)
    await drainBuffer();

    // Send any final partial chunk
    if (pendingMuLaw.length > 0 && !state.interrupted) {
      this.sendMediaChunk(state, pendingMuLaw);
    }
  }

  private async sendAudio(state: CallState, pcmData: Buffer): Promise<void> {
    const resampledPcm = this.resample24kTo8k(pcmData);
    const muLawData = this.pcmToMuLaw(resampledPcm);

    const chunkSize = 160;
    for (let i = 0; i < muLawData.length && !state.interrupted; i += chunkSize) {
      this.sendMediaChunk(state, muLawData.subarray(i, i + chunkSize));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private async listen(state: CallState): Promise<string> {
    console.error(`[${state.callId}] Listening...`);

    if (!state.sttSession) {
      throw new Error('STT session not available');
    }

    // Race between getting a transcript and detecting hangup
    const transcript = await Promise.race([
      state.sttSession.waitForTranscript(this.config.transcriptTimeoutMs),
      this.waitForHangup(state),
    ]);

    if (state.hungUp) {
      throw new Error('Call was hung up by user');
    }

    console.error(`[${state.callId}] User said: ${transcript}`);
    return transcript;
  }

  /**
   * Returns a promise that rejects when the call is hung up.
   * Used to race against transcript waiting.
   */
  private waitForHangup(state: CallState): Promise<never> {
    return new Promise((_, reject) => {
      const checkInterval = setInterval(() => {
        if (state.hungUp) {
          clearInterval(checkInterval);
          reject(new Error('Call was hung up by user'));
        }
      }, 100);  // Check every 100ms

      // Clean up interval after transcript timeout to avoid memory leaks
      setTimeout(() => {
        clearInterval(checkInterval);
      }, this.config.transcriptTimeoutMs + 1000);
    });
  }

  private resample24kTo8k(pcmData: Buffer): Buffer {
    const inputSamples = pcmData.length / 2;
    const outputSamples = Math.floor(inputSamples / 3);
    const output = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
      // Use linear interpolation instead of point-sampling to reduce artifacts
      // For each output sample, average the 3 surrounding input samples
      // This acts as a simple anti-aliasing low-pass filter
      const baseIdx = i * 3;
      const s0 = pcmData.readInt16LE(baseIdx * 2);
      const s1 = baseIdx + 1 < inputSamples ? pcmData.readInt16LE((baseIdx + 1) * 2) : s0;
      const s2 = baseIdx + 2 < inputSamples ? pcmData.readInt16LE((baseIdx + 2) * 2) : s1;
      const interpolated = Math.round((s0 + s1 + s2) / 3);
      output.writeInt16LE(interpolated, i * 2);
    }

    return output;
  }

  private pcmToMuLaw(pcmData: Buffer): Buffer {
    const muLawData = Buffer.alloc(Math.floor(pcmData.length / 2));
    for (let i = 0; i < muLawData.length; i++) {
      const pcm = pcmData.readInt16LE(i * 2);
      muLawData[i] = this.pcmToMuLawSample(pcm);
    }
    return muLawData;
  }

  private pcmToMuLawSample(pcm: number): number {
    const BIAS = 0x84;
    const CLIP = 32635;
    let sign = (pcm >> 8) & 0x80;
    if (sign) pcm = -pcm;
    if (pcm > CLIP) pcm = CLIP;
    pcm += BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--) {
      expMask >>= 1;
    }
    const mantissa = (pcm >> (exponent + 3)) & 0x0f;
    return (~(sign | (exponent << 4) | mantissa)) & 0xff;
  }

  getHttpServer() {
    return this.httpServer;
  }

  private _shutdownPromise: Promise<void> | null = null;

  shutdown(): Promise<void> {
    if (this._shutdownPromise) return this._shutdownPromise;
    this._shutdownPromise = this._doShutdown();
    return this._shutdownPromise;
  }

  private async _doShutdown(): Promise<void> {

    // End active calls with 5s timeout
    const endPromises = Array.from(this.activeCalls.keys()).map(callId =>
      this.endCall(callId, 'Goodbye!').catch(err =>
        console.error(`[shutdown] Failed to end ${callId}:`, err)
      )
    );
    const timeout = new Promise<void>(resolve => setTimeout(resolve, 5000));
    await Promise.race([Promise.allSettled(endPromises), timeout]);

    // Terminate all WebSocket clients
    this.wss?.clients.forEach(ws => ws.terminate());
    this.wss?.close();

    // Close HTTP server
    await new Promise<void>(resolve => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
