// Audio capture and transcription for the main process.
//
// Two mono 16-bit PCM streams are captured while listening, one per speaker:
//   me   — the microphone, recorded by bin/waffle-speech --mic (AVAudioEngine, macOS 14+)
//   them — system audio output (the other people on a call), tapped by audiotee (macOS 14.2+)
// Each stream goes to its own LiveTranscriber, which turns it into text as it is heard: on this
// Mac with Apple's speech engine (bin/waffle-speech --stream, built from
// native/waffle-speech.swift), or, as a fallback, by cutting the audio into short phrases at
// pauses and sending each to an OpenAI-compatible speech API.

const { execFile, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');

// audiotee's own binary. In a packaged build it sits outside the asar archive, where the
// package's default path (inside the archive) cannot be executed.
const AUDIOTEE_BIN = path
  .join(__dirname, 'node_modules', 'audiotee', 'bin', 'audiotee')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const SILENCE_RMS = 60; // below this, audio counts as silence (16-bit scale)

function isSilent(pcm) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 1 < pcm.length; i += 64) {
    const sample = pcm.readInt16LE(i);
    sum += sample * sample;
    count += 1;
  }
  return !count || Math.sqrt(sum / count) < SILENCE_RMS;
}

function toWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

class AudioCapture {
  /**
   * @param {object} handlers
   * @param {(source: 'me' | 'them', pcm: Buffer) => void} handlers.onAudio  raw 16 kHz mono PCM
   * @param {(source: 'me' | 'them', message: string) => void} handlers.onError
   * @param {string} handlers.helper  path to waffle-speech, which records the microphone
   */
  constructor({ onAudio, onError, helper }) {
    this.onAudio = onAudio;
    this.helper = helper;
    this.onError = onError;
    this.mic = null;
    this.tee = null;
    this.active = false;
    this.paused = false; // while paused the recorders keep running but audio is dropped
  }

  deliver(source, pcm) {
    if (this.active && !this.paused) this.onAudio(source, pcm);
  }

  async start() {
    if (this.active) return;
    this.active = true;
    this.paused = false;
    this.startMic();
    await this.startSystemAudio();
  }

  startMic() {
    let child;
    try {
      child = spawn(this.helper, ['--mic'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.onError('me', err.message);
      return;
    }
    this.mic = child;
    let errText = '';
    child.stdout.on('data', (chunk) => this.deliver('me', chunk));
    child.stderr.on('data', (data) => (errText += data));
    child.stdin.on('error', () => {}); // a closed pipe is reported through 'exit'
    child.on('error', (err) => {
      if (this.mic === child) this.mic = null;
      this.onError(
        'me',
        err.code === 'ENOENT' ? "The microphone helper is missing. Run npm run build:speech." : err.message,
      );
    });
    child.on('exit', (code) => {
      if (this.mic !== child) return;
      this.mic = null;
      if (this.active && code !== 0) {
        this.onError('me', errText.trim().split('\n')[0] || `The microphone stopped (code ${code}).`);
      }
    });
  }

  async startSystemAudio() {
    if (process.platform !== 'darwin') return;
    try {
      const { AudioTee } = await import('audiotee');
      this.tee = new AudioTee({ sampleRate: SAMPLE_RATE, chunkDurationMs: 200, binaryPath: AUDIOTEE_BIN });
      this.tee.on('data', (chunk) => this.deliver('them', chunk.data));
      this.tee.on('error', (err) => this.active && this.onError('them', err.message));
      await this.tee.start();
    } catch (err) {
      this.tee = null;
      this.onError('them', err.message);
    }
  }

  async stop() {
    if (!this.active) return;
    this.active = false;
    if (this.mic) {
      const mic = this.mic;
      this.mic = null;
      mic.stdin.end(); // the helper stops when its stdin closes
      setTimeout(() => mic.exitCode === null && mic.signalCode === null && mic.kill(), 2000).unref();
    }
    if (this.tee) {
      try {
        await this.tee.stop();
      } catch {
        /* already exited */
      }
      this.tee = null;
    }
  }
}

/**
 * Send one WAV clip to an OpenAI-compatible transcription endpoint and return the text.
 * Many providers expose this same multipart shape, so the endpoint and model are configurable.
 */
async function transcribe(wav, { apiKey, endpoint, model }) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  form.append('response_format', 'json');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    if (response.status === 401) throw new Error('The speech API key was rejected.');
    throw new Error(`Speech API error (${response.status}): ${detail}`);
  }
  const body = await response.json();
  return typeof body.text === 'string' ? body.text.trim() : '';
}

// ---------- on-device transcription (Apple's speech engine) ----------

const HELPER_UNAVAILABLE = 3; // waffle-speech exit code: older macOS or unsupported language

function runHelper(helper, arg, timeout) {
  return new Promise((resolve, reject) => {
    execFile(helper, [arg], { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout).trim());
      const detail = String(stderr).trim().split('\n')[0];
      const error = new Error(
        err.code === 'ENOENT'
          ? "Apple's speech helper is missing. Run npm run build:speech."
          : err.killed
            ? "Apple's speech engine timed out."
            : detail || err.message,
      );
      error.unavailable = err.code === 'ENOENT' || err.code === HELPER_UNAVAILABLE;
      reject(error);
    });
  });
}

/**
 * Check whether Apple's speech engine can run here. The first check may download the language
 * model, so it gets a long timeout. Resolves { available, detail }.
 */
async function checkOnDevice(helper) {
  if (process.platform !== 'darwin') return { available: false, detail: 'Only available on macOS.' };
  try {
    await runHelper(helper, '--check', 5 * 60_000);
    return { available: true, detail: '' };
  } catch (err) {
    return { available: false, detail: err.message, permanent: err.unavailable };
  }
}

// ---------- live transcription ----------

const PHRASE_MIN_SECONDS = 2; // API fallback: shortest phrase worth a request
const PHRASE_MAX_SECONDS = 12; // API fallback: cut here even without a pause
const PAUSE_SECONDS = 0.5; // API fallback: this much quiet ends a phrase

/**
 * Turns one speaker's audio into text as it arrives. Emits:
 *   'partial' { text, start, end }  the current guess for words still being spoken
 *   'final'   { text, start, end }  settled text; times are seconds since listening started
 *   'fallback' message              Apple's engine failed and the speech API took over
 *   'problem'  message              something went wrong (transcription may have stopped)
 */
class LiveTranscriber extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.helper  path to waffle-speech
   * @param {boolean} options.onDevice  try Apple's engine first
   * @param {() => ({ apiKey: string, endpoint: string, model: string } | null)} options.api
   */
  constructor({ helper, onDevice, api }) {
    super();
    this.helper = helper;
    this.api = api;
    this.bytes = 0; // audio received so far, which sets the clock for every result
    this.child = null;
    this.phrase = []; // API mode: audio of the phrase being collected
    this.phraseBytes = 0;
    this.phraseStart = 0;
    this.queue = Promise.resolve(); // API mode: requests finish in order
    this.mode = onDevice ? 'device' : 'api';
    this.stopped = false;
    if (this.mode === 'device') this.startHelper();
    else if (!api()) process.nextTick(() => this.fail('Add a speech API key in Settings → Audio.'));
  }

  startHelper() {
    const offset = this.bytes / BYTES_PER_SECOND; // the helper's clock starts at zero
    let child;
    try {
      child = spawn(this.helper, ['--stream'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return this.switchToApi(err.message);
    }
    this.child = child;
    let out = '';
    let errText = '';
    child.stdout.on('data', (data) => {
      out += data;
      let newline;
      while ((newline = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, newline);
        out = out.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.t === 'partial' || message.t === 'final') {
          this.emit(message.t, { text: message.text.trim(), start: offset + message.start, end: offset + message.end });
        }
      }
    });
    child.stderr.on('data', (data) => (errText += data));
    child.stdin.on('error', () => {}); // a closed pipe is reported through 'exit'
    child.on('error', (err) =>
      this.switchToApi(err.code === 'ENOENT' ? "Apple's speech helper is missing. Run npm run build:speech." : err.message),
    );
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopped && code === 0) return this.emit('done');
      if (code !== 0) this.switchToApi(errText.trim().split('\n')[0] || `Apple's speech engine stopped (code ${code}).`);
      else this.emit('done');
    });
  }

  switchToApi(reason) {
    if (this.mode === 'api') return;
    this.child = null;
    if (!this.api()) return this.fail(`${reason} Add a speech API key in Settings → Audio as a fallback.`);
    this.mode = 'api';
    this.emit('fallback', reason);
    if (this.stopped) this.emit('done');
  }

  fail(message) {
    this.mode = 'off';
    this.emit('problem', message);
    if (this.stopped) this.emit('done');
  }

  write(pcm) {
    if (this.stopped) return;
    this.bytes += pcm.length;
    if (this.mode === 'device' && this.child) this.child.stdin.write(pcm);
    else if (this.mode === 'api') this.collect(pcm);
  }

  /** API mode: gather audio into a phrase and send it once the speaker pauses. */
  collect(pcm) {
    if (!this.phraseBytes) this.phraseStart = (this.bytes - pcm.length) / BYTES_PER_SECOND;
    this.phrase.push(pcm);
    this.phraseBytes += pcm.length;
    const seconds = this.phraseBytes / BYTES_PER_SECOND;
    if (seconds < PHRASE_MIN_SECONDS) return;
    const tailBytes = Math.min(this.phraseBytes, Math.round(PAUSE_SECONDS * BYTES_PER_SECOND));
    const all = Buffer.concat(this.phrase, this.phraseBytes);
    const paused = isSilent(all.subarray(all.length - tailBytes));
    if (paused || seconds >= PHRASE_MAX_SECONDS) this.sendPhrase(all);
  }

  sendPhrase(all = Buffer.concat(this.phrase, this.phraseBytes)) {
    const start = this.phraseStart;
    const end = start + all.length / BYTES_PER_SECOND;
    this.phrase = [];
    this.phraseBytes = 0;
    if (all.length < BYTES_PER_SECOND / 2 || isSilent(all)) return;
    this.queue = this.queue.then(async () => {
      const options = this.api();
      if (!options) return;
      try {
        const text = await transcribe(toWav(all.subarray(0, all.length - (all.length % 2))), options);
        if (text) this.emit('final', { text, start, end });
      } catch (err) {
        this.emit('problem', `Transcription: ${err.message}`);
      }
    });
  }

  /** Stop taking audio. Resolves once the last words have been written out. */
  stop() {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child?.kill();
        resolve();
      }, 8000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      if (this.mode === 'device' && this.child) {
        this.once('done', done);
        this.child.stdin.end();
      } else if (this.mode === 'api') {
        if (this.phraseBytes) this.sendPhrase();
        this.queue.then(done);
      } else done();
    });
  }
}

module.exports = { AudioCapture, LiveTranscriber, transcribe, checkOnDevice, AUDIOTEE_BIN };
