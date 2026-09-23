import { useEffect, useRef, useState } from "react";
import { askAssistant } from "../services/aiService";
import { suggestedPrompts } from "../data/mockDashboardData";
import { BotIcon, SendIcon, SparklesIcon, XIcon } from "./icons";

const WELCOME = {
  id: "welcome",
  role: "assistant",
  text: "Hi, I'm your On-Demand assistant. Ask me about lead performance, dealer comparisons, or anything you've uploaded.",
};

export default function AiAssistant({ open, onToggle }) {
  const [messages, setMessages] = useState([WELCOME]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, thinking]);

  const send = async (text) => {
    const trimmed = text.trim();
    if (!trimmed || thinking) return;
    const userMsg = { id: `u-${Date.now()}`, role: "user", text: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setThinking(true);

    // TODO(gemini-integration): askAssistant currently returns a mock
    // reply — see services/aiService.js for the exact wiring point to a
    // real Gemini-backed endpoint.
    const { reply } = await askAssistant(trimmed);
    setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: "assistant", text: reply }]);
    setThinking(false);
  };

  return (
    <>
      <button
        type="button"
        className={`odd-fab ${open ? "odd-fab--open" : ""}`}
        onClick={onToggle}
        aria-label={open ? "Close AI assistant" : "Open AI assistant"}
      >
        <span className="odd-fab__ring" />
        {open ? <XIcon size={20} /> : <BotIcon size={22} />}
      </button>

      <aside className={`odd-assistant ${open ? "odd-assistant--open" : ""}`} aria-hidden={!open}>
        <header className="odd-assistant__head">
          <div className="odd-assistant__title">
            <SparklesIcon size={16} />
            <div>
              <strong>AI Assistant</strong>
              <span>Powered by Gemini — connecting soon</span>
            </div>
          </div>
          <button type="button" className="odd-icon-btn" onClick={onToggle} aria-label="Close">
            <XIcon size={16} />
          </button>
        </header>

        <div className="odd-assistant__messages" ref={listRef}>
          {messages.map((m) => (
            <div key={m.id} className={`odd-bubble odd-bubble--${m.role}`}>
              {m.role === "assistant" && <SparklesIcon size={12} className="odd-bubble__icon" />}
              <p>{m.text}</p>
            </div>
          ))}
          {thinking && (
            <div className="odd-bubble odd-bubble--assistant odd-bubble--thinking">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>

        <div className="odd-assistant__prompts">
          {suggestedPrompts.map((p) => (
            <button key={p} type="button" className="odd-chip" onClick={() => send(p)}>
              {p}
            </button>
          ))}
        </div>

        <form
          className="odd-assistant__input"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <input
            type="text"
            placeholder="Ask about your data…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" aria-label="Send" disabled={!input.trim() || thinking}>
            <SendIcon size={15} />
          </button>
        </form>
      </aside>
    </>
  );
}