(() => {
  const micBtn = document.getElementById('mic-btn');
  const micLabel = document.getElementById('mic-label');
  const micIcon = document.getElementById('mic-icon');
  const langSelect = document.getElementById('lang-select');
  const voiceToggle = document.getElementById('voice-toggle');
  const clearBtn = document.getElementById('clear-btn');
  const transcriptEl = document.getElementById('transcript');
  const interimLine = document.getElementById('interim-line');
  const liveIndicator = document.getElementById('live-indicator');
  const summaryMeta = document.getElementById('summary-meta');
  const summaryBody = document.getElementById('summary-body');
  const connectionDot = document.getElementById('connection-dot');
  const connectionLabel = document.getElementById('connection-label');
  const elapsedEl = document.getElementById('elapsed');
  const unsupportedBanner = document.getElementById('unsupported-banner');

  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

  let ws = null;
  let wsReady = false;
  let recognition = null;
  let isListening = false; // user's intent: should we keep listening?
  let restartTimer = null;
  let elapsedTimer = null;
  let sessionStartedAt = null;
  let currentAssistantBubble = null;

  // ---------- WebSocket ----------

  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.addEventListener('open', () => {
      wsReady = true;
      setConnectionStatus(true);
    });

    ws.addEventListener('close', () => {
      wsReady = false;
      setConnectionStatus(false);
      setTimeout(connectWebSocket, 1500);
    });

    ws.addEventListener('error', () => {
      ws.close();
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleServerMessage(msg);
    });
  }

  function setConnectionStatus(connected) {
    connectionDot.classList.toggle('dot-on', connected);
    connectionDot.classList.toggle('dot-off', !connected);
    connectionLabel.textContent = connected ? '接続済み' : '再接続中…';
  }

  function sendToServer(obj) {
    if (wsReady && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'ai_start':
        currentAssistantBubble = addBubble('assistant', '', { pending: true });
        break;
      case 'ai_delta':
        if (currentAssistantBubble) {
          currentAssistantBubble.append(msg.text);
          scrollTranscriptToBottom();
        }
        break;
      case 'ai_done':
        if (currentAssistantBubble) {
          currentAssistantBubble.setDone(msg.text);
        }
        speak(msg.text);
        currentAssistantBubble = null;
        break;
      case 'summary_update':
        summaryBody.textContent = msg.summary;
        summaryMeta.textContent = `最終更新: ${new Date(msg.updatedAt).toLocaleTimeString('ja-JP')}`;
        break;
      case 'error':
        showError(msg.message);
        if (currentAssistantBubble) {
          currentAssistantBubble.remove();
          currentAssistantBubble = null;
        }
        break;
      default:
        break;
    }
  }

  // ---------- Transcript UI ----------

  // Returns a small controller instead of the raw element so streaming
  // updates never fight with the fixed "role" label node inside the bubble.
  function addBubble(role, text, { pending = false } = {}) {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${role}${pending ? ' pending' : ''}`;
    const label = document.createElement('span');
    label.className = 'role-label';
    label.textContent = role === 'user' ? 'あなた' : 'AI';
    bubble.appendChild(label);
    const body = document.createElement('span');
    body.className = 'body-text';
    body.textContent = text;
    bubble.appendChild(body);
    transcriptEl.appendChild(bubble);
    scrollTranscriptToBottom();

    return {
      append(chunk) {
        body.textContent += chunk;
      },
      setDone(finalText) {
        bubble.classList.remove('pending');
        body.textContent = finalText;
      },
      remove() {
        bubble.remove();
      },
    };
  }

  function scrollTranscriptToBottom() {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function showError(message) {
    const el = document.createElement('div');
    el.className = 'error-banner';
    el.textContent = message;
    transcriptEl.appendChild(el);
    scrollTranscriptToBottom();
  }

  // ---------- Speech recognition (unlimited duration via auto-restart) ----------

  function setupRecognition() {
    recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = langSelect.value;

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) {
          addBubble('user', text.trim());
          sendToServer({ type: 'transcript_final', text: text.trim() });
        } else {
          interim += text;
        }
      }
      interimLine.textContent = interim;
    };

    recognition.onerror = (event) => {
      // 'no-speech' and 'aborted' are routine — just keep going.
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        isListening = false;
        setListeningUI(false);
        showError('マイクの使用が許可されていません。ブラウザの設定を確認してください。');
      }
    };

    recognition.onend = () => {
      liveIndicator.classList.add('hidden');
      if (isListening) {
        // Browsers stop recognition after a while even in continuous mode.
        // Restart immediately so the session feels time-unlimited.
        restartTimer = setTimeout(() => {
          try {
            recognition.start();
            liveIndicator.classList.remove('hidden');
          } catch {
            /* already running — ignore */
          }
        }, 250);
      }
    };

    recognition.onstart = () => {
      liveIndicator.classList.remove('hidden');
    };
  }

  function startListening() {
    if (!SpeechRecognitionImpl) return;
    if (!recognition) setupRecognition();
    recognition.lang = langSelect.value;
    isListening = true;
    interimLine.textContent = '';
    try {
      recognition.start();
    } catch {
      /* ignore if already started */
    }
    setListeningUI(true);
    sessionStartedAt = sessionStartedAt || Date.now();
    startElapsedTimer();
  }

  function stopListening() {
    isListening = false;
    clearTimeout(restartTimer);
    if (recognition) recognition.stop();
    interimLine.textContent = '';
    setListeningUI(false);
  }

  function setListeningUI(listening) {
    micBtn.classList.toggle('listening', listening);
    micLabel.textContent = listening ? '会話を終える' : '会話を始める';
    micIcon.textContent = listening ? '⏹️' : '🎙️';
  }

  // ---------- Elapsed session timer ----------

  function startElapsedTimer() {
    if (elapsedTimer) return;
    elapsedTimer = setInterval(() => {
      const diff = Math.floor((Date.now() - sessionStartedAt) / 1000);
      const h = String(Math.floor(diff / 3600)).padStart(2, '0');
      const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
      const s = String(diff % 60).padStart(2, '0');
      elapsedEl.textContent = `${h}:${m}:${s}`;
    }, 1000);
  }

  // ---------- Text-to-speech ----------

  function speak(text) {
    if (!voiceToggle.checked || !window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = langSelect.value;
    window.speechSynthesis.speak(utterance);
  }

  // ---------- Controls ----------

  micBtn.addEventListener('click', () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  });

  langSelect.addEventListener('change', () => {
    if (recognition) recognition.lang = langSelect.value;
  });

  voiceToggle.addEventListener('change', () => {
    if (!voiceToggle.checked && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  });

  clearBtn.addEventListener('click', () => {
    transcriptEl.innerHTML = '';
    interimLine.textContent = '';
    summaryBody.textContent = '会話が始まると、ここに要約が自動更新されます。';
    summaryMeta.textContent = 'まだ要約はありません';
    sendToServer({ type: 'reset' });
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  });

  // ---------- Boot ----------

  if (!SpeechRecognitionImpl) {
    unsupportedBanner.classList.remove('hidden');
    micBtn.disabled = true;
    micLabel.textContent = '音声認識に非対応';
  }

  connectWebSocket();
})();
