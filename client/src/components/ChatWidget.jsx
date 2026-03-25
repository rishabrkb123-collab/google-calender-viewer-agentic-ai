import React, { useEffect, useRef, useState } from 'react';
import Button from './ui/Button.jsx';

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Hi! I am your calendar agent. Ask me to view, create, update, move, or delete events.' },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef(null);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setError('');
    setSending(true);
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const errMsg = data?.message || 'Chat request failed.';
        setError(errMsg);
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: 'I hit an error. Please try again.' },
        ]);
        return;
      }
      const reply = data?.reply || 'No events found.';
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
    } catch {
      setError('Chat request failed.');
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Chat request failed. Please try again.' },
      ]);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <>
      <button
        type="button"
        className="chat-fab"
        aria-label={open ? 'Close chat' : 'Open chat'}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'X' : 'Chat'}
      </button>
      {open && (
        <div className="chat-panel" role="dialog" aria-label="Calendar assistant">
          <div className="chat-header">
            <div>
              <h4>Calendar Agent</h4>
              <p className="muted small">Connected to your n8n agent workflow.</p>
            </div>
            <button className="chat-close" type="button" onClick={() => setOpen(false)}>
              X
            </button>
          </div>
          <div className="chat-messages" ref={listRef}>
            {messages.map((msg, idx) => (
              <div key={idx} className={`chat-message ${msg.role}`}>
                <div className="chat-bubble">{msg.content}</div>
              </div>
            ))}
          </div>
          <div className="chat-input">
            {error && <div className="chat-error" role="alert">{error}</div>}
            <textarea
              rows="2"
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Try: move tomorrow's meeting to 4 PM"
              aria-label="Chat input"
            />
            <Button variant="primary" onClick={send} disabled={sending || !input.trim()}>
              {sending ? 'Sending...' : 'Send'}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
