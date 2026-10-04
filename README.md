# CallMe

**Minimal plugin that lets Claude Code call you on the phone.**

Start a task, walk away. Your phone/watch rings when Claude is done, stuck, or needs a decision.

<img src="./call-me-comic-min.png" width="800" alt="CallMe comic strip">

- **Minimal plugin** - Does one thing: call you on the phone. No crazy setups.
- **Multi-turn conversations** - Talk through decisions naturally.
- **Works anywhere** - Smartphone, smartwatch, or even landline!
- **Tool-use composable** - Claude can e.g. do a web search while on a call with you.

---

## Quick Start

### 1. Get Required Accounts

You'll need:
- **Phone provider**: [Telnyx](https://telnyx.com) or [Twilio](https://twilio.com)
- **OpenAI API key**: For speech-to-text (and text-to-speech if not using Kokoro)
- **ngrok account**: Free at [ngrok.com](https://ngrok.com) (for webhook tunneling)

### 2. Set Up Phone Provider

Choose **one** of the following:

<details>
<summary><b>Option A: Telnyx (Recommended - 50% cheaper)</b></summary>

1. Create account at [portal.telnyx.com](https://portal.telnyx.com) and verify your identity
2. [Buy a phone number](https://portal.telnyx.com/#/numbers/buy-numbers) (~$1/month)
3. [Create a Voice API application](https://portal.telnyx.com/#/call-control/applications):
   - Set webhook URL to `https://your-ngrok-url/twiml` and API version to v2
     - You can see your ngrok URL on the ngrok dashboard
   - Note your **Application ID** and **API Key**
4. [Verify the phone number](https://portal.telnyx.com/#/numbers/verified-numbers) you want to receive calls at
5. (Optional but recommended) Get your **Public Key** from Account Settings > Keys & Credentials for webhook signature verification

**Environment variables for Telnyx:**
```bash
CALLME_PHONE_PROVIDER=telnyx
CALLME_PHONE_ACCOUNT_SID=<Application ID>
CALLME_PHONE_AUTH_TOKEN=<API Key>
CALLME_TELNYX_PUBLIC_KEY=<Public Key>  # Optional: enables webhook security
```

</details>

<details>
<summary><b>Option B: Twilio (Not recommended - need to buy $20 of credits just to start and more expensive overall)</b></summary>

1. Create account at [twilio.com/console](https://www.twilio.com/console)
2. Use the free number your account comes with or [buy a new phone number](https://www.twilio.com/console/phone-numbers/incoming) (~$1.15/month)
3. Find your **Account SID** and **Auth Token** on the [Console Dashboard](https://www.twilio.com/console)

**Environment variables for Twilio:**
```bash
CALLME_PHONE_PROVIDER=twilio
CALLME_PHONE_ACCOUNT_SID=<Account SID>
CALLME_PHONE_AUTH_TOKEN=<Auth Token>
```

</details>

### 3. Set Environment Variables

Add these to `~/.claude/settings.json` (recommended) or export them in your shell:

```json
{
  "env": {
    "CALLME_PHONE_PROVIDER": "telnyx",
    "CALLME_PHONE_ACCOUNT_SID": "your-connection-id-or-account-sid",
    "CALLME_PHONE_AUTH_TOKEN": "your-api-key-or-auth-token",
    "CALLME_PHONE_NUMBER": "+15551234567",
    "CALLME_USER_PHONE_NUMBER": "+15559876543",
    "CALLME_OPENAI_API_KEY": "sk-...",
    "CALLME_NGROK_AUTHTOKEN": "your-ngrok-token"
  }
}
```

#### Required Variables

| Variable | Description |
|----------|-------------|
| `CALLME_PHONE_PROVIDER` | `telnyx` (default) or `twilio` |
| `CALLME_PHONE_ACCOUNT_SID` | Telnyx Connection ID or Twilio Account SID |
| `CALLME_PHONE_AUTH_TOKEN` | Telnyx API Key or Twilio Auth Token |
| `CALLME_PHONE_NUMBER` | Phone number Claude calls from (E.164 format) |
| `CALLME_USER_PHONE_NUMBER` | Your phone number to receive calls |
| `CALLME_OPENAI_API_KEY` | OpenAI API key (required for STT; also for TTS unless using Kokoro) |
| `CALLME_NGROK_AUTHTOKEN` | ngrok auth token for webhook tunneling |

#### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CALLME_TTS_PROVIDER` | `openai` | TTS engine: `openai` or `kokoro` (free, local — see [Kokoro TTS](#kokoro-tts-free-local)) |
| `CALLME_TTS_VOICE` | `onyx` / `af_bella` | Voice name (default depends on TTS provider) |
| `CALLME_KOKORO_URL` | - | URL of existing Kokoro instance (e.g. `http://localhost:8880/v1`). If unset, auto-starts Docker container |
| `CALLME_PORT` | `0` (auto) | Local HTTP server port (0 = OS picks a free port) |
| `CALLME_NGROK_DOMAIN` | - | Custom ngrok domain (paid feature) |
| `CALLME_TRANSCRIPT_TIMEOUT_MS` | `180000` | Timeout for user speech (3 minutes) |
| `CALLME_STT_SILENCE_DURATION_MS` | `800` | Silence duration to detect end of speech |
| `CALLME_TELNYX_PUBLIC_KEY` | - | Telnyx public key for webhook signature verification (recommended) |

### 4. Install Plugin

```bash
/plugin marketplace add ZeframLou/call-me
/plugin install callme@callme
```

Restart Claude Code. Done!

### Other agents: Codex, Muse, and anything with a shell

The MCP server (`server/src/index.ts`) is a plain stdio server — only the
plugin packaging above is Claude Code-specific. Steps 1–3 (provider accounts
and environment variables) are the same for every agent.

**Codex.** Point Codex at the same server. Add to `~/.codex/config.toml`:

```toml
[mcp_servers.callme]
command = "bun"
args = ["run", "/absolute/path/to/call-me/server/src/index.ts"]
tool_timeout_sec = 300

[mcp_servers.callme.env]
CALLME_PHONE_PROVIDER = "telnyx"
CALLME_PHONE_ACCOUNT_SID = "your-connection-id"
CALLME_PHONE_AUTH_TOKEN = "your-api-key"
CALLME_PHONE_NUMBER = "+15551234567"
CALLME_USER_PHONE_NUMBER = "+15559876543"
CALLME_OPENAI_API_KEY = "sk-..."
CALLME_NGROK_AUTHTOKEN = "your-ngrok-token"
```

(Or: `codex mcp add callme -- bun run /absolute/path/to/call-me/server/src/index.ts`,
then restart Codex.) Calls can take a few minutes — the raised
`tool_timeout_sec` keeps Codex from giving up mid-conversation.

**Muse / shell agents (no MCP client needed).** This fork adds a standalone
CLI that drives the same call flow without an MCP client:

```bash
cd server
bun run call --message "Hey! Your build finished. Want me to deploy it?"
```

The user's spoken reply is printed to stdout so the agent can capture it.
Options:

```bash
bun run call --message "..." --goodbye "Talk soon!"   # closing line
bun run call --message "..." --interactive             # follow-up prompts on stdin (empty line hangs up)
```

Set `CALLME_TRANSCRIPT_TIMEOUT_MS` to bound how long each listen waits for a
reply (default 180000 ms). Same `CALLME_*` environment variables as above.

### Inbound mode: dial your number and talk to an agent

The reverse direction also works. Instead of the agent calling you, **you
call your Telnyx number** and get bridged into a voice conversation with
Claude Code or Codex:

```bash
cd server
bun run inbound --backend claude-code
bun run inbound --backend codex --greeting "Hey! Codex here. What's up?"
bun run inbound --backend hermes
```

How it works: the server answers the incoming call, transcribes what you say,
sends it to the agent CLI in non-interactive mode (`claude -p` /
`codex exec`, with the full conversation history in the prompt), and speaks
the agent's reply back. Say "goodbye" (or just hang up) to end the call.

Setup is the same webhook you already configured for outbound calls — in the
Telnyx portal, point your number's Voice API application at
`https://<your-ngrok-url>/twiml`. Then run the command above and dial
`CALLME_PHONE_NUMBER`.

Options:

```bash
bun run inbound --backend codex --cwd ~/my-project   # agent's working directory
bun run inbound --backend claude-code --backend-timeout-ms 180000
bun run inbound --backend codex --no-stream          # wait for the full reply before speaking
```

**Latency.** By default the agent's reply is *streamed*: the CLI runs with
`--output-format stream-json` (Claude Code) or `--json` (Codex), partial
text is split into sentences, and each sentence goes to TTS as soon as it
completes — so you hear the first sentence while the agent is still
generating the rest. Streaming is message-level, not token-level, so the
biggest win is on longer or multi-part replies. Fenced code blocks are
dropped rather than read aloud.

Security notes:

- **Inbound requires Telnyx** (`CALLME_PHONE_PROVIDER=telnyx`). Twilio
  inbound is not implemented yet.
- **Caller allowlist.** By default only `CALLME_USER_PHONE_NUMBER` (you) can
  call in — anyone else is hung up immediately. Add numbers with
  `CALLME_INBOUND_ALLOW_FROM=+15551234567,+15557654321`. Setting it empty
  allows any caller (not recommended: strangers would get a voice line into
  your coding agents) — and if there's no PIN either, inbound **refuses to
  start** rather than open the line to anyone who dials.
- **Spoken PIN (optional).** Set `CALLME_INBOUND_PIN=<digits>` and callers
  must say it before reaching the agent ("one two three four" or "twelve
  thirty four" both work). Three wrong tries and the call hangs up. The PIN
  is kept out of the conversation sent to the agent. Leave it empty to rely
  on the allowlist alone, which is reasonable when the people who call are
  the only ones on it — one less thing to get wrong over a phone codec,
  where a single spoken number is the hardest thing for a transcriber to
  get right. Note the match is a substring of the digits heard, so a long
  spoken digit string effectively gets several guesses per attempt; the
  allowlist is the stronger control of the two.
- **Turn-taking chimes.** Two short tones bracket each of the caller's
  turns: rising when the line starts listening, falling once it has decided
  they finished and is working on it. On a phone the only other cue is
  silence, which is indistinguishable from the agent thinking or the call
  having dropped — and it lets you shorten
  `CALLME_STT_SILENCE_DURATION_MS` without the pauses feeling like dead
  air. Set `CALLME_CHIMES=false` to turn them off.
- **Barge-in.** `CALLME_BARGE_IN=true` (the default) lets the caller talk
  over the agent: playback stops and what they say becomes the next turn.
  Set it to `false` if background noise or a speakerphone keeps cutting the
  agent off.
- **Say "stop".** While the agent is thinking, speaking gets "Claude Code is
  thinking. Say stop to interrupt." Saying "stop" (or "cancel") then kills
  the agent's turn. Saying it while the agent is talking cuts the speech off.
  Either way the call answers "Listening." and waits for the next request.
  This works whether barge-in is on or off.
- **Hermes.** `--backend hermes` runs [Hermes Agent](https://github.com/NousResearch/hermes-agent)
  in one-shot mode (`hermes -z`). Pass flags with `CALLME_HERMES_EXTRA_ARGS`,
  e.g. `--yolo` to skip command approval prompts.
- **Pick an agent by voice.** `CALLME_INBOUND_MENU=claude-code,hermes` makes
  the call ask "Say Claude or Hermes." after the PIN. Mid-call, a short
  command like "switch to Hermes" changes agents (each starts fresh).
- **One number per agent.** `CALLME_INBOUND_ROUTES=+15551234567=claude-code,+15557654321=hermes`
  sends each dialed number straight to its agent with no menu. All numbers
  must be on the same Telnyx Voice API application.
- **Caller names.** Set `CALLME_CALLER_NAMES=+15551234567=Alice,+15557654321=Bob`
  so the greeting and the agent's prompt use the caller's name. Unnamed
  callers get a generic greeting.
- Codex runs with a **read-only sandbox**, so approval prompts can't stall a
  call. Claude Code follows your normal CLI permissions for tool use.
  To let it act without approval prompts, set
  `CALLME_CLAUDE_EXTRA_ARGS=--dangerously-skip-permissions` (it can then run
  any command, so keep the caller allowlist tight).
- **Response time: trim the MCP servers.** Every turn spawns a fresh
  `claude -p`, and that process connects to all of your configured MCP
  servers before the model sees a word. On a machine with nine global
  servers this measured ~4.6s of cold start per turn; restricting it to two
  cut that to ~2.7s. Add `--strict-mcp-config` to use *only* the servers in
  a config you name, and keep just the ones worth having on a phone call:

  ```bash
  # ~/phone-mcp.json — only what the agent needs while on a call
  { "mcpServers": { "perplexity": { ... }, "memory": { ... } } }
  ```
  ```bash
  CALLME_CLAUDE_EXTRA_ARGS="--dangerously-skip-permissions --strict-mcp-config --mcp-config /path/to/phone-mcp.json"
  ```

  Built-in tools (Bash, Read, Edit, …) are not MCP servers and are
  unaffected, so the agent can still do things — it just stops paying to
  dial up servers it won't use. `--strict-mcp-config` with no
  `--mcp-config` loads none at all. Worth skipping any server that *talks
  to the call itself*, since it can't be used from inside a turn anyway.

---

## How It Works

```
Claude Code                    CallMe MCP Server (local)
    │                                    │
    │  "I finished the feature..."       │
    ▼                                    ▼
Plugin ────stdio──────────────────► MCP Server
                                         │
                                         ├─► ngrok tunnel
                                         │
                                         ▼
                                   Phone Provider (Telnyx/Twilio)
                                         │
                                         ▼
                                   Your Phone rings
                                   You speak
                                   Text returns to Claude
```

The MCP server runs locally and automatically creates an ngrok tunnel for phone provider webhooks.

---

## Tools

### `initiate_call`
Start a phone call.

```typescript
const { callId, response } = await initiate_call({
  message: "Hey! I finished the auth system. What should I work on next?"
});
```

### `continue_call`
Continue with follow-up questions.

```typescript
const response = await continue_call({
  call_id: callId,
  message: "Got it. Should I add rate limiting too?"
});
```

### `speak_to_user`
Speak to the user without waiting for a response. Useful for acknowledging requests before time-consuming operations.

```typescript
await speak_to_user({
  call_id: callId,
  message: "Let me search for that information. Give me a moment..."
});
// Continue with your long-running task
const results = await performSearch();
// Then continue the conversation
const response = await continue_call({
  call_id: callId,
  message: `I found ${results.length} results...`
});
```

### `end_call`
End the call.

```typescript
await end_call({
  call_id: callId,
  message: "Perfect, I'll get started. Talk soon!"
});
```

---

## Costs

| Service | Telnyx | Twilio |
|---------|--------|--------|
| Outbound calls | ~$0.007/min | ~$0.014/min |
| Phone number | ~$1/month | ~$1.15/month |

Plus API costs (same for both phone providers):
- **Speech-to-text**: ~$0.006/min (OpenAI gpt-4o-transcribe)
- **Text-to-speech**: ~$0.02/min (OpenAI TTS) or **free** with Kokoro

**Total**: ~$0.03-0.04/minute with OpenAI TTS, ~$0.01-0.02/minute with Kokoro

---

## Kokoro TTS (Free, Local)

[Kokoro](https://github.com/remsky/Kokoro-FastAPI) is a free, local text-to-speech engine that runs via Docker. No TTS API key needed — just set one env var (note: `CALLME_OPENAI_API_KEY` is still required if you use the OpenAI API for speech-to-text):

```bash
CALLME_TTS_PROVIDER=kokoro
```

**Auto-setup:** If Docker is installed and port 8880 is free, the plugin automatically pulls and starts the Kokoro container on first use.

**Existing instance:** If you already have Kokoro running (or want a custom port), point to it:

```bash
CALLME_TTS_PROVIDER=kokoro
CALLME_KOKORO_URL=http://localhost:8880/v1
```

**Voices:** Kokoro has different voices than OpenAI. Query available voices at `http://localhost:8880/v1/audio/voices`. Popular choices: `af_bella`, `af_sky`, `am_adam`. Set with `CALLME_TTS_VOICE`.

**Requirements:** Docker (for auto-setup) or an existing Kokoro instance.

---

## Troubleshooting

### Claude doesn't use the tool
1. Check all required environment variables are set (ideally in `~/.claude/settings.json`)
2. Restart Claude Code after installing the plugin
3. Try explicitly: "Call me to discuss the next steps when you're done."

### Call doesn't connect
1. Check the MCP server logs (stderr) with `claude --debug`
2. Verify your phone provider credentials are correct
3. Make sure ngrok can create a tunnel

### Audio issues
1. Ensure your phone number is verified with your provider
2. Check that the webhook URL in your provider dashboard matches your ngrok URL

### ngrok errors
1. Verify your `CALLME_NGROK_AUTHTOKEN` is correct
2. Check if you've hit ngrok's free tier limits
3. Try a different port with `CALLME_PORT=3334`

---

## Development

```bash
cd server
bun install
bun run dev
```

---

## License

MIT
