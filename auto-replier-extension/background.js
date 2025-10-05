// Try multiple possible Ollama endpoints
const OLLAMA_PORTS = [11434, 11500];
const BRIDGE_PORT = 5000;

// Check model availability periodically and notify any open popup
async function checkModelAvailability() {
  let modelAvailable = false;
  
  // Try Ollama ports
  for (const port of OLLAMA_PORTS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      
      const response = await fetch(`http://localhost:${port}/api/version`, {
        method: "GET",
        signal: controller.signal
      }).catch(() => null);
      
      clearTimeout(timeoutId);
      
      if (response && response.ok) {
        modelAvailable = true;
        break;
      }
    } catch (e) {
      console.debug(`Ollama not available on port ${port}:`, e);
    }
  }
  
  // If Ollama isn't available, try the bridge
  if (!modelAvailable) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      
      const response = await fetch(`http://localhost:${BRIDGE_PORT}/`, {
        method: "GET",
        signal: controller.signal
      }).catch(() => null);
      
      clearTimeout(timeoutId);
      
      if (response && response.ok) {
        modelAvailable = true;
      }
    } catch (e) {
      console.debug(`Bridge not available on port ${BRIDGE_PORT}:`, e);
    }
  }
  
  // Broadcast status to any open popup
  chrome.runtime.sendMessage({ 
    type: 'model_status_update',
    available: modelAvailable 
  }).catch(() => {}); // Ignore errors if popup isn't open
  
  return modelAvailable;
}

// Only check model availability, not authentication
checkModelAvailability();
setInterval(checkModelAvailability, 15000); // Check every 15 seconds

// OAuth config - using manifest.json oauth2 section
// No need to define client_id here as it's already in manifest.json
const SCOPES = ["https://www.googleapis.com/auth/gmail.send"];

function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    try {
      // The client_id is picked up from manifest.json's oauth2 section
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

async function requestDraft(emailBody, style = "polite, professional, concise", creativity = "balanced") {
  let lastError;
  
  // Check model availability first
  const modelAvailable = await checkModelAvailability();
  if (!modelAvailable) {
    chrome.runtime.sendMessage({
      type: "draft_error",
      error: "Local model is not available. Please start Ollama or the bridge server."
    });
    return;
  }

  // Helper to stream and forward partials/final from a ReadableStream that yields JSONL lines
  async function streamJsonl(res) {
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    if (!res.body) throw new Error("No stream body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    
    try {
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
    } catch (error) {
      console.error("Error streaming response:", error);
      throw error;
    }
  }

  // Utility: map creativity -> sampling options
  const sampling = (() => {
    switch ((creativity || 'balanced').toLowerCase()) {
      case 'precise':
        return { temperature: 0.3, top_p: 0.9, repeat_penalty: 1.15 };
      case 'creative':
        return { temperature: 0.9, top_p: 0.97, repeat_penalty: 1.05 };
      default:
        return { temperature: 0.6, top_p: 0.95, repeat_penalty: 1.1 };
    }
  })();

  // Clean up any extra content the model might add
  function cleanReply(text) {
    if (!text) return '';
    let t = text;
    // Remove common prefixes
    t = t.replace(/^\s*(Draft:|Response:|Reply:|Email:|Subject:[^\n]*\n)/gi, '');
    // Remove code fences if any
    t = t.replace(/^```[\s\S]*?```\s*$/gm, '').trim();
    // Collapse 3+ newlines to two
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    return t;
  }

  // Craft a concise, opinionated system prompt
  const systemPrompt = `You are a professional email assistant.
- Reply in the SAME language as the original message.
- Output only the reply body — no analysis, no meta notes, no quoted original.
- Keep it concise (<=120 words), clear, and action-oriented.
- Adopt this style: ${style}.
- If a sender display name is provided, use it exactly in the salutation (e.g., "Hi {name}" or "Dear {name}").
- If no clear name, use a neutral salutation like "Hello".
- End with a short appropriate sign-off (e.g., "Best regards," or "Thanks,").`;

  // Try Ollama ports first
  for (const port of OLLAMA_PORTS) {
    try {
      console.log(`Trying Ollama on port ${port}...`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
      
      const res = await fetch(`http://localhost:${port}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: "llama3.2",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: emailBody }
          ],
          stream: true,
          options: {
            temperature: sampling.temperature,
            top_p: sampling.top_p,
            repeat_penalty: sampling.repeat_penalty
          }
        })
      });
      
      clearTimeout(timeoutId);

      // stream and then clean at the end by intercepting the final message
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
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
          } catch (_) { /* ignore */ }
        }
        buffer = "";
      }
      chrome.runtime.sendMessage({ type: "final", content: cleanReply(full) });
      return; // success
    } catch (err) {
      lastError = err;
      console.warn(`Failed on Ollama port ${port}:`, err?.message || err);
      // try next port
    }
  }

  // Fallback: try local bridge at :5000 (if present)
  try {
    console.log(`Trying bridge server on port ${BRIDGE_PORT}...`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
    
    const res = await fetch(`http://localhost:${BRIDGE_PORT}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ 
        email: emailBody, 
        style,
        creativity
      })
    });
    
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errorText}`);
    }
    
    if (!res.body) {
      // try to read as text
      const text = await res.text();
      chrome.runtime.sendMessage({ type: "final", content: text });
      return;
    }

    // Stream plain text (assume chunks are partials) and clean at the end
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
    chrome.runtime.sendMessage({ type: "final", content: cleanReply(full) });
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
    const creativity = msg.creativity || 'balanced';
    const senderName = msg.senderName || '';
    // augment emailBody with a system instruction prefix including sender name hint
    let bodyForModel = msg.emailBody;
    if (senderName) {
      bodyForModel = `SenderDisplayName: ${senderName}\n\n` + bodyForModel;
    }
    requestDraft(bodyForModel, style, creativity);
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

        // Always clear any cached token first to ensure account chooser appears
        let cachedToken = null;
        try {
          cachedToken = await getAuthToken(false); // Check for existing token without UI
          
          if (cachedToken) {
            // If we have a token, remove it to force the account chooser
            await new Promise((res) => chrome.identity.removeCachedAuthToken({ token: cachedToken }, res));
          }
        } catch (e) {
          // No cached token or error getting it - that's fine, we'll get a new one
          console.log('No cached token available:', e?.message || 'unknown error');
        }

        // Now request interactive token which will show the browser account chooser
        // The interactive:true flag forces the UI to appear
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
          let errorText = await res.text();
          
          try {
            // Try to parse error as JSON to extract more detailed message
            const errorJson = JSON.parse(errorText);
            if (errorJson.error && errorJson.error.message) {
              errorText = errorJson.error.message;
            }
          } catch (e) {
            // Keep original error text if parsing fails
          }
          
          console.error(`Gmail API error: ${res.status}`, errorText);
          chrome.runtime.sendMessage({ 
            type: 'gmail_send_error', 
            error: `Send failed: ${res.status} - ${errorText}` 
          });
          return;
        }

        // Success! Send confirmation to popup
        console.log('Email sent successfully');
        chrome.runtime.sendMessage({ type: 'gmail_send_success' });
      } catch (e) {
        chrome.runtime.sendMessage({ type: 'gmail_send_error', error: (e && e.message) || String(e) });
      }
    })();
  }
});
