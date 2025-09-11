# 📧 JATAS AI – Local Email Replier (with Gmail Send Support)

JATAS AI is a **privacy-first Chrome extension** that automatically generates Gmail replies using a local **Llama 3.2 model** via [Ollama](https://ollama.com).  
Now fully integrated with **Google OAuth & Gmail API**, the extension not only drafts replies but also lets you **send emails directly from Gmail**.

---

## 🚀 Features
- ✨ **Automatic Email Drafts** – AI-generated replies using Llama 3.2 (local, no cloud).
- 🔒 **Privacy-First** – All processing is done locally on your system.
- 🎨 **Style/Tone Control** – Adjust replies (e.g., “concise, polite, <=120 words”).
- 📤 **Send with Gmail** – Integrated Gmail API using OAuth2.
- 🖥 **Chrome Extension UI** – Clean interface embedded in Gmail.

---

## 🖼️ Extension UI Preview

Here’s how the extension looks inside Gmail:  
<img width="486" height="749" alt="image" src="https://github.com/user-attachments/assets/3cc3156f-a33e-4625-8ccc-d9db8d074f1a" />

---

## 🛠️ Setup Instructions

### 1. Install Ollama
- Download Ollama 👉 [ollama.com](https://ollama.com)  
- Install it for your OS.

### 2. Download the Llama 3.2 Model
```bash
ollama pull llama3.2
```

---

### 3. Start Ollama Server
In **Command Prompt (Windows)**:
```bash
D:
ollama
start ollama
ollama serve
```

This starts the local API server on **http://localhost:11434**.

---

### 4. Python Bridge (Extension ↔ Ollama)
From project folder:
```bash
cd bridge
.\.venv\Scripts\Activate.ps1   # activate virtual environment
python .\bridge.py               # start the bridge server
```

---

### 5. Google Cloud OAuth Setup (for Gmail Send)

We use **Google Cloud Console / Cloud Shell** to set up Gmail API access.

1. Go to [Google Cloud Console](https://console.cloud.google.com/).  
2. Create a new project (e.g., *JATAS AI Email Replier*).  
3. Enable the **Gmail API** → (*APIs & Services → Library → Gmail API*).  
4. Configure **OAuth Consent Screen**:  
   - User type: External  
   - Add test users (your Gmail address)  
5. Create **OAuth Client ID**:  
   - Type: *Chromium Extension*  
   - Authorized Redirect URI (important):  
     ```
     https://cpflhjagocchmjpngmpdnaeekbinmjem.chromiumapp.org/
     ```
     *(Replace with your Extension ID if different)*  
6. Copy your **Client ID**. (No secret needed for Chrome Extensions).  

---

### 6. Load the Chrome Extension
1. Open `chrome://extensions/` in Chrome  
2. Enable **Developer Mode**  
3. Click **Load Unpacked**  
4. Select the extension folder (unzipped project)  

---

### 7. Using the Extension
1. Open **Gmail** (refresh if needed).  
2. Select an email → Click **Local AI Email Replier** from extension toolbar.  
3. Enter **Style/Tone** (optional).  
4. Source email loads automatically.  
5. Click **Generate Draft** → AI generates a reply using local Llama 3.2.  
6. Edit if needed.  
7. Click **Send (Gmail)** →  
   - OAuth window opens → login & approve Gmail access.  
   - Extension sends the reply using Gmail API.  

---

## 📌 Notes
- You must have **Ollama server running** before generating drafts.  
- Gmail sending requires a **one-time Google OAuth login**.  
- All drafts are generated **locally** with Llama 3.2.  

---

## 🔮 Future Enhancements
- 🌍 Multi-language email replies  
- ⚡ Auto-send with confirmation  
- 🏢 Domain-specific reply tones (business, customer support, legal)  
- 🔗 Integration with Outlook / Slack / Teams  

---

✅ With JATAS AI, replying to emails is now **faster, private, and fully automated** 🚀
