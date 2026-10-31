import { useEffect, useRef, useState } from 'react';

/** Browser voice dictation (Web Speech API) for the theme / part-description
 *  fields. Interim results are written into the field LIVE while speaking; the
 *  text stays editable afterwards. Dictation stops on a second press or after
 *  ~3 s of silence. Browsers without SpeechRecognition never show the button
 *  (`supported` stays false). When dictation ends with speech, onDone receives
 *  the final text — the caller asks Spark to review/tidy it (that review IS the
 *  theme moderation call, no extra call is made). */

interface SRResultItem { isFinal: boolean; 0: { transcript: string } }
interface SREvent { resultIndex: number; results: ArrayLike<SRResultItem> }
interface SRLike {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: SREvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void; stop(): void;
}
type SRCtor = new () => SRLike;

/** Minimal typings on purpose: SpeechRecognition is not in every TS DOM lib. */
function speechCtor(): SRCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
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
  const recRef = useRef<SRLike | null>(null);
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
      if (silenceRef.current) clearTimeout(silenceRef.current);
      const rec = recRef.current; recRef.current = null;
      if (rec) { rec.onend = null; try { rec.stop(); } catch { /* already stopped */ } }
    };
  }, []);

  const stop = () => { try { recRef.current?.stop(); } catch { /* already stopped */ } };

  const toggle = () => {
    if (listening) { stop(); return; }
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US'; // browser language, English fallback
    baseRef.current = textRef.current;
    committedRef.current = ''; interimRef.current = '';
    const armSilenceTimer = () => {
      if (silenceRef.current) clearTimeout(silenceRef.current);
      silenceRef.current = setTimeout(() => { try { rec.stop(); } catch { /* already stopped */ } }, 3000);
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
      armSilenceTimer(); // any speech (final or interim) pushes the 3 s silence stop out
    };
    rec.onend = () => {
      if (silenceRef.current) clearTimeout(silenceRef.current);
      if (recRef.current === rec) recRef.current = null;
      setListening(false);
      // Keep what the user SAW (base + finals + the last interim), so nothing vanishes.
      const finalText = joinSp(joinSp(baseRef.current, committedRef.current), interimRef.current).slice(0, 200);
      onTextRef.current(finalText);
      if (committedRef.current || interimRef.current) onDoneRef.current?.(finalText);
    };
    rec.onerror = () => { /* onend always follows and settles the state */ };
    recRef.current = rec;
    try { rec.start(); setListening(true); armSilenceTimer(); } catch { setListening(false); }
  };

  return { supported, listening, toggle };
}
