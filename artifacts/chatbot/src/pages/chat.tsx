import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  ArrowUp,
  Check,
  ChevronRight,
  Clipboard,
  Menu,
  MessageCircle,
  Plus,
  RotateCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
};

type Conversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: Message[];
};

const STORAGE_KEY = 'stillroom.conversations.v1';
const suggestions = [
  'Help me make sense of a big decision',
  'Explain a difficult idea in plain language',
  'Help me plan a week that feels more balanced',
  'I have a half-formed idea. Help me explore it.',
];

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function titleFromMessage(content: string) {
  const compact = content.trim().replace(/\s+/g, ' ');
  return compact.length > 42 ? `${compact.slice(0, 39).trimEnd()}…` : compact || 'New conversation';
}

function relativeDate(timestamp: number) {
  const today = new Date();
  const date = new Date(timestamp);
  if (today.toDateString() === date.toDateString()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (yesterday.toDateString() === date.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function ChatPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [errorFor, setErrorFor] = useState<{ conversationId: string; messageId: string; prompt: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Conversation[];
        if (Array.isArray(parsed)) {
          setConversations(parsed);
          if (parsed[0]) setActiveId(parsed[0].id);
        }
      }
    } catch {
      setNotice('Your saved conversations could not be read. You can still start a new one.');
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch {
      setNotice('This conversation could not be saved in this browser.');
    }
  }, [conversations, ready]);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? null,
    [conversations, activeId],
  );
  const messages = activeConversation?.messages ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming]);

  const updateConversation = useCallback((id: string, updater: (conversation: Conversation) => Conversation) => {
    setConversations((current) =>
      current.map((conversation) => (conversation.id === id ? updater(conversation) : conversation)),
    );
  }, []);

  const runRequest = useCallback(async (conversationId: string, prompt: string, retry = false) => {
    const now = Date.now();
    const assistantId = makeId();
    setErrorFor(null);
    setStreaming(true);
    const current = conversations.find((item) => item.id === conversationId);
    const history = current?.messages ?? [];
    const withoutPreviousPending = retry && history.at(-1)?.role === 'assistant' ? history.slice(0, -1) : history;
    const outgoing = retry ? withoutPreviousPending : [...withoutPreviousPending, {
      id: makeId(),
      role: 'user' as const,
      content: prompt,
      createdAt: now,
    }];
    const assistant: Message = { id: assistantId, role: 'assistant', content: '', createdAt: now };
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      updatedAt: now,
      messages: [...outgoing, assistant],
    }));

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        credentials: 'include',
        body: JSON.stringify({
          messages: [...withoutPreviousPending, ...(retry ? [] : [{ role: 'user', content: prompt }])]
            .filter((message) => message.content.trim())
            .slice(-30)
            .map(({ role, content }) => ({ role, content })),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`The reply could not be loaded (${response.status}).`);
      if (!response.body) throw new Error('This browser could not open the reply stream.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      const consumeFrame = (frame: string) => {
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          const event = JSON.parse(raw) as { content?: string; done?: boolean };
          if (event.content) {
            updateConversation(conversationId, (conversation) => ({
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.id === assistantId ? { ...message, content: message.content + event.content } : message,
              ),
            }));
          }
          if (event.done) completed = true;
        }
      };
      while (!completed) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        frames.forEach(consumeFrame);
        if (done) {
          if (buffer.trim()) consumeFrame(buffer);
          break;
        }
      }
      if (!completed) throw new Error('The reply stream ended before it was complete. Try again.');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        updateConversation(conversationId, (conversation) => ({
          ...conversation,
          messages: conversation.messages.filter((message) => message.id !== assistantId || message.content),
        }));
        return;
      }
      setErrorFor({ conversationId, messageId: assistantId, prompt });
      setNotice(error instanceof Error ? error.message : 'Something went wrong while getting a reply.');
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [conversations, updateConversation]);

  const sendMessage = useCallback((content: string) => {
    const prompt = content.trim();
    if (!prompt || streaming) return;
    setDraft('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    let conversationId = activeId;
    if (!conversationId) {
      conversationId = makeId();
      const created: Conversation = {
        id: conversationId,
        title: titleFromMessage(prompt),
        updatedAt: Date.now(),
        messages: [],
      };
      setConversations((current) => [created, ...current]);
      setActiveId(conversationId);
      window.setTimeout(() => void runRequest(conversationId!, prompt), 0);
      return;
    }
    const existing = conversations.find((conversation) => conversation.id === conversationId);
    if (existing?.messages.length === 0) {
      updateConversation(conversationId, (conversation) => ({ ...conversation, title: titleFromMessage(prompt) }));
    }
    void runRequest(conversationId, prompt);
  }, [activeId, conversations, runRequest, streaming, updateConversation]);

  const startNewChat = () => {
    if (streaming) abortRef.current?.abort();
    setActiveId(null);
    setDraft('');
    setErrorFor(null);
    setNotice('');
    setSidebarOpen(false);
    window.setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const selectConversation = (id: string) => {
    if (streaming) abortRef.current?.abort();
    setActiveId(id);
    setErrorFor(null);
    setNotice('');
    setSidebarOpen(false);
  };

  const deleteConversation = (id: string) => {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return;
    if (!window.confirm(`Remove “${conversation.title}” from your history?`)) return;
    if (activeId === id && streaming) abortRef.current?.abort();
    setConversations((current) => current.filter((item) => item.id !== id));
    if (activeId === id) setActiveId(null);
    setErrorFor(null);
  };

  const clearHistory = () => {
    if (conversations.length === 0) return;
    if (!window.confirm('Clear all saved conversations from this browser?')) return;
    if (streaming) abortRef.current?.abort();
    setConversations([]);
    setActiveId(null);
    setErrorFor(null);
    setNotice('');
  };

  const copyReply = async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId(null), 1600);
    } catch {
      setNotice('Clipboard access is unavailable in this browser.');
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    sendMessage(draft);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      sendMessage(draft);
    }
  };

  return (
    <div className={`chat-shell${sidebarOpen ? ' sidebar-open' : ''}`}>
      <button className="mobile-scrim" aria-label="Close conversation menu" onClick={() => setSidebarOpen(false)} />
      <aside className="chat-sidebar" aria-label="Conversation history">
        <div className="brand">
          <span className="brand-mark"><Sparkles size={17} strokeWidth={1.8} /></span>
          <span className="brand-name">Stillroom</span>
          <span className="brand-note">PERSONAL AI</span>
        </div>
        <button className="new-chat" onClick={startNewChat} data-testid="button-new-chat">
          <Plus size={16} /> Start a new chat
        </button>
        <div className="sidebar-label">Your conversations</div>
        <div className="history-list">
          {!ready ? (
            <div className="empty-history" aria-label="Loading conversations">
              <span className="loading-line" />
              <span className="loading-line short" />
            </div>
          ) : conversations.length === 0 ? (
            <div className="empty-history" data-testid="empty-conversations">
              Your conversations will be kept here, just for you.
            </div>
          ) : conversations.map((conversation) => (
            <div className={`history-row${activeId === conversation.id ? ' active' : ''}`} key={conversation.id}>
              <button
                className="history-open"
                onClick={() => selectConversation(conversation.id)}
                aria-current={activeId === conversation.id ? 'page' : undefined}
                data-testid={`conversation-${conversation.id}`}
              >
                <span className="history-title">{conversation.title || 'New conversation'}</span>
                <span className="history-date">{relativeDate(conversation.updatedAt)}</span>
              </button>
              <button
                className="icon-button history-delete"
                onClick={() => deleteConversation(conversation.id)}
                aria-label={`Remove ${conversation.title}`}
                title="Remove conversation"
                data-testid={`delete-conversation-${conversation.id}`}
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
        <div className="sidebar-foot">
          <div><strong>Quietly yours.</strong> Chats stay in this browser.</div>
          {conversations.length > 0 && (
            <button className="copy-button" onClick={clearHistory} data-testid="button-clear-history">
              <Trash2 size={12} /> Clear all history
            </button>
          )}
        </div>
      </aside>

      <main className="chat-main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open conversation menu" data-testid="button-open-menu">
              <Menu size={19} />
            </button>
            <span className="topbar-title">{activeConversation?.title ?? 'A little room to think'}</span>
          </div>
          <div className="privacy-chip"><span className="privacy-dot" /> SAVED ON THIS DEVICE</div>
        </header>

        <section className="conversation" aria-live="polite">
          {messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-kicker">A thoughtful place to begin</div>
              <h1>Good questions<br />make <em>room</em> for more.</h1>
              <p className="welcome-copy">Bring a passing thought, a knotty problem, or something you’ve been meaning to understand. We can take it one step at a time.</p>
              <div className="prompt-grid">
                {suggestions.map((suggestion, index) => (
                  <button className="prompt-card" key={suggestion} onClick={() => sendMessage(suggestion)} data-testid={`suggestion-${index + 1}`}>
                    <span>{suggestion}</span><ChevronRight size={16} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages">
              {messages.map((message) => (
                <article className={`message ${message.role}`} key={message.id} data-testid={`message-${message.id}`}>
                  <span className="message-avatar" aria-hidden="true">
                    {message.role === 'assistant' ? <Sparkles size={14} /> : <MessageCircle size={14} />}
                  </span>
                  <div className="assistant-content">
                    <div className="message-label">{message.role === 'assistant' ? 'Stillroom' : 'You'}</div>
                    {message.content ? (
                      <>
                        <div className="message-body">{message.content}</div>
                        {message.role === 'assistant' && (
                          <div className="message-actions">
                            <button className="copy-button" onClick={() => void copyReply(message)} data-testid={`copy-reply-${message.id}`}>
                              {copiedId === message.id ? <Check size={13} /> : <Clipboard size={13} />}
                              {copiedId === message.id ? 'Copied' : 'Copy reply'}
                            </button>
                          </div>
                        )}
                      </>
                    ) : message.role === 'assistant' && streaming ? (
                      <div className="typing-dots" aria-label="Assistant is responding"><span /><span /><span /></div>
                    ) : null}
                    {errorFor?.messageId === message.id && (
                      <div className="error-note" role="alert">
                        <span>{notice || 'The reply could not be completed.'}</span>
                        <button
                          className="retry-button"
                          onClick={() => void runRequest(errorFor.conversationId, errorFor.prompt, true)}
                          data-testid="button-retry"
                        >
                          <RotateCw size={12} /> Try again
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              ))}
              <div ref={bottomRef} />
            </div>
          )}
          {notice && !errorFor && <div className="error-note" role="status" data-testid="status-notice"><span>{notice}</span><button className="icon-button" aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={14} /></button></div>}
        </section>

        <div className="composer-dock">
          <div className="composer-wrap">
            <form className="composer" onSubmit={handleSubmit}>
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  event.currentTarget.style.height = 'auto';
                  event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 170)}px`;
                }}
                onKeyDown={handleKeyDown}
                placeholder="What’s on your mind?"
                rows={1}
                maxLength={12000}
                disabled={streaming}
                aria-label="Write a message"
                data-testid="input-message"
              />
              {streaming ? (
                <button type="button" className="send-button" onClick={() => abortRef.current?.abort()} aria-label="Stop response" title="Stop response" data-testid="button-stop">
                  <X size={17} />
                </button>
              ) : (
                <button type="submit" className="send-button" disabled={!draft.trim()} aria-label="Send message" data-testid="button-send">
                  <ArrowUp size={19} />
                </button>
              )}
            </form>
            <div className="composer-hint">
              <span><kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span>
              <span>Take your time.</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
