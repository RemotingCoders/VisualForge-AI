import { describe, it, expect } from 'vitest';
import { iosSpeechMode, voiceErrorMessage } from '../src/lib/useVoiceDictation';

/** Voice dictation helpers (Web Speech API). The hook itself needs a DOM, so
 *  the pure pieces that decide Safari/iOS behavior and the plain-language mic
 *  errors are covered here. Safari (WebKit) has no continuous recognition:
 *  those engines run non-continuous and restart on every onend. */

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

describe('iosSpeechMode — Safari/WebKit detection', () => {
  it('iPhone and iPad user agents are Safari mode even if both constructors exist', () => {
    const win = { SpeechRecognition: class {}, webkitSpeechRecognition: class {} };
    expect(iosSpeechMode(win, IPHONE_UA)).toBe(true);
    expect(iosSpeechMode(win, IPAD_UA)).toBe(true);
  });

  it('desktop Safari (only the webkit-prefixed constructor) is Safari mode', () => {
    expect(iosSpeechMode({ webkitSpeechRecognition: class {} }, SAFARI_UA)).toBe(true);
  });

  it('Chrome (unprefixed constructor) is not Safari mode', () => {
    expect(iosSpeechMode({ SpeechRecognition: class {}, webkitSpeechRecognition: class {} }, CHROME_UA)).toBe(false);
  });

  it('no speech constructors at all is not Safari mode (and not supported)', () => {
    expect(iosSpeechMode({}, 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe(false);
  });
});

describe('voiceErrorMessage — plain-language mic errors', () => {
  it('maps the known recognition error codes', () => {
    expect(voiceErrorMessage('not-allowed')).toBe('Microphone permission denied for this site');
    expect(voiceErrorMessage('service-not-allowed')).toBe('Enable Dictation in iOS Settings → Siri & Search');
    expect(voiceErrorMessage('no-speech')).toBe('No speech detected, try again');
    expect(voiceErrorMessage('network')).toBe('Speech service unavailable');
  });

  it('shows nothing for aborted (our own stop) or unknown codes', () => {
    expect(voiceErrorMessage('aborted')).toBeNull();
    expect(voiceErrorMessage('language-not-supported')).toBeNull();
    expect(voiceErrorMessage('')).toBeNull();
  });
});
