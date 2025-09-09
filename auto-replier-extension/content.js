function extractGmail() {
  // Try many selectors because Gmail DOM changes across clients/updates.
  const selectors = [
    "div.a3s.aiL",
    "div.a3s",
    "div.ii.gt",
    "div.adn .a3s",
    "div.im .a3s",
    "div[role='article'] div.a3s",
    "div[role='document']",
    "div[data-message-id]",
    "div[aria-label='Message Body']",
  ];

  // Collect nodes for all selectors and pick the last visible non-empty one
  let candidates = [];
  selectors.forEach(sel => {
    try {
      const found = document.querySelectorAll(sel);
      if (found && found.length) {
        found.forEach(n => candidates.push(n));
      }
    } catch (e) {
      // ignore bad selectors
    }
  });

  // dedupe preserving order
  candidates = Array.from(new Set(candidates));

  // choose last candidate with visible text
  for (let i = candidates.length - 1; i >= 0; --i) {
    const n = candidates[i];
    if (!n) continue;
    const text = (n.innerText || "").trim();
    if (text && text.length > 10) {
      console.debug("content.js: extractGmail -> selected selector text length", text.length);
      return text;
    }
  }

  // As a last resort, collect all visible text from the message thread area
  const main = document.querySelector("[role='main']");
  if (main && main.innerText && main.innerText.trim().length > 30) {
    console.debug("content.js: extractGmail -> fallback main text");
    return main.innerText.trim();
  }

  return "";
}

function extractOutlook() {
  const n = document.querySelector("[role='document']");
  return (n && n.innerText) ? n.innerText.trim() : "";
}

function detectAndSend() {
  let body = "";
  const host = window.location.host;
  if (host.includes("mail.google.com")) body = extractGmail();
  if (host.includes("outlook.office.com")) body = extractOutlook();
  if (body) {
    // attempt to extract sender name and email using a few heuristics
    function extractSenderInfo() {
      try {
        // 1) look for mailto link in header
        const mailto = document.querySelector("a[href^='mailto:']");
        if (mailto) {
          const email = (mailto.getAttribute('href')||'').replace('mailto:', '').split('?')[0];
          const name = (mailto.innerText || '').trim() || email.split('@')[0];
          return { name, email };
        }

        // 2) look for common "Name <email>" patterns in nearby header text
        const headerCandidate = document.querySelector("[role='heading'], h3, header, .gK, .gD");
        const headerText = headerCandidate ? headerCandidate.innerText : document.body.innerText.slice(0, 400);
        const m = headerText && headerText.match(/([A-Za-z .'-]{2,60})\s*<\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s*>/);
        if (m) return { name: m[1].trim(), email: m[2].trim() };

        // 3) search for a From: header in the first screenful of text
        const bodyStart = document.body.innerText.slice(0, 800);
        const fromMatch = bodyStart.match(/From:\s*([A-Za-z .'-]{2,60})\s*(?:\(|<)?\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s*(?:>|\))?/i);
        if (fromMatch) return { name: fromMatch[1].trim(), email: fromMatch[2].trim() };

        // fallback: try to find any email address near top of document
        const anyEmail = bodyStart.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (anyEmail) return { name: '', email: anyEmail[0] };
      } catch (e) {}
      return { name: '', email: '' };
    }

    const sender = extractSenderInfo();
    // persist latest extraction so popup can read it later
    try {
      chrome.storage.local.set({ lastEmailExtracted: body, lastEmailUrl: location.href, lastEmailHost: location.host, lastSenderName: sender.name, lastSenderEmail: sender.email }, () => {});
    } catch (e) {
      // storage may not be available in older runtime contexts; ignore
    }
    chrome.runtime.sendMessage({ type: "pageEmailExtracted", body, senderName: sender.name, senderEmail: sender.email });
  }
}

detectAndSend();
const obs = new MutationObserver(() => detectAndSend());
obs.observe(document.documentElement, { childList: true, subtree: true });

// Respond to explicit extraction requests from the popup (when user clicks extension)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'requestExtraction') {
    try {
      const host = window.location.host || '';
      let body = '';
      if (host.includes('mail.google.com')) body = extractGmail();
      else if (host.includes('outlook.office.com')) body = extractOutlook();

      if (body) {
        try {
          chrome.storage.local.set({ lastEmailExtracted: body, lastEmailUrl: location.href, lastEmailHost: location.host }, () => {});
        } catch (e) {}
        chrome.runtime.sendMessage({ type: 'pageEmailExtracted', body });
      }

      // reply to the popup immediately with whatever we found (may be empty)
      sendResponse({ body });
    } catch (e) {
      sendResponse({ body: '' });
    }
    // indicate we'll send response synchronously
    return true;
  }
});