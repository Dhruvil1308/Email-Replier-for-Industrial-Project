from flask import Flask, request, stream_with_context, Response
import requests
import json
import re
import math
from pathlib import Path
from collections import Counter

app = Flask(__name__)

# Try these Ollama endpoints in order
OLLAMA_ENDPOINTS = [
    "http://localhost:11434/api/chat",
    "http://localhost:11500/api/chat",
]

# Dataset paths for few-shot retrieval
WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
DATASET_FILES = [
    WORKSPACE_ROOT / "train.jsonl",
    WORKSPACE_ROOT / "test.jsonl.txt",
]

TOKEN_PATTERN = re.compile(r"[A-Za-z0-9']+")


def normalize_text(text: str) -> str:
    if not text:
        return ""
    replacements = {
        "â€™": "'",
        "â€œ": '"',
        "â€�": '"',
        "â€“": "-",
        "â€”": "-",
        "â€¢": "-",
        "Â": "",
    }
    for bad, good in replacements.items():
        text = text.replace(bad, good)
    return text.strip()


def tokenize(text: str) -> Counter:
    tokens = TOKEN_PATTERN.findall(text.lower())
    # lightweight stop-word removal for extremely common words
    stop_words = {
        "the", "and", "for", "that", "with", "have", "this", "from", "your",
        "about", "would", "could", "should", "what", "when", "where", "which",
        "there", "they", "them", "their", "into", "just", "like", "it's", "cant",
        "cannot", "it's", "ive", "you're", "you", "are", "was", "were", "will",
    }
    filtered = [t for t in tokens if t not in stop_words and len(t) > 2]
    return Counter(filtered)


class FewShotRetriever:
    def __init__(self, paths, limit_per_file=600):
        self.examples = []
        self._load(paths, limit_per_file)

    def _load(self, paths, limit_per_file):
        for path in paths:
            if not path.exists():
                continue
            try:
                with path.open("r", encoding="utf-8", errors="ignore") as fh:
                    for idx, line in enumerate(fh):
                        if limit_per_file and idx >= limit_per_file:
                            break
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            rec = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        chosen = normalize_text(rec.get("chosen", ""))
                        if not chosen:
                            continue
                        # try to extract last human utterance and assistant reply
                        parts = chosen.rsplit("Assistant:", 1)
                        if len(parts) != 2:
                            continue
                        conversation, answer = parts
                        answer = normalize_text(answer)
                        human_parts = conversation.rsplit("Human:", 1)
                        if len(human_parts) != 2:
                            continue
                        question = normalize_text(human_parts[-1])
                        if not question or not answer:
                            continue
                        counter = tokenize(question)
                        if not counter:
                            continue
                        norm = math.sqrt(sum(v * v for v in counter.values())) or 1.0
                        self.examples.append({
                            "question": question,
                            "answer": answer,
                            "counter": counter,
                            "norm": norm,
                        })
            except Exception:
                continue

    def top_k(self, query: str, k: int = 2):
        if not self.examples or not query:
            return []
        query_counter = tokenize(normalize_text(query))
        if not query_counter:
            return []
        query_norm = math.sqrt(sum(v * v for v in query_counter.values())) or 1.0
        scored = []
        for ex in self.examples:
            dot = sum(query_counter[t] * ex["counter"].get(t, 0) for t in query_counter)
            if not dot:
                continue
            score = dot / (query_norm * ex["norm"])
            if score > 0:
                scored.append((score, ex))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [item[1] for item in scored[:k]]


RETRIEVER = FewShotRetriever(DATASET_FILES, limit_per_file=700)


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
    Heuristic approach: cut at the earliest marker (after some minimal body length),
    collapse excessive blank lines, and trim."""
    if not email_text:
        return ""
    markers = [
        "Disclaimer:", "Unsubscribe", "Confidentiality Notice", "Privacy Notice",
        "Regards,", "Kind regards", "Best regards", "Sincerely,", "Cheers,",
        "Sent from my", "This email and any files", "Do not reply",
    ]
    # find earliest marker occurrence beyond a minimal body length
    idx = None
    for m in markers:
        i = email_text.find(m)
        if i != -1:
            idx = i if idx is None or i < idx else idx
    body = email_text
    if idx is not None and idx > 80:
        body = email_text[:idx]
    # collapse excessive blank lines and trim
    body = re.sub(r"\n{3,}", "\n\n", body)
    # fallback: if email is very long, truncate to first 1500 chars
    if len(body) > 3000:
        body = body[:1500]
    return body.strip()


@app.route("/", methods=["GET"])
def index():
    """Simple status endpoint to check if the bridge is running."""
    return Response("JATAS AI Email Bridge is running.", status=200, mimetype="text/plain")


@app.route("/draft", methods=["POST"])
def draft_reply():
    """Accepts JSON { email: str, style?: str } and proxies to a local Ollama HTTP endpoint.

    Streams back plain text chunks as they arrive. The extension expects partial chunks
    which it will append, and a full final composition when the stream ends.
    """
    data = request.get_json(force=True) or {}
    email_text = data.get("email", "")
    # style is a short descriptor from UI, keep it minimal (no word limits here)
    style = data.get("style", "polite, professional, concise")
    creativity = (data.get("creativity") or "balanced").lower()

    # Preprocess email text: strip signature and detect language
    email_text_stripped = strip_signature(email_text)
    sender_name = extract_sender_name(email_text)
    lang_hint = detect_language_hint(email_text_stripped)
    # Build a concise, opinionated system instruction
    # Goals: same-language, concise (<=120 words), enforce style, correct salutation/sign-off, no meta/quotes
    salutation_note = (
        "If a sender display name exists, use it exactly in the salutation (e.g., 'Hi {name}' or 'Dear {name}'). "
        "If no clear person/company name is available, use a neutral salutation like 'Hello'."
    )
    language_note = (f"Language hint: {lang_hint}. Reply in this language. " if lang_hint else "")
    sender_note = (f"Sender display name: \"{sender_name}\". " if sender_name else "")
    system_instruction = (
        "You are a professional email assistant. "
        "Reply in the SAME language as the incoming message. "
        "Output only the email reply body—no analysis, no meta notes, no quoted original. "
        "Keep it concise (<=120 words), clear, and action-oriented. "
        f"Adopt this style: {style}. "
        f"{salutation_note} "
        "End with an appropriate short sign-off (e.g., 'Best regards,' or 'Thanks,') followed by a name placeholder if needed. "
        f"{language_note}{sender_note}"
    )

    exemplars = RETRIEVER.top_k(email_text_stripped, k=2)
    exemplar_text = ""
    if exemplars:
        chunks = []
        for idx, ex in enumerate(exemplars, 1):
            q = ex["question"]
            a = ex["answer"]
            if len(q) > 220:
                q = q[:220].rstrip() + "…"
            if len(a) > 220:
                a = a[:220].rstrip() + "…"
            chunks.append(f"Example {idx}:\nIncoming: {q}\nIdeal reply: {a}")
        exemplar_text = "\n\nReference patterns from training data:\n" + "\n\n".join(chunks)

    payload = {
        "model": "llama3.2",
        "messages": [
            {
                "role": "system",
                "content": system_instruction + exemplar_text,
            },
            {
                "role": "user",
                "content": (
                    "Draft a reply to the message below. Focus on the core request/context and omit signatures or disclaimers.\n\n"
                    f"Message:\n{email_text_stripped}"
                ),
            },
        ],
        "stream": True,
    }
    # Map creativity to sampling options if server supports it (Ollama often supports some options)
    options = {
        "precise": {"temperature": 0.3, "top_p": 0.9, "repeat_penalty": 1.15},
        "balanced": {"temperature": 0.6, "top_p": 0.95, "repeat_penalty": 1.1},
        "creative": {"temperature": 0.9, "top_p": 0.97, "repeat_penalty": 1.05},
    }.get(creativity, {"temperature": 0.6, "top_p": 0.95, "repeat_penalty": 1.1})
    payload["options"] = options

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
    port = 5000
    print(f"\n✓ JATAS AI Email Bridge starting on http://localhost:{port}")
    print("✓ Make sure Ollama is running in another terminal window")
    print("✓ Press Ctrl+C to stop the bridge server\n")
    app.run(port=port)

