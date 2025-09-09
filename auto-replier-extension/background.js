// Try multiple possible Ollama endpoints
const OLLAMA_PORTS = [11434, 11500];

// OAuth config (provided by user)
const CLIENT_ID = "414637726901-4511v6jodgo2qs6flf3bj57br81veg6i.apps.googleusercontent.com";
const EXTENSION_ID = "cpflhjagocchmjpngmpdnaeekbinmjem";
const REDIRECT_URI = `https://${EXTENSION_ID}.chromiumapp.org/`;
const SCOPES = ["https://www.googleapis.com/auth/gmail.send"];

function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    try {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(token);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// --- PKCE + launchWebAuthFlow helpers for manual OAuth (force account chooser) ---
// (PKCE helpers removed; using chrome.identity.getAuthToken flow)

async function requestDraft(emailBody, style = "concise, polite, <=120 words") {
  let lastError;

  // Helper to stream and forward partials/final from a ReadableStream that yields JSONL lines
  async function streamJsonl(res) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error("No stream body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        try {
          const payload = JSON.parse(line);
          const delta = payload?.message?.content || "";
          if (delta) {
            full += delta;
            chrome.runtime.sendMessage({ type: "partial", content: delta });
          }
          if (payload?.done) {
            chrome.runtime.sendMessage({ type: "final", content: full });
            return;
          }
        } catch (e) {
          // incomplete JSON chunk; continue accumulating
        }
      }
      buffer = "";
    }
    // stream ended without explicit done flag
    chrome.runtime.sendMessage({ type: "final", content: full });
  }

  // Try Ollama ports first
  for (const port of OLLAMA_PORTS) {
    try {
      const res = await fetch(`http://localhost:${port}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama3.2",
          messages: [
            { role: "system", content: `You are a professional email assistant. Follow these rules:\n- Always start with a short greeting addressing the sender by their display name if provided (e.g. "Hi Ronak,").\n- Keep the response in the same language as the original message.\n- Keep the reply ${style}.\n- Ask a polite clarifying question when helpful.\n- End with a sign-off: "Best regards, [Your Name]" and do not include any extra commentary or notes about being an AI.` },
            { role: "user", content: emailBody }
          ],
          stream: true
        })
      });

      await streamJsonl(res);
      return; // success
    } catch (err) {
      lastError = err;
      console.warn(`Failed on Ollama port ${port}:`, err?.message || err);
      // try next port
    }
  }

  // Fallback: try local bridge at :5000 (if present). Bridge expected to stream SSE or plain text lines.
  try {
    const res = await fetch("http://localhost:5000/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailBody, style })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) {
      // try to read as text
      const text = await res.text();
      chrome.runtime.sendMessage({ type: "final", content: text });
      return;
    }

    // Stream plain text (assume chunks are partials)
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      full += chunk;
      chrome.runtime.sendMessage({ type: "partial", content: chunk });
    }
    chrome.runtime.sendMessage({ type: "final", content: full });
    return;
  } catch (err) {
    lastError = err;
    console.warn("Fallback bridge failed:", err?.message || err);
  }

  // If all attempts fail
  chrome.runtime.sendMessage({
    type: "draft_error",
    error: `Could not connect to local model: ${lastError?.message || "unknown"}`
  });
}

// Listen from content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "generateDraft") {
    // prefer senderName if provided to craft salutation
    const style = msg.style || "concise, polite, <=120 words";
    const senderName = msg.senderName || '';
    // augment emailBody with a system instruction prefix including sender name hint
    let bodyForModel = msg.emailBody;
    if (senderName) {
      bodyForModel = `SenderDisplayName: ${senderName}\n\n` + bodyForModel;
    }
    requestDraft(bodyForModel, style);
  }
  // allow popup to clear any cached token so the account chooser appears next time
  if (msg.type === 'clearCachedToken') {
    (async () => {
      try {
        try {
          const t = await getAuthToken(false);
          if (t) {
            chrome.identity.removeCachedAuthToken({ token: t }, () => {
              chrome.runtime.sendMessage({ type: 'clearCachedToken_done' });
            });
          } else {
            chrome.runtime.sendMessage({ type: 'clearCachedToken_done' });
          }
        } catch (e) {
          // no cached token
          chrome.runtime.sendMessage({ type: 'clearCachedToken_done' });
        }
      } catch (e) {
        chrome.runtime.sendMessage({ type: 'clearCachedToken_error', error: (e && e.message) || String(e) });
      }
    })();
  }
  // popup requests to send mail via Gmail API
  if (msg.type === 'sendViaGmail') {
    (async () => {
      try {
        // msg should contain to, subject, body
        const { to, subject, body } = msg;

        // Try to get a cached token silently. If present, remove it to force account chooser.
        let cachedToken = null;
        try {
          cachedToken = await getAuthToken(false);
        } catch (e) {
          // no cached token
        }

        if (cachedToken) {
          try {
            await new Promise((res) => chrome.identity.removeCachedAuthToken({ token: cachedToken }, res));
          } catch (e) {
            // ignore removal errors
          }
        }

        // Now request interactive token which will show the browser account chooser
        const token = await getAuthToken(true);

        // Build raw MIME message and send via Gmail API
        function base64UrlEncode(str) {
          return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }

        const mime = [
          `To: ${to}`,
          `Subject: ${subject}`,
          'Content-Type: text/plain; charset="UTF-8"',
          '',
          body
        ].join('\r\n');

        const raw = base64UrlEncode(mime);

        const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw })
        });

        if (!res.ok) {
          const text = await res.text();
          chrome.runtime.sendMessage({ type: 'gmail_send_error', error: `Send failed: ${res.status} ${text}` });
          return;
        }

        chrome.runtime.sendMessage({ type: 'gmail_send_success' });
      } catch (e) {
        chrome.runtime.sendMessage({ type: 'gmail_send_error', error: (e && e.message) || String(e) });
      }
    })();
  }
});
