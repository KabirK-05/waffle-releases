'use client';

import { useState } from 'react';

// The hero demo: a video call with Waffle floating over it, and a switch that shows
// what the other people on the call see (no Waffle).
export default function Demo() {
  const [theirs, setTheirs] = useState(false);

  return (
    <div className="stage">
      <div className="switch" role="group" aria-label="whose screen">
        <button type="button" aria-pressed={!theirs} onClick={() => setTheirs(false)}>
          what you see
        </button>
        <button type="button" aria-pressed={theirs} onClick={() => setTheirs(true)}>
          what they see
        </button>
      </div>

      <div className="call">
        <div className="call-bar">
          <span className="dots" aria-hidden="true"><i /><i /><i /></span>
          <span>weekly sync</span>
          <span className="call-note">{theirs ? 'your shared screen' : 'your screen'}</span>
        </div>

        <div className="tiles">
          <video src="/call-1.webm" autoPlay muted loop playsInline aria-hidden="true" />
          <video src="/call-2.webm" autoPlay muted loop playsInline aria-hidden="true" />
        </div>

        <div className={`overlay${theirs ? ' gone' : ''}`} aria-hidden={theirs}>
          <div className="pill">
            <img src="/waffle.svg" alt="" width={20} height={20} />
            <span className="rec"><i />12:04</span>
            <span className="pill-btn">ask <kbd>⌘</kbd><kbd>↵</kbd></span>
            <span className="pill-btn dim">hide <kbd>⌘</kbd><kbd>\</kbd></span>
          </div>
          <div className="answer">
            <p className="heard"><b>them</b> so where are we on the migration?</p>
            <p>
              Say it&apos;s two weeks out. The schema change is done and the backfill is what&apos;s left.
              Offer Thursday for a demo.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
