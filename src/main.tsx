import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, invitationUrl } from './api';
import { CallRoom } from './CallRoom';
import { LANGUAGES, languageName, type CallType, type CreateRoomInput, type LanguageCode, type Room, type RoomData } from './types';
import './styles.css';

type Route =
  | { page: 'home' }
  | { page: 'create'; callType: CallType }
  | { page: 'room'; roomId: string; inviteToken?: string };

type RoomEntry = RoomData | { room: Room; role: 'preview'; iceServers: RTCIceServer[]; aiAvailable: false; productName: string };

function readRoute(): Route {
  const match = window.location.pathname.match(/^\/room\/([^/]+)$/);
  if (match) {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    return { page: 'room', roomId: decodeURIComponent(match[1]), inviteToken: fragment.get('invite') || undefined };
  }
  const create = window.location.pathname === '/create';
  if (create) {
    const type = new URLSearchParams(window.location.search).get('type');
    return { page: 'create', callType: type === 'video' ? 'video' : 'voice' };
  }
  return { page: 'home' };
}

function Glyph({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    arrow: 'M5 12h14M12 5l7 7-7 7',
    copy: 'M8 8V4h12v12h-4M4 8h12v12H4z',
    shield: 'M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11zM9 12l2 2 4-4',
    mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3m-4 0h8',
    camera: 'M4 7h3l2-2h6l2 2h3v12H4zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    phone: 'M5 3h4l2 5-3 2a15 15 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z',
    globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20'
  };
  const path = paths[name] || paths.arrow;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [entry, setEntry] = useState<RoomEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [routeError, setRouteError] = useState('');

  const navigate = (path: string) => {
    window.history.pushState({}, '', path);
    setRoute(readRoute());
    setEntry(null);
    setRouteError('');
  };

  useEffect(() => {
    const onPopState = () => {
      setRoute(readRoute());
      setEntry(null);
      setRouteError('');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (route.page !== 'room') return;
    let cancelled = false;
    setLoading(true);
    setRouteError('');
    const loadRoom = route.inviteToken
      ? api.previewRoom(route.roomId, route.inviteToken).then(({ room }) => ({
          room, role: 'preview' as const, iceServers: [], aiAvailable: false as const, productName: 'Lingua Live'
        }))
      : api.getRoom(route.roomId);
    loadRoom.then((result) => {
      if (!cancelled) setEntry(result);
    }).catch((error: unknown) => {
      if (!cancelled) setRouteError(error instanceof Error ? error.message : 'This room is not available.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [route]);

  const start = (callType: CallType) => navigate('/create?type=' + callType);

  if (route.page === 'room') {
    if (loading && !entry) return <Shell><div className="center-state"><span className="spinner" />Checking your invitation…</div></Shell>;
    if (routeError) return <Shell><div className="center-state error-state"><span className="eyebrow">Invitation unavailable</span><h1>This room can’t be opened</h1><p>{routeError}</p><button className="button button-primary" onClick={() => navigate('/')}>Back to home</button></div></Shell>;
    if (!entry) return null;
    return <Shell><RoomPage
      entry={entry}
      roomId={route.roomId}
      inviteToken={route.inviteToken}
      onJoined={() => {
        window.history.replaceState({}, '', '/room/' + encodeURIComponent(route.roomId));
        setRoute({ page: 'room', roomId: route.roomId });
        setEntry(null);
      }}
      onEnd={() => navigate('/')}
    /></Shell>;
  }

  if (route.page === 'create') {
    return <Shell><CreatePage callType={route.callType} onBack={() => navigate('/')} onCreate={async (input) => {
      const result = await api.createRoom(input);
      sessionStorage.setItem('invite:' + result.room.id, result.inviteToken);
      navigate('/room/' + encodeURIComponent(result.room.id));
    }} /></Shell>;
  }

  return <Shell><HomePage onStart={start} /></Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  const productName = import.meta.env.VITE_PRODUCT_NAME || 'Lingua Live';
  return <div className="app-shell">
    <header className="site-header">
      <a className="brand" href="/" onClick={(event) => { event.preventDefault(); window.history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }}>
        <span className="brand-mark"><Glyph name="globe" size={21} /></span>
        <span>{productName}</span>
      </a>
      <div className="header-note"><span className="status-dot" /> Private by design</div>
    </header>
    {children}
    <footer className="site-footer"><span>© 2026 {productName}</span><span>Clear conversations, wherever you are.</span></footer>
  </div>;
}

function HomePage({ onStart }: { onStart: (type: CallType) => void }) {
  return <main className="home-page">
    <section className="hero">
      <div className="hero-copy">
        <div className="eyebrow"><span className="eyebrow-line" /> CONVERSATION WITHOUT BORDERS</div>
        <h1>Speak naturally.<br /><em>Understand each other.</em></h1>
        <p className="hero-description">A private voice or video call with live translated captions and speech, so language never gets in the way.</p>
        <div className="hero-actions">
          <button className="button button-primary" onClick={() => onStart('voice')}><Glyph name="phone" size={18} /> Start a voice call</button>
          <button className="button button-secondary" onClick={() => onStart('video')}><Glyph name="camera" size={18} /> Start a video call</button>
        </div>
        <p className="hero-caption"><Glyph name="shield" size={16} /> No account needed. Rooms are private and limited to two people.</p>
      </div>
      <div className="preview-card">
        <div className="preview-topline"><span>LIVE CONVERSATION</span><span><i className="status-dot" /> READY</span></div>
        <div className="language-person">
          <div className="avatar avatar-terracotta">A</div>
          <div><span className="small-label">YOU SPEAK</span><strong>Hindi</strong><span className="language-code">hi-IN</span></div>
          <span className="audio-bars"><i /><i /><i /><i /><i /></span>
        </div>
        <div className="translation-path"><span className="path-line" /><span className="translation-icon">↘</span><span className="path-label">translated voice + captions</span></div>
        <div className="language-person">
          <div className="avatar avatar-sage">B</div>
          <div><span className="small-label">THEY SPEAK</span><strong>Indonesian</strong><span className="language-code">id-ID</span></div>
          <span className="audio-bars audio-bars-sage"><i /><i /><i /><i /><i /></span>
        </div>
        <div className="sample-caption"><span className="caption-mark">“</span><div><span>CAPTIONS + TRANSLATED VOICE</span><p>Speech and translation appear here during your call.</p></div></div>
        <div className="preview-foot"><span>Hindi <b>→</b> Indonesian</span><span>Both directions</span></div>
      </div>
    </section>

    <section className="how-section" id="how-it-works">
      <div className="section-heading"><span className="eyebrow">HOW IT WORKS</span><h2>Three steps to a better conversation.</h2></div>
      <div className="steps-grid">
        <Step number="01" title="Choose your languages" text="Tell us what each person speaks and what they’d like to hear." />
        <Step number="02" title="Share a private link" text="Invite one person. No account or sign-up is needed to join." />
        <Step number="03" title="Talk as usual" text="Your original call stays live while captions and translated voice arrive separately." />
      </div>
    </section>

    <section className="privacy-strip">
      <div className="privacy-icon"><Glyph name="shield" size={23} /></div>
      <div><strong>Designed for private conversations</strong><p>Audio and video aren’t saved by this app. Translation uses Google Cloud when configured; provider processing and retention follow your cloud settings.</p></div>
      <span className="privacy-tag">2 PEOPLE · PRIVATE ROOM</span>
    </section>
    <p className="quality-note">Translation quality and response time depend on the language pair, microphone, network, and AI provider.</p>
  </main>;
}

function Step({ number, title, text }: { number: string; title: string; text: string }) {
  return <article className="step-card"><span>{number}</span><h3>{title}</h3><p>{text}</p></article>;
}

function CreatePage({ callType, onBack, onCreate }: { callType: CallType; onBack: () => void; onCreate: (input: CreateRoomInput) => Promise<void> }) {
  const [hostName, setHostName] = useState('');
  const [title, setTitle] = useState('');
  const [hostLanguage, setHostLanguage] = useState<LanguageCode>('hi-IN');
  const [guestLanguage, setGuestLanguage] = useState<LanguageCode>('id-ID');
  const [hostOutputLanguage, setHostOutputLanguage] = useState<LanguageCode>('id-ID');
  const [guestOutputLanguage, setGuestOutputLanguage] = useState<LanguageCode>('hi-IN');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (hostLanguage === guestLanguage) {
      setError('Choose two different spoken languages.');
      return;
    }
    setBusy(true);
    try {
      await onCreate({ callType, title, hostName, hostLanguage, guestLanguage, hostOutputLanguage, guestOutputLanguage });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The room could not be created.');
    } finally {
      setBusy(false);
    }
  };

  return <main className="create-page">
    <button className="back-link" onClick={onBack}>← Back</button>
    <div className="create-layout">
      <div className="create-intro">
        <span className="eyebrow"><span className="eyebrow-line" /> YOUR PRIVATE ROOM</span>
        <h1>Set up your<br /><em>{callType} call.</em></h1>
        <p>Choose how you and your guest speak and hear translated speech. You can invite them as soon as the room is ready.</p>
        <div className="call-type-summary"><span className={callType === 'video' ? 'call-icon call-icon-video' : 'call-icon'}><Glyph name={callType === 'video' ? 'camera' : 'phone'} /></span><span><strong>{callType === 'video' ? 'Video call' : 'Voice call'}</strong><small>Private · up to 2 people</small></span><span className="type-check">✓</span></div>
      </div>
      <form className="create-form" onSubmit={(event) => void submit(event)}>
        <div className="form-top"><span className="eyebrow">ROOM DETAILS</span><span className="step-counter">01 / 01</span></div>
        <label className="field-label" htmlFor="host-name">Your name <span>OPTIONAL</span></label>
        <input id="host-name" className="text-input" value={hostName} onChange={(event) => setHostName(event.target.value)} placeholder="e.g. Asha" maxLength={60} />
        <label className="field-label" htmlFor="room-title">Conversation title <span>OPTIONAL</span></label>
        <input id="room-title" className="text-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Catching up" maxLength={80} />
        <div className="form-divider" />
        <div className="language-form-row">
          <LanguageField id="host-language" label="I speak" value={hostLanguage} onChange={setHostLanguage} />
          <LanguageField id="guest-language" label="My guest speaks" value={guestLanguage} onChange={setGuestLanguage} />
        </div>
        <div className="language-form-row output-row">
          <LanguageField id="host-output" label="I want to hear" value={hostOutputLanguage} onChange={setHostOutputLanguage} />
          <LanguageField id="guest-output" label="My guest wants to hear" value={guestOutputLanguage} onChange={setGuestOutputLanguage} />
        </div>
        <div className="supported-note"><span className="status-dot" /> Speech, translation, and voice support checked for these languages.</div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary create-submit" type="submit" disabled={busy}>
          {busy ? <><span className="spinner spinner-light" /> Creating private room…</> : <>Create room <Glyph name="arrow" size={18} /></>}
        </button>
        <p className="form-disclosure">When enabled, Google Cloud processes call audio to provide transcription, translation, and translated speech.</p>
      </form>
    </div>
  </main>;
}

function LanguageField({ id, label, value, onChange }: { id: string; label: string; value: LanguageCode; onChange: (code: LanguageCode) => void }) {
  return <div className="language-field">
    <label className="field-label" htmlFor={id}>{label}</label>
    <select id={id} className="select-input" value={value} onChange={(event) => onChange(event.target.value as LanguageCode)}>
      {LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.name} · {language.code}</option>)}
    </select>
  </div>;
}

function RoomPage({ entry, roomId, inviteToken, onJoined, onEnd }: {
  entry: RoomEntry; roomId: string; inviteToken?: string; onJoined: () => void; onEnd: () => void
}) {
  const [inviteUrl, setInviteUrl] = useState('');
  const [revoked, setRevoked] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const isHost = entry.role === 'host';

  useEffect(() => {
    if (!isHost) return;
    const token = sessionStorage.getItem('invite:' + roomId);
    if (token) setInviteUrl(invitationUrl(roomId, token));
  }, [isHost, roomId]);

  if (entry.role === 'preview') {
    return <JoinPage room={entry.room} roomId={roomId} inviteToken={inviteToken || ''} onJoined={onJoined} />;
  }

  const copyInvite = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopyMessage('Invitation link copied');
      window.setTimeout(() => setCopyMessage(''), 2200);
    } catch {
      setCopyMessage('Copy is unavailable in this browser');
    }
  };

  const revoke = async () => {
    try {
      await api.revokeInvitation(roomId);
      setRevoked(true);
      sessionStorage.removeItem('invite:' + roomId);
      setInviteUrl('');
    } catch (error) {
      setCopyMessage(error instanceof Error ? error.message : 'Could not revoke the invitation.');
    }
  };

  return <main className="room-page">
    <div className="room-header">
      <div><button className="back-link" onClick={onEnd}>← Leave room</button><span className="eyebrow">PRIVATE ROOM</span><h1>{entry.room.title}</h1></div>
      <span className="room-state-pill"><i className="status-dot" /> {entry.room.status === 'active' ? 'IN CONVERSATION' : 'WAITING FOR GUEST'}</span>
    </div>
    <CallRoom
      room={entry.room}
      role={entry.role}
      iceServers={entry.iceServers}
      aiAvailable={entry.aiAvailable}
      inviteUrl={inviteUrl}
      inviteRevoked={revoked}
      onCopyInvite={() => void copyInvite()}
      onRevokeInvite={() => void revoke()}
      onEnd={async () => {
        try { await api.endRoom(roomId); } catch { /* the local media still needs to close */ }
        sessionStorage.removeItem('invite:' + roomId);
        onEnd();
      }}
    />
    {copyMessage && <div className="toast" role="status">{copyMessage}</div>}
  </main>;
}

function JoinPage({ room, roomId, inviteToken, onJoined }: { room: Room; roomId: string; inviteToken: string; onJoined: () => void }) {
  const [name, setName] = useState('');
  const [spokenLanguage, setSpokenLanguage] = useState<LanguageCode>(room.guestLanguage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.joinRoom(roomId, inviteToken, name, spokenLanguage);
      sessionStorage.removeItem('invite:' + roomId);
      onJoined();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This invitation cannot be joined.');
    } finally {
      setBusy(false);
    }
  };

  return <main className="join-page">
    <button className="back-link" onClick={() => { window.history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }}>← Back</button>
    <section className="join-card">
      <div className="join-icon"><Glyph name={room.callType === 'video' ? 'camera' : 'phone'} size={25} /></div>
      <span className="eyebrow">YOU’RE INVITED</span>
      <h1>Join {room.hostName}.</h1>
      <p className="join-subtitle">{room.title} · {room.callType} call</p>
      <div className="join-language-pair"><span>{languageName(room.hostLanguage)}</span><b>↔</b><span>{languageName(room.guestLanguage)}</span></div>
      <form onSubmit={(event) => void submit(event)}>
        <label className="field-label" htmlFor="guest-name">Your name</label>
        <input id="guest-name" className="text-input" required maxLength={60} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="How should we introduce you?" />
        <LanguageField id="guest-confirm-language" label="I speak" value={spokenLanguage} onChange={setSpokenLanguage} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary create-submit" type="submit" disabled={busy || spokenLanguage !== room.guestLanguage}>
          {busy ? <><span className="spinner spinner-light" /> Joining…</> : <>Join private call <Glyph name="arrow" size={18} /></>}
        </button>
      </form>
      <p className="permission-note"><Glyph name="mic" size={16} /> Your browser will ask for microphone{room.callType === 'video' ? ' and camera' : ''} access when the call connects.</p>
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);