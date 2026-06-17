import React, { useEffect, useRef, useState } from 'react';
import Button from './ui/Button.jsx';

const ACTION_ICONS = { create: '✅', delete: '🗑️', update: '✏️' };

function MessageBubble({ msg, onConfirm, onReject, confirmUsed }) {
  const renderContent = (text) => {
    const parts = String(text || '').split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      }
      const lines = part.split('\n');
      return lines.map((line, j) => (
        <React.Fragment key={String(i) + '-' + j}>
          {line}
          {j < lines.length - 1 && <br />}
        </React.Fragment>
      ));
    });
  };

  return (
    <div className={'chat-message ' + msg.role}>
      <div
        className={
          'chat-bubble' +
          (msg.actionCompleted ? ' action-success' : '') +
          (msg.requiresConfirmation ? ' needs-confirm' : '')
        }
      >
        {msg.actionCompleted && (
          <span className="action-icon">{ACTION_ICONS[msg.actionCompleted.type] || '✅'} </span>
        )}
        <span>{renderContent(msg.content)}</span>
      </div>
      {msg.requiresConfirmation && !confirmUsed && (
        <div className="confirm-buttons">
          <button
            type="button"
            className="confirm-btn confirm-yes"
            onClick={onConfirm}
            aria-label="Confirm action"
          >
            ✓ Yes, proceed
          </button>
          <button
            type="button"
            className="confirm-btn confirm-no"
            onClick={onReject}
            aria-label="Cancel action"
          >
            ✗ No, cancel
          </button>
        </div>
      )}
    </div>
  );
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        "Hi! I'm your Calendar Agent. I can help you:\n\n• View and search events\n• Create new events\n• Move or reschedule events\n• Delete events (with confirmation)\n\nTry: \"What meetings do I have tomorrow?\" or \"Create a team sync on Friday at 2 PM\"",
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [lastConfirmIdx, setLastConfirmIdx] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open]);

  const sendMessage = async (text) => {
    const trimmed = String(text || '').trim();
    if (!trimmed || sending) return;
    setInput('');
    setError('');
    setSending(true);
    setLastConfirmIdx(null);

    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      });
      const data = await resp.json().catch(() => null);

      if (!resp.ok) {
        if (resp.status === 401) {
          window.location.href = '/login';
          return;
        }
        const errMsg = data?.message || 'Chat request failed.';
        setError(errMsg);
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: 'I hit an error. Please try again.' },
        ]);
        return;
      }

      const reply = data?.reply || 'No response received.';
      const newMsg = {
        role: 'assistant',
        content: reply,
        requiresConfirmation: data?.requiresConfirmation || false,
        actionCompleted: data?.actionCompleted || null,
        pendingAction: data?.pendingAction || null,
      };

      setMessages((prev) => {
        const updated = [...prev, newMsg];
        if (data?.requiresConfirmation) {
          setLastConfirmIdx(updated.length - 1);
        }
        return updated;
      });
    } catch {
      setError('Chat request failed.');
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Chat request failed. Please check your connection.' },
      ]);
    } finally {
      setSending(false);
    }
  };

  const send = () => sendMessage(input);

  const handleConfirm = () => {
    setLastConfirmIdx(null);
    sendMessage('yes');
  };

  const handleReject = () => {
    setLastConfirmIdx(null);
    sendMessage('no');
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
        aria-label={open ? 'Close chat' : 'Open Calendar Agent'}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '✕' : '🗓️'}
      </button>

      {open && (
        <div className="chat-panel" role="dialog" aria-label="Calendar agent">
          <div className="chat-header">
            <div>
              <h4>📅 Calendar Agent</h4>
              <p className="muted small">View · Create · Move · Delete events</p>
            </div>
            <button
              className="chat-close"
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="chat-messages" ref={listRef}>
            {messages.map((msg, idx) => (
              <MessageBubble
                key={idx}
                msg={msg}
                onConfirm={handleConfirm}
                onReject={handleReject}
                confirmUsed={msg.requiresConfirmation && lastConfirmIdx !== idx}
              />
            ))}
            {sending && (
              <div className="chat-message assistant">
                <div className="chat-bubble chat-typing">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </div>
              </div>
            )}
          </div>

          <div className="chat-input">
            {error && (
              <div className="chat-error" role="alert">
                {error}
              </div>
            )}
            <textarea
              rows={2}
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Try: move tomorrow's standup to 4 PM"
              aria-label="Chat input"
              disabled={sending}
            />
            <Button variant="primary" onClick={send} disabled={sending || !input.trim()}>
              {sending ? '...' : 'Send'}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
