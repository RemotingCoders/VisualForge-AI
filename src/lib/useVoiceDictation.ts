import { useEffect, useRef, useState } from 'react';

/** Browser voice dictation (Web Speech API) for the theme / part-description
 *  fields. Interim results are written into the field LIVE while speaking; the
 *  text stays editable afterwards. Dictation stops on a second press or after
 *  ~3 s of silence once you are talking — with a 10 s grace period to START
 *  talking (the silence timer only exists once the first result lands).
 *  Browsers without SpeechRecognition never show the button (`supported` stays
 *  false). When dictation ends with speech, onDone receives the final text —
 *  the caller asks Spark to review/tidy it (that review IS the theme
 *  moderation call, no extra call is made).
 *
 *  Safari (iPhone/iPad AND desktop — same WebKit engine) cannot do continuous
 *  recognition: it ends the session after each phrase. There we run
 *  non-continuous and restart the recognizer on every onend until the user
 *  presses stop, the silence cut fires, or an error ends the session; finals
 *  keep accumulating across restarts exactly as in one continuous session.
 *  Recognition errors are surfaced under the field in plain language (`error`)
 *  and logged to the console with their code. */

interface SRResultItem { isFinal: boolean; 0: { transcript: string } }
interface SREvent { resultIndex: number; results: ArrayLike<SRResultItem> }
interface SRErrorEvent { error: string }
interface SRLike {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: SREvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  start(): void; stop(): void;
}
type SRCtor = new () => SRLike;

/** Minimal typings on purpose: SpeechRecognition is not in every TS DOM lib. */
function speechCtor(): SRCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** Safari-style recognition (WebKit): true on iPhone/iPad by user agent, and
 *  anywhere only the webkit-prefixed constructor exists (desktop Safari, every
 *  iOS browser). Those engines need continuous=false + restart-on-end. */
export function iosSpeechMode(win: { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }, userAgent: string): boolean {
  return /iPhone|iPad/.test(userAgent) || (!win.SpeechRecognition && Boolean(win.webkitSpeechRecognition));
}

/** Plain-language message per recognition error code, shown under the field.
 *  Codes not listed here (e.g. "aborted", fired by our own stop()) show nothing. */
const VOICE_ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'Microphone permission denied for this site',
  'service-not-allowed': 'Enable Dictation in iOS Settings → Siri & Search',
  'no-speech': 'No speech detected, try again',
  'network': 'Speech service unavailable',
};
export function voiceErrorMessage(code: string): string | null {
  return VOICE_ERROR_MESSAGES[code] ?? null;
}

/** Join two text parts with exactly one space between them (dictated transcripts
 *  arrive without reliable leading/trailing spacing). */
const joinSp = (a: string, b: string) => {
  const x = a.replace(/\s+$/, ''); const y = b.replace(/^\s+/, '');
  return x && y ? `${x} ${y}` : x + y;
};

export function useVoiceDictation(text: string, onText: (t: string) => void, onDone?: (t: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SRLike | null>(null);
  const wantRef = useRef(false);   // user wants dictation to continue (Safari restart loop)
  const baseRef = useRef('');      // field text when dictation started
  const committedRef = useRef(''); // finalized transcripts of this session
  const interimRef = useRef('');   // latest not-yet-final transcript
  const silenceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textRef = useRef(text); textRef.current = text;
  const onTextRef = useRef(onText); onTextRef.current = onText;
  const onDoneRef = useRef(onDone); onDoneRef.current = onDone;

  // Client-only detection (avoids hydration mismatch) + cleanup on unmount:
  // leaving the page mid-dictation stops the recognizer silently.
  useEffect(() => {
    setSupported(Boolean(speechCtor()));
    return () => {
      wantRef.current = false;
      if (silenceRef.current) clearTimeout(silenceRef.current);
      const rec = recRef.current; recRef.current = null;
      if (rec) { rec.onend = null; try { rec.stop(); } catch { /* already stopped */ } }
    };
  }, []);

  const stop = () => { wantRef.current = false; try { recRef.current?.stop(); } catch { /* already stopped */ } };

  const toggle = () => {
    if (listening) { stop(); return; }
    const Ctor = speechCtor();
    if (!Ctor) return;
    const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
    const safariMode = iosSpeechMode(w, navigator.userAgent);
    const rec = new Ctor();
    rec.continuous = !safariMode; // WebKit ends mid-dictation in continuous mode; Chrome is fine
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US'; // browser language, English fallback
    baseRef.current = textRef.current;
    committedRef.current = ''; interimRef.current = '';
    wantRef.current = true;
    setError(null);
    // The silence cut exists only once talking starts: 10 s of grace for the
    // FIRST result (armed at start), then a sliding 3 s after every result.
    const armSilence = (ms: number) => {
      if (silenceRef.current) clearTimeout(silenceRef.current);
      silenceRef.current = setTimeout(() => { wantRef.current = false; try { rec.stop(); } catch { /* already stopped */ } }, ms);
    };
    const settle = () => {
      if (silenceRef.current) clearTimeout(silenceRef.current);
      if (recRef.current === rec) recRef.current = null;
      setListening(false);
      // Keep what the user SAW (base + finals + the last interim), so nothing vanishes.
      const finalText = joinSp(joinSp(baseRef.current, committedRef.current), interimRef.current).slice(0, 200);
      onTextRef.current(finalText);
      if (committedRef.current || interimRef.current) onDoneRef.current?.(finalText);
    };
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) committedRef.current = joinSp(committedRef.current, r[0].transcript);
        else interim = joinSp(interim, r[0].transcript);
      }
      interimRef.current = interim;
      onTextRef.current(joinSp(joinSp(baseRef.current, committedRef.current), interim));
      armSilence(3000); // first result ends the grace period; talking now rules
    };
    rec.onend = () => {
      // Safari ends the session after every phrase: restart while the user
      // still wants to dictate and the silence cut has not fired. Finals and
      // the interim accumulate across restarts in the refs above.
      if (safariMode && wantRef.current) {
        try { rec.start(); return; } catch { /* cannot restart — settle below */ }
      }
      settle();
    };
    rec.onerror = e => {
      const code = e?.error ?? 'unknown';
      console.info(`[voice] speech recognition error: ${code}`);
      wantRef.current = false; // an error ends the session; onend settles
      setError(voiceErrorMessage(code));
    };
    recRef.current = rec;
    try { rec.start(); setListening(true); armSilence(10_000); } catch { setListening(false); }
  };

  return { supported, listening, toggle, error };
}
