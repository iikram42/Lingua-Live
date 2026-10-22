import * as speech from '@google-cloud/speech';
import * as textToSpeech from '@google-cloud/text-to-speech';
import { v2 as translateV2 } from '@google-cloud/translate';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { LANGUAGES, type LanguageCode } from './rooms.js';

export interface TranscriptUpdate { id: string; text: string; isFinal: boolean }
export interface RecognitionSession { write: (audio: Buffer) => void; close: () => void }

const speechClient = new speech.v1.SpeechClient();
const translateClient = new translateV2.Translate({ projectId: config.googleProjectId });
const ttsClient = new textToSpeech.TextToSpeechClient();
export const googleProvidersConfigured = config.googleConfigured;

export function createRecognitionSession(
  language: LanguageCode,
  sampleRateHertz: number,
  onTranscript: (update: TranscriptUpdate) => void,
  onError: (error: Error) => void
): RecognitionSession {
  let previousFinal = '';
  const createStream = () => {
    const stream = speechClient.streamingRecognize({
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz,
        languageCode: LANGUAGES[language].stt,
        model: 'latest_long',
        enableAutomaticPunctuation: true
      },
      interimResults: true
    });
    stream.on('data', (response) => {
      const result = response.results?.[0];
      const text = result?.alternatives?.[0]?.transcript?.trim();
      if (!text) return;
      const isFinal = Boolean(result?.isFinal);
      const end = result?.resultEndTime;
      if (isFinal && end) {
        const key = String(end.seconds || 0) + ':' + String(end.nanos || 0);
        if (key === previousFinal) return;
        previousFinal = key;
      }
      onTranscript({ id: randomUUID(), text, isFinal });
    });
    stream.on('error', (error: Error) => onError(error));
    return stream;
  };
  let stream = createStream();

  return {
    write(audio) {
      if (audio.byteLength > 24_000) {
        onError(new Error('Audio frame exceeded the provider stream limit.'));
        return;
      }
      if (stream.destroyed) stream = createStream();
      stream.write({ audioContent: audio });
    },
    close() {
      if (!stream.destroyed) stream.end();
    }
  };
}

export async function translateText(text: string, source: LanguageCode, target: LanguageCode): Promise<string> {
  const [translated] = await translateClient.translate(text, {
    from: LANGUAGES[source].translate,
    to: LANGUAGES[target].translate
  });
  if (typeof translated !== 'string' || !translated.trim()) throw new Error('Translation provider returned no text.');
  return translated;
}

export async function synthesizeSpeech(text: string, language: LanguageCode): Promise<Buffer> {
  const [response] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: { languageCode: language },
    audioConfig: { audioEncoding: 'MP3', speakingRate: 0.98 }
  });
  if (!response.audioContent) throw new Error('Speech provider returned no audio.');
  return Buffer.from(response.audioContent as Uint8Array);
}

export async function closeProviderClients(): Promise<void> {
  await Promise.allSettled([speechClient.close(), ttsClient.close()]);
}