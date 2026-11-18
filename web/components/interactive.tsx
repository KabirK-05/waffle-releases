'use client';

import { useEffect, useState } from 'react';
import { ChatGPTIcon, ClaudeIcon } from './icons';

// A session timer that keeps counting, with a waveform and the lines it just heard.
export function Listening() {
  const [secs, setSecs] = useState(16);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const clock = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;

  return (
    <div className="listen">
      <div className="clock">{clock}</div>
      <div className="clock-note"><i /> listening</div>
      <div className="wave" aria-hidden="true">
        {Array.from({ length: 44 }, (_, i) => (
          <i key={i} style={{ animationDelay: `${-((i * 37) % 100) / 60}s` }} />
        ))}
      </div>
      <div className="heard-lines">
        <p><b>me</b> can you walk me through the pricing?</p>
        <p><b className="them">them</b> sure. it&apos;s per seat, billed yearly.</p>
      </div>
    </div>
  );
}

const SUMMARY = [
  'pricing is per seat, billed yearly. they can do monthly for the first quarter.',
  'they need single sign-on before legal will approve it.',
  'send the security questionnaire by friday.',
  'next call is thursday, with their head of it.',
];
const TRANSCRIPT: [string, string, string][] = [
  ['me', '0:04', 'can you walk me through the pricing?'],
  ['them', '0:09', "sure. it's per seat, billed yearly."],
  ['me', '0:15', 'is monthly an option while we pilot it?'],
  ['them', '0:21', 'for the first quarter, yes.'],
  ['them', '0:34', "one thing: legal won't sign without single sign-on."],
];

// The page a finished session opens on: a title, a summary and the transcript.
export function Notes() {
  const [tab, setTab] = useState<'summary' | 'transcript'>('summary');

  return (
    <div className="notes">
      <div className="notes-bar">
        <span className="dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="notes-back">‹ back</span>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'summary'} onClick={() => setTab('summary')}>
            summary
          </button>
          <button type="button" role="tab" aria-selected={tab === 'transcript'} onClick={() => setTab('transcript')}>
            transcript
          </button>
        </div>
        <span className="notes-resume">▸ resume session</span>
      </div>
      <div className="notes-body">
        <p className="notes-date">tuesday, 2:30 pm · 24 min</p>
        <h3>Vendor call: pricing and single sign-on</h3>
        {tab === 'summary' ? (
          <ul>
            {SUMMARY.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <div className="lines">
            {TRANSCRIPT.map(([who, at, text]) => (
              <p key={at}>
                <b className={who}>{who}</b>
                <time>{at}</time>
                {text}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const Editor = ({ withWaffle }: { withWaffle: boolean }) => (
  <div className="editor">
    <div className="code" aria-hidden="true">
      {[62, 40, 78, 54, 30, 70, 46, 60, 36].map((w, i) => (
        <i key={i} style={{ width: `${w}%`, marginLeft: i % 3 === 0 ? 0 : 14 }} />
      ))}
    </div>
    {withWaffle && (
      <div className="tip">
        <img src="/waffle.svg" alt="" width={16} height={16} />
        <span>check for a missing <code>userId</code> before you call the api.</span>
      </div>
    )}
  </div>
);

// Drag the divider: your screen on the left, the shared one on the right.
export function Split() {
  const [x, setX] = useState(55);

  return (
    <div className="split" style={{ '--x': `${x}%` } as React.CSSProperties}>
      <Editor withWaffle={false} />
      <div className="split-mine">
        <Editor withWaffle />
      </div>
      <span className="tag left">you</span>
      <span className="tag right">everyone else</span>
      <span className="divider" aria-hidden="true"><i>↔</i></span>
      <input
        type="range"
        min={8}
        max={92}
        value={x}
        onChange={(e) => setX(Number(e.target.value))}
        aria-label="compare your screen with the shared screen"
      />
    </div>
  );
}

const clamp = (n: number) => Math.max(-1, Math.min(1, n));

// The arrow keys move a small Waffle around a screen.
export function Mover() {
  const [pos, setPos] = useState({ x: 0, y: -1 });
  const move = (dx: number, dy: number) => setPos((p) => ({ x: clamp(p.x + dx), y: clamp(p.y + dy) }));

  return (
    <div className="mover">
      <div className="mover-screen">
        <span
          className="mini"
          style={{ left: `${50 + pos.x * 30}%`, top: `${50 + pos.y * 30}%` }}
        >
          <img src="/waffle.svg" alt="" width={14} height={14} />
          <i /><i />
        </span>
      </div>
      <div className="keys">
        <span className="key wide">⌘</span>
        <span className="plus">+</span>
        <button type="button" className="key" onClick={() => move(0, -1)} aria-label="move up">↑</button>
        <button type="button" className="key" onClick={() => move(0, 1)} aria-label="move down">↓</button>
        <button type="button" className="key" onClick={() => move(-1, 0)} aria-label="move left">←</button>
        <button type="button" className="key" onClick={() => move(1, 0)} aria-label="move right">→</button>
      </div>
    </div>
  );
}

const TAPE = [
  <><ClaudeIcon size={18} /> claude pro</>,
  <><ChatGPTIcon size={18} /> chatgpt plus</>,
  <><ClaudeIcon size={18} /> claude max</>,
  <><ChatGPTIcon size={18} /> chatgpt pro</>,
  <><ClaudeIcon size={18} /> anthropic api key</>,
  <><ChatGPTIcon size={18} /> openai api key</>,
];

// A slow strip of the ways to bring your own AI.
export function Tape() {
  const [paused, setPaused] = useState(false);

  return (
    <div className="tape-wrap">
      <div className={`tape${paused ? ' paused' : ''}`}>
        <div className="tape-run">
          {[0, 1, 2, 3].map((n) => (
            <div className="tape-set" key={n} aria-hidden={n > 0}>
              {TAPE.map((item, i) => (
                <span key={i}>{item}</span>
              ))}
            </div>
          ))}
        </div>
      </div>
      <button type="button" className="tape-pause" onClick={() => setPaused((p) => !p)}>
        {paused ? 'play the tape' : 'pause the tape'}
      </button>
    </div>
  );
}
