import { useEffect, useRef, useState } from 'react';
import type { LanguageCode, Role, Room } from './types';
import { languageName } from './types';

interface CallRoomProps {
  room: Room;
  role: Role;
  iceServers: RTCIceServer[];
  aiAvailable: boolean;
  inviteUrl: string;
  inviteRevoked: boolean;
  onCopyInvite: () => void;
  onRevokeInvite: () => void;
  onEnd: () => Promise<void>;
}

type ConnectionState = 'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
interface TranscriptItem {
  id: string;
  sourceRole: Role;
  sourceText: string;
  translatedText?: string;
  isFinal: boolean;
  timing?: { speechToFinalMs: number | null; translationMs: number; synthesisMs: number; fromFinalTranscriptMs: number };
}
interface WireMessage {
  type?: string;
  role?: Role;
  peerConnected?: boolean;
  aiAvailable?: boolean;
  available?: boolean;
  message?: string;
  id?: string;
  sourceRole?: Role;
  sourceText?: string;
  translatedText?: string;
  isFinal?: boolean;
  audioBase64?: string;
  timing?: TranscriptItem['timing'];
  signal?: { kind?: string; data?: unknown };
}

function websocketUrl(roomId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return scheme + '//' + window.location.host + '/api/rooms/' + encodeURIComponent(roomId) + '/socket';
}

export function CallRoom(props: CallRoomProps) {
  const { room, role, iceServers, aiAvailable, inviteUrl, inviteRevoked, onCopyInvite, onRevokeInvite } = props;
  const onEndRef = useRef(props.onEnd);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const translationEnabledRef = useRef(true);
  const audioUnlockedRef = useRef(false);
  const playedIdsRef = useRef(new Set<string>());
  const pendingAudioRef = useRef<Array<{ id: string; sourceRole: Role; audioBase64: string }>>([]);
  const queueRef = useRef<Record<Role, Promise<void>>>({ host: Promise.resolve(), guest: Promise.resolve() });

  const [connection, setConnection] = useState<ConnectionState>('waiting');
  const [peerConnected, setPeerConnected] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState('');
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [originalAudioEnabled, setOriginalAudioEnabled] = useState(true);
  const [translatedAudioEnabled, setTranslatedAudioEnabled] = useState(true);
  const [translationStatus, setTranslationStatus] = useState(aiAvailable ? 'Connecting to translation…' : 'Translation is not configured.');
  const [translationError, setTranslationError] = useState('');
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [audioNeedsTap, setAudioNeedsTap] = useState(false);
  const [ending, setEnding] = useState(false);

  useEffect(() => { onEndRef.current = props.onEnd; }, [props.onEnd]);
  useEffect(() => {
    let disposed = false;
    let localStarted = false;
    let socket: WebSocket | null = null;
    let reconnectTimer = 0;
    let retryNumber = 0;
    let audioContext: AudioContext | null = null;
    let workletNode: AudioWorkletNode | null = null;
    let mutedGain: GainNode | null = null;
    const pendingIce: RTCIceCandidateInit[] = [];
    const peer = new RTCPeerConnection({ iceServers });

    const sendJson = (value: unknown) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
    };

    const startAudioCapture = async (stream: MediaStream) => {
      if (!aiAvailable) return;
      try {
        try {
          audioContext = new AudioContext({ sampleRate: 16_000 });
        } catch {
          audioContext = new AudioContext();
        }
        await audioContext.audioWorklet.addModule('/pcm-capture.js');
        if (disposed || !audioContext) return;
        sendJson({ type: 'audio-config', sampleRateHertz: audioContext.sampleRate });
        const source = audioContext.createMediaStreamSource(stream);
        workletNode = new AudioWorkletNode(audioContext, 'pcm-capture');
        mutedGain = audioContext.createGain();
        mutedGain.gain.value = 0;
        workletNode.port.onmessage = (event: MessageEvent<{ type: string; samples?: ArrayBuffer }>) => {
          if (event.data.type === 'speech-start') {
            sendJson({ type: 'speech-start', startedAt: Date.now() });
          }
          if (event.data.type === 'audio' && event.data.samples) {
            const floats = new Float32Array(event.data.samples);
            const pcm = new Int16Array(floats.length);
            for (let index = 0; index < floats.length; index += 1) {
              const sample = Math.max(-1, Math.min(1, floats[index]));
              pcm[index] = sample < 0 ? sample * 32_768 : sample * 32_767;
            }
            if (socket?.readyState === WebSocket.OPEN) socket.send(pcm.buffer);
          }
        };
        source.connect(workletNode);
        workletNode.connect(mutedGain);
        mutedGain.connect(audioContext.destination);
        setTranslationStatus('Listening for speech…');
      } catch {
        setTranslationError('Live captions could not start in this browser. The call can continue.');
      }
    };

    const createOffer = async () => {
      if (disposed || peer.signalingState !== 'stable') return;
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        sendJson({ type: 'signal', signal: { kind: 'offer', data: offer } });
      } catch {
        setConnection('reconnecting');
      }
    };

    const ensureLocalMedia = async () => {
      if (localStarted || disposed) return;
      localStarted = true;
      setConnection('connecting');
      setMediaError('');
      try {
        const constraints: MediaStreamConstraints = {
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: room.callType === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        localStreamRef.current = stream;
        setLocalStream(stream);
        stream.getTracks().forEach((track) => peer.addTrack(track, stream));
        if (aiAvailable) void startAudioCapture(stream);
        if (role === 'host') await createOffer();
      } catch (error) {
        localStarted = false;
        setConnection('failed');
        const message = error instanceof Error ? error.message : '';
        setMediaError(message.toLowerCase().includes('notallowed')
          ? 'Microphone or camera access was denied. Allow access in your browser settings, then retry.'
          : 'We could not access your microphone or camera. Check that a device is connected, then retry.');
      }
    };

    const applySignal = async (signal: NonNullable<WireMessage['signal']>) => {
      if (!signal.data || disposed) return;
      try {
        if (signal.kind === 'offer') {
          await ensureLocalMedia();
          await peer.setRemoteDescription(signal.data as RTCSessionDescriptionInit);
          while (pendingIce.length) await peer.addIceCandidate(pendingIce.shift()!);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          sendJson({ type: 'signal', signal: { kind: 'answer', data: answer } });
        } else if (signal.kind === 'answer') {
          await peer.setRemoteDescription(signal.data as RTCSessionDescriptionInit);
          while (pendingIce.length) await peer.addIceCandidate(pendingIce.shift()!);
        } else if (signal.kind === 'ice') {
          const candidate = signal.data as RTCIceCandidateInit;
          if (peer.remoteDescription) await peer.addIceCandidate(candidate);
          else pendingIce.push(candidate);
        }
      } catch {
        setConnection('reconnecting');
      }
    };

    const enqueueAudio = (message: { id: string; sourceRole: Role; audioBase64: string }) => {
      if (!translatedAudioEnabled || message.sourceRole === role || playedIdsRef.current.has(message.id)) return;
      playedIdsRef.current.add(message.id);
      if (!audioUnlockedRef.current) {
        pendingAudioRef.current.push(message);
        setAudioNeedsTap(true);
        return;
      }
      const run = async () => {
        if (!translationEnabledRef.current) return;
        const raw = atob(message.audioBase64);
        const bytes = new Uint8Array(raw.length);
        for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
        const audio = new Audio(url);
        audio.volume = 1;
        try {
          await audio.play();
          await new Promise<void>((resolve) => { audio.onended = () => resolve(); });
        } catch {
          pendingAudioRef.current.push(message);
          setAudioNeedsTap(true);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      queueRef.current[message.sourceRole] = queueRef.current[message.sourceRole].then(run);
    };

    const upsertTranscript = (message: WireMessage, translated = false) => {
      if (!message.id || !message.sourceRole) return;
      setTranscripts((current) => {
        const existing = current.find((item) => item.id === message.id);
        const next: TranscriptItem = {
          id: message.id!,
          sourceRole: message.sourceRole!,
          sourceText: message.sourceText || existing?.sourceText || '',
          translatedText: translated ? message.translatedText : existing?.translatedText,
          isFinal: Boolean(message.isFinal || translated || existing?.isFinal),
          timing: message.timing || existing?.timing
        };
        return existing
          ? current.map((item) => item.id === next.id ? next : item)
          : [...current, next].slice(-24);
      });
    };

    const connectSocket = () => {
      if (disposed) return;
      try {
        socket = new WebSocket(websocketUrl(room.id));
      } catch {
        setConnection('reconnecting');
        return;
      }
      socketRef.current = socket;
      socket.onopen = () => { retryNumber = 0; };
      socket.onmessage = (event: MessageEvent<string>) => {
        if (typeof event.data !== 'string') return;
        let message: WireMessage;
        try { message = JSON.parse(event.data) as WireMessage; } catch { return; }
        if (message.type === 'room-state') {
          setPeerConnected(Boolean(message.peerConnected));
          if (message.peerConnected) void ensureLocalMedia();
        } else if (message.type === 'peer-joined') {
          setPeerConnected(true);
          void ensureLocalMedia().then(() => {
            if (role === 'host' && peer.signalingState === 'stable') void createOffer();
          });
        } else if (message.type === 'peer-left') {
          setPeerConnected(false);
          setConnection('waiting');
        } else if (message.type === 'signal' && message.signal) {
          void applySignal(message.signal);
        } else if (message.type === 'translation-status') {
          setTranslationStatus(message.message || 'Translation status updated.');
        } else if (message.type === 'translation-error') {
          setTranslationError(message.message || 'A translated segment could not be delivered.');
        } else if (message.type === 'transcript') {
          upsertTranscript(message);
        } else if (message.type === 'utterance') {
          upsertTranscript(message, true);
          if (message.id && message.sourceRole && message.audioBase64) {
            enqueueAudio({ id: message.id, sourceRole: message.sourceRole, audioBase64: message.audioBase64 });
          }
        } else if (message.type === 'room-ended') {
          void onEndRef.current();
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnection('reconnecting');
        retryNumber += 1;
        reconnectTimer = window.setTimeout(connectSocket, Math.min(8_000, 800 * retryNumber));
      };
      socket.onerror = () => setConnection('reconnecting');
    };

    peer.onicecandidate = (event) => {
      if (event.candidate) sendJson({ type: 'signal', signal: { kind: 'ice', data: event.candidate.toJSON() } });
    };
    peer.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream && remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') setConnection('connected');
      else if (peer.connectionState === 'connecting' || peer.connectionState === 'new') setConnection('connecting');
      else if (peer.connectionState === 'disconnected') setConnection('reconnecting');
      else if (peer.connectionState === 'failed') {
        setConnection('reconnecting');
        try { peer.restartIce(); } catch { setConnection('failed'); }
      } else if (peer.connectionState === 'closed') setConnection('waiting');
    };

    connectSocket();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) socket.close();
      peer.close();
      workletNode?.disconnect();
      mutedGain?.disconnect();
      if (audioContext && audioContext.state !== 'closed') void audioContext.close();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      socketRef.current = null;
    };
  }, [room.id, room.callType, role, iceServers, aiAvailable]);

  useEffect(() => {
    translationEnabledRef.current = translatedAudioEnabled;
  }, [translatedAudioEnabled]);

  useEffect(() => {
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  const toggleMic = () => {
    const next = !micEnabled;
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = next; });
    setMicEnabled(next);
  };
  const toggleCamera = () => {
    const next = !cameraEnabled;
    localStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = next; });
    setCameraEnabled(next);
  };
  const unlockAudio = () => {
    audioUnlockedRef.current = true;
    setAudioNeedsTap(false);
    const pending = pendingAudioRef.current.splice(0);
    for (const message of pending) {
      const raw = atob(message.audioBase64);
      const bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
      const audio = new Audio(URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })));
      audio.play().then(() => {
        audio.onended = () => URL.revokeObjectURL(audio.src);
      }).catch(() => {
        setAudioNeedsTap(true);
        pendingAudioRef.current.push(message);
      });
    }
  };
  const endCall = async () => {
    if (ending) return;
    setEnding(true);
    await props.onEnd();
  };

  const connectionLabel = connection === 'connected' ? 'Connected' :
    connection === 'reconnecting' ? 'Reconnecting' :
    connection === 'failed' ? 'Connection trouble' :
    peerConnected ? 'Connecting call' : 'Waiting for guest';
  const remoteName = role === 'host' ? (room.guestName || 'Your guest') : room.hostName;
  const remoteLanguage: LanguageCode = role === 'host' ? room.guestLanguage : room.hostLanguage;
  const localLanguage: LanguageCode = role === 'host' ? room.hostLanguage : room.guestLanguage;

  return <div className="call-shell">
    {!peerConnected ? <section className="waiting-panel">
      <div className="waiting-orbit"><span><i className="status-dot" /></span><b /><b /></div>
      <span className="eyebrow">{room.callType.toUpperCase()} CALL · PRIVATE LINK</span>
      <h2>{role === 'host' ? 'Your room is ready.' : 'You’re in the room.'}</h2>
      <p>{role === 'host' ? 'Invite one person to join your conversation.' : 'Waiting for the host to connect.'}</p>
      {role === 'host' && <div className="invite-box">
        <div className="invite-address">{inviteRevoked ? 'Invitation revoked' : inviteUrl || 'Preparing your private link…'}</div>
        <button className="button button-primary" onClick={onCopyInvite} disabled={!inviteUrl || inviteRevoked}><span aria-hidden="true">▢</span> Copy link</button>
        {inviteUrl && !inviteRevoked && <button className="text-button danger-text" onClick={onRevokeInvite}>Revoke link</button>}
      </div>}
      <div className="room-language-summary"><span>{languageName(room.hostLanguage)}</span><b>↔</b><span>{languageName(room.guestLanguage)}</span><i>·</i><span>{room.callType === 'video' ? 'Video' : 'Voice'}</span></div>
      <button className="button button-secondary leave-button" onClick={() => void endCall()} disabled={ending}>{ending ? 'Leaving…' : 'End room'}</button>
    </section> : <div className="active-call">
      <section className="call-main">
        <div className={'call-video-stage ' + (room.callType === 'voice' ? 'voice-stage' : '')}>
          {room.callType === 'video' ? <>
            <video ref={remoteVideoRef} className="remote-video" autoPlay playsInline muted={!originalAudioEnabled} aria-label={remoteName + ' video'} />
            {!localStream && <div className="remote-placeholder"><span className="avatar avatar-sage">{remoteName.slice(0, 1).toUpperCase()}</span><strong>{remoteName}</strong><small>Connecting video…</small></div>}
            <video ref={localVideoRef} className="local-video" autoPlay playsInline muted aria-label="Your video" />
            <div className="video-name remote-name">{remoteName}<small>{languageName(remoteLanguage)}</small></div>
            <div className="video-name local-name">You<small>{languageName(localLanguage)}</small></div>
          </> : <>
            <video ref={remoteVideoRef} className="audio-only-video" autoPlay playsInline muted={!originalAudioEnabled} aria-label={remoteName + ' call audio'} />
            <div className="voice-person">
              <span className="voice-halo"><i /><i /><span className="avatar avatar-sage">{remoteName.slice(0, 1).toUpperCase()}</span></span>
              <strong>{remoteName}</strong><span>{languageName(remoteLanguage)} speaker</span>
              <span className="voice-connection"><i className="status-dot" /> {connectionLabel}</span>
            </div>
          </>}
          <div className="call-top-status"><span className={connection === 'connected' ? 'status-dot' : 'status-dot status-dot-muted'} />{connectionLabel}</div>
        </div>
        {mediaError && <div className="inline-alert" role="alert">{mediaError}<button onClick={() => window.location.reload()}>Retry</button></div>}
        <div className="call-controls" aria-label="Call controls">
          <ControlButton label={micEnabled ? 'Mute microphone' : 'Unmute microphone'} active={micEnabled} onClick={toggleMic} icon="mic" text={micEnabled ? 'Mute' : 'Unmute'} />
          {room.callType === 'video' && <ControlButton label={cameraEnabled ? 'Turn camera off' : 'Turn camera on'} active={cameraEnabled} onClick={toggleCamera} icon="camera" text={cameraEnabled ? 'Camera' : 'Camera off'} />}
          <ControlButton label={originalAudioEnabled ? 'Mute original audio' : 'Hear original audio'} active={originalAudioEnabled} onClick={() => setOriginalAudioEnabled(!originalAudioEnabled)} icon="wave" text={originalAudioEnabled ? 'Original on' : 'Original off'} />
          <ControlButton label={translatedAudioEnabled ? 'Mute translated voice' : 'Hear translated voice'} active={translatedAudioEnabled} onClick={() => setTranslatedAudioEnabled(!translatedAudioEnabled)} icon="translate" text={translatedAudioEnabled ? 'Translation on' : 'Translation off'} />
          <button className="control-button control-end" onClick={() => void endCall()} disabled={ending} aria-label="End call"><span className="control-icon">×</span><span>{ending ? 'Leaving…' : 'End call'}</span></button>
        </div>
      </section>
      <aside className="translation-panel">
        <div className="translation-panel-head"><div><span className="eyebrow">LIVE TRANSLATION</span><h2>Conversation</h2></div><button className={'caption-toggle ' + (captionsEnabled ? 'is-on' : '')} onClick={() => setCaptionsEnabled(!captionsEnabled)} aria-pressed={captionsEnabled}>CC</button></div>
        <div className={'translation-status ' + (aiAvailable ? 'translation-ready' : 'translation-offline')}><span className="status-dot" /><span>{translationStatus}</span></div>
        {translationError && <p className="translation-error" role="status">{translationError}</p>}
        {!aiAvailable && <div className="provider-note"><strong>Translation is off</strong><p>Connect Google Cloud credentials to turn on captions and translated speech. Your original call is working.</p></div>}
        {audioNeedsTap && translatedAudioEnabled && <button className="enable-audio" onClick={unlockAudio}>Tap to enable translated voice</button>}
        {captionsEnabled ? <div className="transcript-list" aria-live="polite" aria-relevant="additions text">
          {transcripts.length === 0 ? <div className="transcript-empty"><span className="empty-quote">“</span><p>Captions will appear here as you talk.</p><small>Speech is processed live and isn’t saved by this app.</small></div> :
            transcripts.slice(-8).map((item) => <article className={'transcript-item ' + (item.sourceRole === role ? 'transcript-self' : '')} key={item.id}>
              <div className="transcript-meta"><strong>{item.sourceRole === role ? 'You' : remoteName}</strong><span>{item.sourceRole === role ? languageName(localLanguage) : languageName(remoteLanguage)}</span>{!item.isFinal && <i>Listening…</i>}</div>
              <p>{item.sourceText}</p>
              {item.translatedText && <p className="translated-line">{item.translatedText}</p>}
              {item.timing && <small className="timing-note">Translated in {item.timing.translationMs + item.timing.synthesisMs} ms after speech recognition</small>}
            </article>)}
        </div> : <div className="captions-off"><span>CC</span><p>Captions are turned off.</p><button className="text-button" onClick={() => setCaptionsEnabled(true)}>Show captions</button></div>}
        <div className="translation-footer"><span><i className="status-dot" />{languageName(localLanguage)} <b>→</b> {languageName(remoteLanguage)}</span><small>Speech is processed by Google Cloud when enabled.</small></div>
      </aside>
    </div>}
  </div>;
}

function ControlButton({ label, active, onClick, icon, text }: { label: string; active: boolean; onClick: () => void; icon: string; text: string }) {
  return <button className={'control-button ' + (active ? 'control-active' : 'control-muted')} onClick={onClick} aria-label={label} aria-pressed={active}>
    <span className="control-icon">{icon === 'mic' ? '◖' : icon === 'camera' ? '▣' : icon === 'wave' ? '◉' : '文'}</span><span>{text}</span>
  </button>;
}