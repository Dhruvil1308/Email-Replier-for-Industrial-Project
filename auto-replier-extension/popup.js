const emailEl = document.getElementById("email");
const draftEl = document.getElementById("draft");
const styleEl = document.getElementById("style");
const genBtn = document.getElementById("gen");
const copyBtn = document.getElementById("copy");
const sendBtn = document.getElementById("send");

let draftAccum = "";
let detectedSenderName = '';
let detectedSenderEmail = '';

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "pageEmailExtracted") {
  if (!emailEl.value) emailEl.value = msg.body;
  if (msg.senderName) detectedSenderName = msg.senderName;
  if (msg.senderEmail) detectedSenderEmail = msg.senderEmail;
  } else if (msg.type === "partial") {
    draftAccum += msg.content;
    draftEl.value = draftAccum;
  } else if (msg.type === "final") {
    draftAccum = msg.content;
    draftEl.value = draftAccum;
  } else if (msg.type === "draft_error") {
    alert("Draft error: " + msg.error);
  } else if (msg.type === 'gmail_send_success') {
    alert('Message sent');
  } else if (msg.type === 'gmail_send_error') {
    alert('Send error: ' + msg.error);
  }
});

// On popup open, try to load the last extracted email from storage so the popup
// is populated even if the extraction happened before the popup was opened.
if (chrome && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get(["lastEmailExtracted"], (res) => {
    try {
      if (res && res.lastEmailExtracted && !emailEl.value) {
        emailEl.value = res.lastEmailExtracted;
      }
    } catch (e) {
      // ignore storage read errors
    }
  });
}

// Also load last sender info so recipient can be auto-filled
if (chrome && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get(["lastSenderName","lastSenderEmail"], (res) => {
    try {
      if (res) {
        detectedSenderName = res.lastSenderName || detectedSenderName;
        detectedSenderEmail = res.lastSenderEmail || detectedSenderEmail;
      }
    } catch (e) {}
  });
}

// Ask the active tab to run extraction when the popup opens so the latest message is fetched.
function requestActiveTabExtraction() {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs.length) return;
      const tab = tabs[0];
      // send a request to the content script to extract immediately
      chrome.tabs.sendMessage(tab.id, { type: 'requestExtraction' }, (resp) => {
        try {
          if (resp && resp.body && !emailEl.value) {
            emailEl.value = resp.body;
          }
        } catch (e) {}
      });
    });
  } catch (e) {
    // ignore
  }
}

// Try immediate extraction, then try again shortly to handle delayed content script injection
requestActiveTabExtraction();
setTimeout(requestActiveTabExtraction, 700);

// Clear any cached auth token so the account chooser will be shown when Send is pressed.
try {
  chrome.runtime.sendMessage({ type: 'clearCachedToken' });
} catch (e) {
  // ignore
}

genBtn.addEventListener("click", () => {
  draftAccum = "";
  chrome.runtime.sendMessage({
    type: "generateDraft",
  emailBody: emailEl.value.trim(),
  senderName: detectedSenderName || '',
    style: styleEl.value.trim() || "concise, polite, <=120 words"
  });
});

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(draftEl.value);
  copyBtn.textContent = "Copied!";
  setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
});

sendBtn.addEventListener("click", () => {
  // Try to extract recipient email from the source email text area
  const src = emailEl.value || "";
  const m = src.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const to = m ? m[0] : "";
  const subject = document.title || "";
  if (!to) {
    const manual = prompt('Could not find recipient email. Please enter recipient email address:');
    if (!manual) return;
    // basic validation
    const mm = manual.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (!mm) {
      alert('Invalid email address');
      return;
    }
    // send using background which will handle auth and send
    chrome.runtime.sendMessage({ type: 'sendViaGmail', to: mm[0], subject: subject || '', body: draftEl.value || '' });
    return;
  }

  // Send via Gmail API through background
  chrome.runtime.sendMessage({ type: 'sendViaGmail', to, subject: subject || '', body: draftEl.value || '' });
});

function base64UrlEncode(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeMimeMessage(to, subject, body) {
  const mime = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body
  ].join('\r\n');
  return base64UrlEncode(mime);
}

function sendViaGmailAPI(to, subject, body) {
  // Force the account chooser each time by removing any cached token first
  chrome.identity.getAuthToken({ interactive: false }, (cachedToken) => {
    if (cachedToken) {
      // remove cached token to force re-consent/account chooser
      chrome.identity.removeCachedAuthToken({ token: cachedToken }, () => {
        // now request interactive token which will show account chooser
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
          if (chrome.runtime.lastError || !token) {
            alert('Auth failed: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message));
            return;
          }
          const raw = makeMimeMessage(to, subject, body);
          fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw })
          }).then(r => {
            if (!r.ok) throw new Error('Send failed ' + r.status);
            alert('Message sent');
          }).catch(e => alert('Send error: ' + e.message));
        });
      });
    } else {
      // no cached token, request interactive directly
      chrome.identity.getAuthToken({ interactive: true }, (token) => {
        if (chrome.runtime.lastError || !token) {
          alert('Auth failed: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message));
          return;
        }
        const raw = makeMimeMessage(to, subject, body);
        fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw })
        }).then(r => {
          if (!r.ok) throw new Error('Send failed ' + r.status);
          alert('Message sent');
        }).catch(e => alert('Send error: ' + e.message));
      });
    }
  });
}