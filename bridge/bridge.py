from flask import Flask, request, stream_with_context, Response
import requests
import json
import re

app = Flask(__name__)

# Try these Ollama endpoints in order
OLLAMA_ENDPOINTS = [
    "http://localhost:11434/api/chat",
    "http://localhost:11500/api/chat",
]


def extract_sender_name(email_text: str) -> str:
    """Try to find a display name from patterns like 'Name <addr>' or 'From: Name <addr>'.
    Fallback: derive a name from the sender address (username or domain).
    Return empty string if nothing found.
    """
    if not email_text:
        return ""
    # Look for "Name <email@domain>" pattern
    m = re.search(r'([^\n<>]+?)\s*<[^@\s<>]+@[^>\s]+>', email_text)
    if m:
        name = m.group(1).strip().strip('"\'' )
        if name:
            return name
    # Look for a From: header
    m = re.search(r'From:\s*([^\n<>]+?)\s*<[^>\n]+>', email_text, flags=re.IGNORECASE)
    if m:
        name = m.group(1).strip().strip('"\'' )
        if name:
            return name
    # Try to find any bare email and use local-part or domain
    m = re.search(r'([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})', email_text)
    if m:
        local, domain = m.group(1), m.group(2)
        # prefer a readable domain/company name if local looks like "no-reply" etc.
        if local and not re.match(r'^(no-?reply|noreply|mailer|bounce|postmaster)$', local, flags=re.IGNORECASE):
            return local
        # domain-based fallback: take first label of domain (internshala.com -> Internshala)
        company = domain.split('.')[0]
        return company.capitalize()
    return ""


def detect_language_hint(email_text: str) -> str:
    """Very small heuristic language detection to provide an explicit hint to the model.
    Currently checks for Devanagari characters to detect Hindi; returns a short language name
    like 'Hindi' or empty string if unknown.
    """
    if not email_text:
        return ""
    # Devanagari Unicode block roughly U+0900..U+097F
    if re.search(r"[\u0900-\u097F]", email_text):
        return "Hindi"
    return ""


def strip_signature(email_text: str) -> str:
    """Remove common signature/disclaimer/unsubscribe blocks to keep prompt focused.
    This is heuristic: cut the text at common markers.
    """
    if not email_text:
        return ""
    markers = ["Disclaimer:", "Unsubscribe", "Regards,", "Kind regards", "Best regards", "Sent from my", "This email and any files"]
    # find earliest marker occurrence
    idx = None
    low = email_text
    for m in markers:
        i = email_text.find(m)
        if i != -1:
            if idx is None or i < idx:
                idx = i
    if idx is not None and idx > 50:
        return email_text[:idx].strip()
    # fallback: if email is very long, truncate to first 1200 chars
    if len(email_text) > 3000:
        return email_text[:1200].strip()
    return email_text.strip()


@app.route("/draft", methods=["POST"])
def draft_reply():
    """Accepts JSON { email: str, style?: str } and proxies to a local Ollama HTTP endpoint.

    Streams back plain text chunks as they arrive. The extension expects partial chunks
    which it will append, and a full final composition when the stream ends.
    """
    data = request.get_json(force=True) or {}
    email_text = data.get("email", "")
    style = data.get("style", "concise, polite, positive, neutral, <=120 words")

    # Preprocess email text: strip signature and detect language
    email_text_stripped = strip_signature(email_text)
    sender_name = extract_sender_name(email_text)
    lang_hint = detect_language_hint(email_text_stripped)
    # Build a clear system instruction
    system_instruction = (
        "You are an email assistant. Reply in the same language as the incoming message. "
        "Produce only the reply body (no analysis, no meta commentary, no quoted original). "
        "Be concise and follow the requested style. Maximum 120 words. "
        "Salutation rules: if the original message contains a sender display name (for example 'Internshala <...>'), "
        "use that exact display name when addressing the sender (e.g., 'Dear Internshala' or 'Hi Internshala'). "
        "Do not invent or change the sender name. If the sender is clearly a company address and no display name is present, "
        "use a neutral short salutation (e.g., 'Hello')."
    )
    # If we found a sender name, provide it to the model to encourage correct addressing
    if sender_name:
        system_instruction += f" Sender display name: \"{sender_name}\". Use it exactly in the salutation."

    # Add language hint and sender name to the instruction context
    if lang_hint:
        system_instruction += f" Language hint: {lang_hint}. Reply in this language."
    if sender_name:
        system_instruction += f" Sender display name: \"{sender_name}\". Use it exactly in the salutation."

    payload = {
        "model": "llama3.2",
        "messages": [
            {"role": "system", "content": system_instruction},
            {"role": "user", "content": email_text_stripped}
        ],
        "stream": True,
    }

    last_err = None
    for url in OLLAMA_ENDPOINTS:
        try:
            # proxy to Ollama, stream the response line-by-line (JSONL)
            resp = requests.post(url, json=payload, stream=True, timeout=10)
            if resp.status_code != 200:
                last_err = f"{url} returned {resp.status_code}"
                continue

            def generate():
                # Iterate over lines. Ollama typically returns JSONL per line.
                for raw in resp.iter_lines(decode_unicode=True):
                    if not raw:
                        continue
                    try:
                        obj = json.loads(raw)
                        # try to extract message content, fall back to raw line
                        chunk = obj.get("message", {}).get("content")
                        if chunk is None:
                            # sometimes the model stream includes other fields; send the raw line
                            chunk = raw
                        yield chunk
                    except Exception:
                        # not JSON — forward the raw bytes/text
                        yield raw

            # Ensure client knows stream ended (no special SSE framing needed)
            return Response(stream_with_context(generate()), mimetype="text/plain")

        except Exception as e:
            last_err = str(e)
            continue

    return Response(f"Error contacting local model: {last_err}", status=502, mimetype="text/plain")


if __name__ == "__main__":
    app.run(port=5000)

