# 📧 JATAS AI Email Replier

A friendly Chrome extension that helps you reply to emails quickly without sending any data to the cloud. Drafts are generated locally with the **Llama 3.2** language model (running through [Ollama](https://ollama.com)) and can be sent straight from Gmail once you approve access.

The goal of this guide is to walk **anyone**—even if you have never run AI tools before—through setup, daily use, and troubleshooting.

---

## 📋 Table of Contents

1. [What You Get](#-what-you-get)
2. [How It Works](#-how-it-works)
3. [What You Need First](#-what-you-need-first)
4. [Step-by-Step Setup](#-step-by-step-setup)
   - [1. Install and start Ollama](#1-install-and-start-ollama)
   - [2. (Optional) Create a Python virtual environment](#2-optional-create-a-python-virtual-environment)
   - [3. Install bridge dependencies](#3-install-bridge-dependencies)
   - [4. Run the bridge server](#4-run-the-bridge-server)
   - [5. Enable Gmail access (OAuth)](#5-enable-gmail-access-oauth)
   - [6. Load the Chrome extension](#6-load-the-chrome-extension)
5. [Daily Usage Flow](#-daily-usage-flow)
6. [Tone, Creativity, and Model Behaviour](#-tone-creativity-and-model-behaviour)
7. [Advanced: Training Data Boost](#-advanced-training-data-boost)
8. [Troubleshooting](#-troubleshooting)
9. [FAQ](#-faq)
10. [Next Steps & Ideas](#-next-steps--ideas)

---

## ✅ What You Get

- **Instant drafts in Gmail** powered by a local Llama 3.2 model.
- **Privacy first:** email text never leaves your computer.
- **Beautiful extension UI** with live status, tone picker, and creativity selector.
- **Direct Gmail sending:** approve once with Google OAuth and press **Send** inside the popup.
- **Smarter responses:** the Python bridge now reuses your training/test examples with a quick similarity search so replies stay on-tone and safe.

---

## 🧠 How It Works

1. The Chrome extension captures the open email and asks the local Python bridge for a reply.
2. The bridge talks to Ollama (or the optional Flask bridge endpoint) to run Llama 3.2.
3. We inject a couple of relevant examples from your `train.jsonl` / `test.jsonl.txt` datasets so the model follows proven good behaviour.
4. The generated draft streams back into the popup. You can edit, copy, or send it via the Gmail API.

A quick architecture sketch:

```
Gmail tab ──► Chrome extension UI ──► Python bridge ──► Ollama + Llama 3.2
       ▲                │                  │
       │                └── Gmail API ◄────┘
       └───────────── Local only data flow ────────────────┘
```

---

## 🧰 What You Need First

| Requirement | Why you need it | Where to get it |
|-------------|-----------------|-----------------|
| Windows 10/11 (tested) | The instructions below are Windows focused. | — |
| Google Chrome or Microsoft Edge (Chromium) | To load the extension. | https://google.com/chrome |
| [Ollama](https://ollama.com) | Runs the Llama 3.2 model locally. | Install from website |
| Python 3.11+ | Runs the Flask bridge. | https://python.org |
| Google account | Needed for Gmail API access. | https://accounts.google.com |

> 💡 Other operating systems should work with equivalent commands, but the exact PowerShell snippets will differ.

---

## 🪜 Step-by-Step Setup

### 1. Install and start Ollama

1. Download and install Ollama from <https://ollama.com>.
2. Open **PowerShell** and pull the Llama 3.2 model:

   ```powershell
   ollama pull llama3.2
   ```
3. Start the Ollama service (it listens on `http://localhost:11434` by default):

   ```powershell
   ollama serve
   ```

Leave this window running. The extension checks this endpoint to confirm the model is available.

---

### 2. (Optional) Create a Python virtual environment

Keeping dependencies isolated avoids version conflicts:

```powershell
cd "D:\IP-I JATAS\Project"
python -m venv venv
& "D:/IP-I JATAS/Project/venv/Scripts/Activate.ps1"
```

You should now see `(venv)` in your terminal prompt.

---

### 3. Install bridge dependencies

The bridge only needs a couple of small packages. Install them once:

```powershell
pip install flask requests
```

---

### 4. Run the bridge server

The bridge proxies requests between the extension and Ollama. Start it in a new PowerShell window (or split VS Code terminal):

```powershell
cd "D:\IP-I JATAS\Project\Email-Replier-for-IP-I\bridge"
python bridge.py
```

If everything is correct you should see:

```
✓ JATAS AI Email Bridge starting on http://localhost:5000
✓ Make sure Ollama is running in another terminal window
```

Leave this window open while you use the extension.

---

### 5. Enable Gmail access (OAuth)

This only has to be done once per Google project.

1. Visit the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (e.g., **JATAS AI Email Replier**).
3. Open **APIs & Services → Library** and enable the **Gmail API**.
4. Configure **OAuth consent screen**:
   - User type: *External*
   - Add yourself as a test user
5. Create credentials → **OAuth client ID**:
   - Application type: **Chrome Extension**
   - Authorized redirect URI:
     ```
     https://cpflhjagocchmjpngmpdnaeekbinmjem.chromiumapp.org/
     ```
     Replace the ID with your own if the extension ID changes after loading.
6. Copy the generated **Client ID** and paste it into `manifest.json` if you fork the project. The current repo already uses the shipped client ID.
7. Publish the consent screen (still in testing mode is fine for personal use).

> ℹ️ The extension asks for permission the first time you press **Send**. You can revoke access anytime from <https://myaccount.google.com/permissions>.

---

### 6. Load the Chrome extension

1. Download/clone this repository and unzip if necessary.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and pick the `auto-replier-extension` folder inside this project.
5. You should now see the JATAS AI icon in your toolbar.

That’s it! You are ready to reply to emails locally.

---

## 💡 Daily Usage Flow

1. Make sure **Ollama** and the **bridge** are running (status pill in the popup will glow green).
2. Switch to your Gmail tab and click the JATAS AI icon.
3. The extension grabs the open email automatically. You can also paste text manually.
4. Choose a **Tone** and **Creativity** level:
   - *Precise* = short and conservative
   - *Balanced* = default mix of warmth and brevity
   - *Creative* = more expressive wording
5. Press **Generate**. The draft streams in live.
6. Edit anything you want. You can always press **Copy** to clipboard.
7. Hit **Send** to open Google’s account chooser and deliver the message with the Gmail API.

The UI also shows a little “Local AI” badge to remind you nothing is uploaded to cloud services.

---

## 🎨 Tone, Creativity, and Model Behaviour

- The **Tone** dropdown changes the guiding instruction the model receives. Pick the style that fits the conversation.
- The **Creativity** selector adjusts temperature, top-p, and repeat penalty for Ollama and the bridge fallback.
- Every time you generate a reply, the bridge retrieves two close matches from the included `train.jsonl` and `test.jsonl.txt` corpora. This keeps behaviour consistent with your preferred moderation style.
- Replies are cleaned before they reach the popup (no extra “Draft:” labels, no code fences, no repeated blank lines).

If you want to add your own training examples, append to those JSONL files with the same `"chosen"/"rejected"` format and restart the bridge so it reloads them.

---

## 🧪 Advanced: Training Data Boost

The file `bridge/bridge.py` now ships with a lightweight TF‑IDF retriever:

- It reads up to 700 lines from `train.jsonl` and `test.jsonl.txt` each.
- For every new email it picks the two closest positive examples (the `"chosen"` replies) and inserts them into the system prompt as reference mini-scenarios.
- This happens locally at startup—no external services needed.

Want to personalise it further?

1. Add new examples to the JSONL files (keep the `"chosen"` key clean and on-topic).
2. Adjust the retriever limits or scoring in `FewShotRetriever` if you have large datasets.
3. Restart the bridge to reload.

---

## 🛠 Troubleshooting

| Issue | What it means | Fix |
|-------|----------------|-----|
| **Model offline** in popup | The extension cannot reach Ollama or the bridge. | Ensure `ollama serve` and `python bridge.py` are running. The popup poll happens every 15 s. |
| Gmail send opens a blank window | OAuth permissions were not granted. | Close extra popups, press **Send** again, and choose the correct Google account. |
| `bad client id` error | OAuth client ID in `manifest.json` doesn’t match the loaded extension ID. | Update the redirect URI with your extension ID and restart Chrome. |
| Bridge console shows `Error contacting local model` | Ollama is down or blocked by firewall. | Restart Ollama, check that port `11434` (or fallback `11500/5000`) is reachable. |
| Draft repeats or contains “Assistant:” text | Model returned raw output. | The bridge already strips most noise; update to the latest code or tweak `cleanReply` in `background.js`. |

---

## ❓ FAQ

**Do I need an internet connection?**  
Only for Gmail OAuth. Drafting happens offline once the model is pulled.

**Can I run a different model?**  
Yes. Change the `model` name in both `background.js` and `bridge.py`, then pull that model with `ollama pull`.

**Will this work with Outlook?**  
The content script already detects Outlook Web (`outlook.office.com`) and will populate the source email. Sending still goes through Gmail.

**How do I update the extension after editing code?**  
Return to `chrome://extensions/` and click **Refresh** on the JATAS AI card.

---

## 🚀 Next Steps & Ideas

- Multi-language tone presets tailored for customer support, HR, sales, etc.
- Optional auto-send with a confirmation timer for power users.
- Rich history view showing previous drafts and recipients.
- Pre-built packs of training examples for different industries.

Pull requests and suggestions are welcome—this project is all about making respectful, private emailing easy for everyone.

---

Happy emailing! 💌
