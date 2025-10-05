const emailEl = document.getElementById("email");
const draftEl = document.getElementById("draft");
const styleEl = document.getElementById("style");
const genBtn = document.getElementById("gen");
const creativityEl = document.getElementById("creativity");
const copyBtn = document.getElementById("copy");
const sendBtn = document.getElementById("send");
const modelStatusIndicator = document.getElementById("model-status");
const modelStatusText = document.getElementById("model-status-text");
const toastEl = document.getElementById("toast");

let draftAccum = "";
let detectedSenderName = '';
let detectedSenderEmail = '';
let modelAvailable = false;
let isGenerating = false;

// Check if model is available when popup opens
checkModelAvailability();

// Show toast message function
function showToast(message, duration = 3000) {
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  setTimeout(() => {
    toastEl.classList.remove('visible');
  }, duration);
}

// Function to check if local model is available
async function checkModelAvailability() {
  modelStatusIndicator.className = "status-indicator status-offline";
  modelStatusText.textContent = "Checking model...";
  
  const endpoints = [
    "http://localhost:11434/api/version",
    "http://localhost:11500/api/version",
    "http://localhost:5000/"
  ];
  
  for (const url of endpoints) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal
      }).catch(() => null);
      
      clearTimeout(timeoutId);
      
      if (response && response.ok) {
        modelAvailable = true;
        modelStatusIndicator.className = "status-indicator status-online";
        modelStatusText.textContent = "Model ready";
        genBtn.disabled = false;
        return;
      }
    } catch (e) {
      console.log(`Endpoint ${url} not available:`, e);
    }
  }
  
  // If we get here, all endpoints failed
  modelStatusIndicator.className = "status-indicator status-offline";
  modelStatusText.textContent = "Model offline";
  genBtn.disabled = true;
  showToast("Local model not available. Please start Ollama or bridge server.", 5000);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "pageEmailExtracted") {
    if (!emailEl.value) emailEl.value = msg.body;
    if (msg.senderName) detectedSenderName = msg.senderName;
    if (msg.senderEmail) detectedSenderEmail = msg.senderEmail;
  } else if (msg.type === "partial") {
    draftAccum += msg.content;
    draftEl.value = draftAccum;
    // Auto-scroll to bottom as content comes in
    draftEl.scrollTop = draftEl.scrollHeight;
  } else if (msg.type === "final") {
    draftAccum = msg.content;
    draftEl.value = draftAccum;
    genBtn.textContent = "Generate";
    genBtn.disabled = false;
    isGenerating = false;
    showToast("Draft generated successfully", 2000);
    // Count words for a subtle indication
    const wordCount = draftAccum.split(/\s+/).filter(Boolean).length;
    draftEl.setAttribute('data-words', `${wordCount} words`);
  } else if (msg.type === "draft_error") {
    showToast("Error: " + msg.error, 4000);
    genBtn.textContent = "Generate";
    genBtn.disabled = false;
    isGenerating = false;
    draftEl.value = "";
  } else if (msg.type === 'gmail_send_success') {
    showToast('Email sent successfully!', 3000);
    sendBtn.textContent = "Send";
    sendBtn.disabled = false;
  } else if (msg.type === 'gmail_send_error') {
    showToast('Send error: ' + msg.error, 4000);
    sendBtn.textContent = "Send";
    sendBtn.disabled = false;
    
    // If it's an OAuth error, log it for debugging but don't try alternate method
    // since we've now centralized auth in the background page
    if (msg.error && (msg.error.includes('Auth') || msg.error.includes('token') || msg.error.includes('OAuth'))) {
      console.error('OAuth error detected:', msg.error);
      
      // Ask user if they want to try again after a brief pause
      setTimeout(() => {
        if (confirm('Authentication error. Would you like to try again?')) {
          // Get the current data from the form
          const body = draftEl.value || '';
          const src = emailEl.value || '';
          const m = src.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          let to = m ? m[0] : '';
          
          if (!to) {
            to = prompt('Enter recipient email:');
            if (!to) return;
          }
          
          const firstLine = body.split('\n')[0];
          const subject = firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
          
          // Try sending again
          sendViaGmailAPI(to, subject, body);
        }
      }, 1000);
    }
  } else if (msg.type === 'model_status_update') {
    modelAvailable = msg.available;
    modelStatusIndicator.className = msg.available ? 
      "status-indicator status-online" : 
      "status-indicator status-offline";
    modelStatusText.textContent = msg.available ? 
      "Model ready" : 
      "Model offline";
    genBtn.disabled = !msg.available;
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

// Don't clear auth token on popup open - only when Send is pressed
// This prevents the account chooser from appearing until needed

genBtn.addEventListener("click", () => {
  if (!modelAvailable) {
    showToast("Local model not available. Please start Ollama or bridge server.", 3000);
    checkModelAvailability(); // Try again
    return;
  }
  
  if (isGenerating) {
    showToast("Already generating a response...", 2000);
    return;
  }
  
  if (!emailEl.value.trim()) {
    showToast("Please provide an email to respond to", 2000);
    emailEl.focus();
    return;
  }
  
  // Clear previous draft and show loading state
  draftAccum = "";
  draftEl.value = "Generating...";
  genBtn.textContent = `Generating (${creativityEl.value})...`;
  genBtn.disabled = true;
  isGenerating = true;
  
  chrome.runtime.sendMessage({
    type: "generateDraft",
    emailBody: emailEl.value.trim(),
    senderName: detectedSenderName || '',
    style: styleEl.value || "polite, professional, concise",
    creativity: creativityEl.value || 'balanced'
  });
});

copyBtn.addEventListener("click", async () => {
  if (!draftEl.value.trim()) {
    showToast("Nothing to copy", 2000);
    return;
  }
  
  try {
    await navigator.clipboard.writeText(draftEl.value);
    copyBtn.textContent = "Copied!";
    showToast("Draft copied to clipboard", 1500);
    setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
  } catch (error) {
    showToast("Failed to copy: " + error.message, 3000);
  }
});

sendBtn.addEventListener("click", () => {
  if (!draftEl.value.trim()) {
    showToast("Please generate a draft first", 2000);
    return;
  }
  
  // Try to extract recipient email from the source email text area
  const src = emailEl.value || "";
  const m = src.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  let to = m ? m[0] : "";
  
  // Generate a more meaningful subject line from the draft or source
  let subject = "";
  if (draftEl.value.trim()) {
    // Extract first line or first few words for the subject
    const firstLine = draftEl.value.split('\n')[0];
    subject = firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
  } else {
    subject = "Reply: " + (document.title || "Email Response");
  }
  
  // If we couldn't find a recipient email automatically, ask the user
  if (!to) {
    const manual = prompt('Could not find recipient email. Please enter recipient email address:');
    
    // If user cancels the prompt, abort the send operation
    if (!manual) {
      return;
    }
    
    // Basic email validation
    const mm = manual.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (!mm) {
      showToast('Invalid email address format', 3000);
      return;
    }
    
    to = mm[0]; // Use the validated email
  }

  // Update UI to show we're starting the send process
  sendBtn.textContent = "Authenticating...";
  sendBtn.disabled = true;
  showToast('Starting Gmail authentication process...', 2500);
  
  // This will trigger the account chooser dialog through the background page
  sendViaGmailAPI(to, subject, draftEl.value || '');
});

// These functions have been moved to background.js since we're delegating auth and sending there

function sendViaGmailAPI(to, subject, body) {
  // Show toast and update button state
  showToast('Google account chooser will appear shortly...', 2500);
  sendBtn.textContent = "Authenticating...";
  sendBtn.disabled = true;
  
  // Use background page for authentication and sending to avoid popup-specific issues
  // This ensures a consistent experience and moves OAuth handling to the background
  chrome.runtime.sendMessage({
    type: 'sendViaGmail',
    to: to,
    subject: subject,
    body: body
  });
  
  // Button state and user feedback will be updated when we get a response
  // from the background script (handled in the message listener above)
}