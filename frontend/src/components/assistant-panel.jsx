import React, { useState, useEffect, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Sparkles, Send, Square, Plus, FileDown } from "lucide-react";
import { Button } from "./ui/button";
const safeId = (id) =>
  typeof id === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(id);
function Message({ message, onViewTransaction }) {
  const text =
    typeof message.content === "string"
      ? message.content
      : typeof message.text === "string"
        ? message.text
        : "";
  return (
    <article
      className={`assistant-message assistant-message-${message.role === "user" ? "user" : "assistant"}`}
    >
      <strong>{message.role === "user" ? "You" : "dolphino assistant"}</strong>
      <p>{text}</p>
      {message.citations?.length > 0 && (
        <div className="assistant-citations">
          {message.citations.map((c, i) => (
            <div key={c.id || i}>
              <span>{c.label || c.tool || "Verified tool result"}</span>
              {typeof c.provenance === "string" && (
                <small>{c.provenance}</small>
              )}
              {onViewTransaction &&
                c.reference?.type === "transaction" &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                  c.reference.id || "",
                ) && (
                  <button
                    type="button"
                    className="total-drill"
                    onClick={() =>
                      onViewTransaction(
                        c.reference.id,
                        /^[A-Z]{3}$/.test(c.provenance?.currency || "")
                          ? c.provenance.currency
                          : undefined,
                      )
                    }
                  >
                    View source transaction
                  </button>
                )}
              {safeId(c.reportId) && (
                <a
                  href={`/api/assistant/reports/${encodeURIComponent(c.reportId)}`}
                  download
                >
                  <FileDown size={13} />
                  Download authorized report
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
export function AssistantPanel({ api, session, onViewTransaction }) {
  const [open, setOpen] = useState(false),
    [status, setStatus] = useState(null),
    [chats, setChats] = useState([]),
    [chat, setChat] = useState(null),
    [question, setQuestion] = useState(""),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [lastQuestion, setLastQuestion] = useState("");
  const request = useRef(null),
    generation = useRef(0),
    chatRef = useRef(null),
    bottom = useRef(null);
  useEffect(() => {
    generation.current++;
    request.current?.abort();
    setChat(null);
    setChats([]);
    setAck(false);
    setStatus(null);
    setOpen(false);
    setQuestion("");
    setLastQuestion("");
    setError("");
  }, [session?.user?.id]);
  useEffect(() => {
    chatRef.current = chat;
  }, [chat]);
  async function refresh() {
    setLoading(true);
    setError("");
    const rev = generation.current;
    try {
      const [s, h] = await Promise.all([
        api("/assistant/status"),
        api("/assistant/chats"),
      ]);
      if (rev !== generation.current) return;
      setStatus(s);
      setChats(h.chats || []);
    } catch (e) {
      if (rev === generation.current) setError(e.message);
    } finally {
      if (rev === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (open) refresh();
  }, [open]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [chat, busy]);
  async function cancel() {
    const active = chatRef.current;
    const rev = ++generation.current;
    request.current?.abort();
    request.current = null;
    if (active?.id) {
      try {
        await api(`/assistant/chats/${encodeURIComponent(active.id)}/cancel`, {
          method: "POST",
          body: "{}",
        });
        const recovered = await api(
          `/assistant/chats/${encodeURIComponent(active.id)}`,
        );
        if (rev === generation.current) setChat(recovered);
      } catch (e) {
        if (rev === generation.current) setError(e.message);
      }
    }
    if (rev === generation.current) setBusy(false);
  }
  async function send(text) {
    if (!text.trim() || busy || !ack) return;
    setBusy(true);
    setError("");
    setLastQuestion(text);
    const rev = ++generation.current;
    const controller = new AbortController();
    request.current = controller;
    try {
      let current = chat;
      if (!current) {
        current = await api("/assistant/chats", {
          method: "POST",
          body: "{}",
          signal: controller.signal,
        });
        if (rev !== generation.current) return;
        chatRef.current = current;
        setChat(current);
      }
      setChat({
        ...current,
        messages: [
          ...(current.messages || []),
          { role: "user", content: text },
        ],
      });
      setQuestion("");
      const r = await api(
        `/assistant/chats/${encodeURIComponent(current.id)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ message: text, acknowledgeDataSharing: true }),
          signal: controller.signal,
        },
      );
      if (rev !== generation.current) return;
      setChat(
        r.chat || {
          ...current,
          messages: [
            ...(current.messages || []),
            { role: "user", content: text },
            {
              role: "assistant",
              content:
                typeof r.reply === "string" ? r.reply : r.reply?.content || "",
              citations: r.citations || [],
            },
          ],
        },
      );
      if (r.chat && r.citations?.length) {
        setChat((c) => ({
          ...c,
          messages: c.messages.map((m, i) =>
            i === c.messages.length - 1 ? { ...m, citations: r.citations } : m,
          ),
        }));
      }
      const history = await api("/assistant/chats");
      if (rev === generation.current) setChats(history.chats || []);
    } catch (e) {
      if (rev === generation.current && e.name !== "AbortError") {
        setError(e.message);
        try {
          if (chatRef.current?.id) {
            const recovered = await api(
              `/assistant/chats/${encodeURIComponent(chatRef.current.id)}`,
            );
            if (rev === generation.current) setChat(recovered);
          }
        } catch {
          if (rev === generation.current) setChat(null);
        }
      }
    } finally {
      if (rev === generation.current) {
        setBusy(false);
        request.current = null;
      }
    }
  }
  const usable = status?.enabled && status?.configured;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v && busy) cancel();
        setOpen(v);
      }}
    >
      <Dialog.Trigger asChild>
        <Button variant="outline" className="assistant-trigger">
          <Sparkles size={16} />
          <span>Ask dolphino</span>
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="assistant-overlay" />
        <Dialog.Content className="assistant-panel">
          <header className="assistant-header">
            <div>
              <Dialog.Title>
                <Sparkles size={19} />
                Your dolphino assistant
              </Dialog.Title>
              <Dialog.Description>
                Private to your account · temporary history expires after 30
                minutes or a server restart.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close assistant">
                <X size={19} />
              </Button>
            </Dialog.Close>
          </header>
          <div className="assistant-toolbar">
            <select
              aria-label="Assistant conversation"
              value={chat?.id || ""}
              disabled={busy}
              onChange={async (e) => {
                const rev = ++generation.current;
                setError("");
                setAck(false);
                if (!e.target.value) {
                  setChat(null);
                  return;
                }
                try {
                  const selected = await api(
                    `/assistant/chats/${encodeURIComponent(e.target.value)}`,
                  );
                  if (rev === generation.current) setChat(selected);
                } catch (err) {
                  if (rev === generation.current) {
                    setChat(null);
                    setError(err.message);
                  }
                }
              }}
            >
              <option value="">New conversation</option>
              {chats.map((c, i) => (
                <option key={c.id} value={c.id}>
                  {c.title || `Conversation ${i + 1}`}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                generation.current++;
                setChat(null);
                setQuestion("");
                setLastQuestion("");
                setAck(false);
                setError("");
              }}
            >
              <Plus size={15} />
              New
            </Button>
          </div>
          <div className="assistant-transcript" aria-live="polite">
            {loading && <p className="muted">Loading your assistant…</p>}
            {!loading && !usable && (
              <div className="assistant-empty">
                <Sparkles size={28} />
                <h3>Your assistant is not enabled yet</h3>
                <p>
                  {status?.disabledReason ||
                    "An administrator must configure a separate assistant provider and enable financial data sharing in Settings."}
                </p>
                <p>
                  Classification credentials are not reused. You can keep using
                  dolphino without an assistant.
                </p>
                <Button variant="outline" onClick={refresh}>
                  Refresh assistant status
                </Button>
              </div>
            )}
            {usable && !chat?.messages?.length && (
              <div className="assistant-empty">
                <h3>A little help making sense of it.</h3>
                <p>
                  Ask about spending, compare months, or request a report. The
                  assistant can only read financial data you are permitted to
                  access.
                </p>
                <p>
                  It cannot edit transactions, change budgets, or send
                  notifications.
                </p>
              </div>
            )}
            {chat?.messages?.map((m, i) => (
              <Message
                key={m.id || i}
                message={m}
                onViewTransaction={
                  onViewTransaction
                    ? (id, currency) => {
                        setOpen(false);
                        onViewTransaction(id, currency);
                      }
                    : undefined
                }
              />
            ))}
            {busy && (
              <p role="status" className="assistant-working">
                Working with your authorized data…
              </p>
            )}
            {error && (
              <div role="alert" className="alert alert-error">
                <span>{error}</span>
                {lastQuestion && usable && !busy && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!ack}
                    onClick={() => send(lastQuestion)}
                  >
                    Retry question
                  </Button>
                )}
              </div>
            )}
            <div ref={bottom} />
          </div>
          <form
            className="assistant-composer"
            onSubmit={(e) => {
              e.preventDefault();
              send(question);
            }}
          >
            {usable && (
              <label className="checkbox-label assistant-consent">
                <input
                  type="checkbox"
                  checked={ack}
                  disabled={busy}
                  onChange={(e) => setAck(e.target.checked)}
                />
                <span>
                  {status?.disclosure ||
                    "I agree to send my questions and authorized financial tool results to the configured AI provider for this conversation."}
                </span>
              </label>
            )}
            <label className="sr-only" htmlFor="assistant-question">
              Ask a financial question
            </label>
            <textarea
              id="assistant-question"
              value={question}
              maxLength={4000}
              disabled={!usable || busy}
              placeholder="What changed in my spending this month?"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(question);
                }
              }}
            />
            <div className="assistant-compose-actions">
              <small>
                Read-only tools · verify answers against cited records
              </small>
              {busy ? (
                <Button type="button" variant="outline" onClick={cancel}>
                  <Square size={14} />
                  Stop response
                </Button>
              ) : (
                <Button disabled={!usable || !ack || !question.trim()}>
                  <Send size={14} />
                  Send
                </Button>
              )}
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
