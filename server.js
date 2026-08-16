import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;

// Sonnet 5 answers the live conversation turns (quality + speed balance).
// Haiku 4.5 refreshes the running summary in the background (fast + cheap).
const CONVERSATION_MODEL = 'claude-sonnet-5';
const SUMMARY_MODEL = 'claude-haiku-4-5';

// Only the last N messages are ever sent to the conversation model. This is
// what makes the tool work for an unlimited-length session: token usage per
// request stays bounded no matter how long the user has been talking, while
// the rolling summary (below) keeps the model aware of everything earlier.
const MAX_HISTORY_MESSAGES = 20;

// The summary is refreshed once the unsummarized buffer grows past this many
// words, or this many milliseconds have passed since the last refresh —
// whichever comes first.
const SUMMARY_WORD_THRESHOLD = 50;
const SUMMARY_MIN_INTERVAL_MS = 15000;

const anthropic = new Anthropic(); // picks up ANTHROPIC_API_KEY / an `ant auth login` profile automatically

const CONVERSATION_SYSTEM_PROMPT = [
  'You are a warm, attentive conversational partner talking with the user in real time.',
  'The user is speaking to you out loud through speech-to-text, and your reply will be read back to them with text-to-speech, so:',
  '- Reply in natural spoken language: short sentences, no markdown, no bullet lists, no code blocks, no headings.',
  '- Keep answers conversational length (usually one to four sentences) unless the user clearly asks for more detail.',
  '- Respond in the same language the user is speaking.',
  "- If a running summary of the conversation so far is provided below, use it for context, but don't recite it back to the user.",
].join('\n');

function buildSummaryPrompt(previousSummary, newContent) {
  return [
    'You maintain a running summary of an ongoing spoken conversation between a user and an AI assistant.',
    'Update the summary so it incorporates the new content below. Keep it concise (no more than about 120 words), as short bullet points covering key topics, facts, decisions, and open questions.',
    'Do not repeat verbatim dialogue. Write in the same language the conversation is being held in. Output ONLY the updated summary text — no preamble, no headings, no meta-commentary.',
    '',
    `Previous summary (may be empty):\n${previousSummary || '(none yet)'}`,
    '',
    `New conversation content to incorporate:\n${newContent}`,
  ].join('\n');
}

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function createSession() {
  return {
    history: [], // { role: 'user' | 'assistant', content: string }
    summary: '',
    summaryBuffer: '',
    lastSummaryAt: Date.now(),
    summarizing: false,
  };
}

async function updateSummary(previousSummary, newContent) {
  const response = await anthropic.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 400,
    messages: [{ role: 'user', content: buildSummaryPrompt(previousSummary, newContent) }],
  });
  const block = response.content.find((b) => b.type === 'text');
  return block ? block.text.trim() : previousSummary;
}

function maybeRefreshSummary(ws, session) {
  if (session.summarizing) return;
  const buffered = session.summaryBuffer.trim();
  if (!buffered) return;

  const wordCount = buffered.split(/\s+/).filter(Boolean).length;
  const elapsed = Date.now() - session.lastSummaryAt;
  if (wordCount < SUMMARY_WORD_THRESHOLD && elapsed < SUMMARY_MIN_INTERVAL_MS) return;

  session.summarizing = true;
  const bufferToSummarize = session.summaryBuffer;
  session.summaryBuffer = '';
  session.lastSummaryAt = Date.now();

  updateSummary(session.summary, bufferToSummarize)
    .then((newSummary) => {
      session.summary = newSummary;
      safeSend(ws, { type: 'summary_update', summary: newSummary, updatedAt: new Date().toISOString() });
    })
    .catch((err) => {
      console.error('[summary] failed:', err.message);
      // Don't lose the content — fold it back in for the next attempt.
      session.summaryBuffer = `${bufferToSummarize}\n${session.summaryBuffer}`.trim();
    })
    .finally(() => {
      session.summarizing = false;
    });
}

async function handleUserTurn(ws, session, text) {
  session.history.push({ role: 'user', content: text });
  session.summaryBuffer += `${session.summaryBuffer ? '\n' : ''}User: ${text}`;

  const windowed = session.history.slice(-MAX_HISTORY_MESSAGES);
  const system = [{ type: 'text', text: CONVERSATION_SYSTEM_PROMPT }];
  if (session.summary) {
    system.push({ type: 'text', text: `Running summary of the conversation so far:\n${session.summary}` });
  }

  safeSend(ws, { type: 'ai_start' });

  let fullText = '';
  try {
    const stream = anthropic.messages.stream({
      model: CONVERSATION_MODEL,
      max_tokens: 1024,
      thinking: { type: 'disabled' }, // prioritize snappy, voice-conversation latency
      system,
      messages: windowed.map((m) => ({ role: m.role, content: m.content })),
    });

    stream.on('text', (delta) => {
      fullText += delta;
      safeSend(ws, { type: 'ai_delta', text: delta });
    });

    await stream.finalMessage();
  } catch (err) {
    console.error('[conversation] failed:', err.message);
    safeSend(ws, { type: 'error', message: 'AIの応答に失敗しました。もう一度お試しください。' });
    // Roll back the user turn we couldn't answer so history/summary stay consistent.
    session.history.pop();
    return;
  }

  session.history.push({ role: 'assistant', content: fullText });
  session.summaryBuffer += `\nAssistant: ${fullText}`;
  safeSend(ws, { type: 'ai_done', text: fullText });

  maybeRefreshSummary(ws, session);
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const session = createSession();
  safeSend(ws, { type: 'connected' });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'reset') {
      Object.assign(session, createSession());
      safeSend(ws, { type: 'reset_ack' });
      return;
    }

    if (msg.type === 'transcript_final') {
      const text = String(msg.text || '').trim();
      if (!text) return;
      handleUserTurn(ws, session, text).catch((err) => {
        console.error('[turn] unexpected error:', err);
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Realtime speech + AI summary tool listening on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('No ANTHROPIC_API_KEY set — relying on `ant auth login` credentials if present.');
  }
});
