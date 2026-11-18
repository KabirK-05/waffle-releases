'use client';

import { useState } from 'react';
import { ChatIcon, ClaudeIcon, MicIcon, PeopleIcon, ShareIcon, VideoIcon } from './icons';

const DOCK = ['finder', 'safari', 'slack', 'zoom', 'settings'];

// The hero demo: a Mac desktop with a video call on it and Waffle floating over the call,
// plus a switch that shows what the other people on the call see (no Waffle).
export default function Demo() {
  const [theirs, setTheirs] = useState(false);

  return (
    <div className="demo">
      <div className="switch" role="group" aria-label="whose screen">
        <button type="button" aria-pressed={!theirs} onClick={() => setTheirs(false)}>
          what you see
        </button>
        <button type="button" aria-pressed={theirs} onClick={() => setTheirs(true)}>
          what they see
        </button>
      </div>

      <div className={`stage mac${theirs ? ' shared' : ''}`}>
        <div className="mac-bar" aria-hidden="true">
          <b>zoom</b>
          <span>meeting</span>
          <span>view</span>
          <span>window</span>
          <span className="mac-share">{theirs ? 'your shared screen' : 'your screen'}</span>
          <span>tue 12:04</span>
        </div>

        <div className="call">
          <div className="call-bar">
            <span className="dots" aria-hidden="true"><i /><i /><i /></span>
            <span>weekly sync</span>
            <span className="call-note"><i /> 24:18</span>
          </div>

          <div className="tiles">
            <div className="tile">
              <video src="/call-1.webm" autoPlay muted loop playsInline aria-hidden="true" />
              <span className="tile-name"><MicIcon size={12} /> maya</span>
            </div>
            <div className="tile">
              <video src="/call-2.webm" autoPlay muted loop playsInline aria-hidden="true" />
              <span className="tile-name"><MicIcon size={12} /> daniel</span>
            </div>
          </div>

          <div className="call-controls" aria-hidden="true">
            <span><MicIcon size={17} /> mute</span>
            <span className="wide-only"><VideoIcon size={17} /> stop video</span>
            <span className="wide-only"><PeopleIcon size={17} /> people</span>
            <span className="wide-only"><ChatIcon size={17} /> chat</span>
            <span className={theirs ? 'sharing' : ''}><ShareIcon size={17} /> {theirs ? 'sharing' : 'share'}</span>
            <span className="call-end">end</span>
          </div>
        </div>

        <div className={`overlay${theirs ? ' gone' : ''}`} aria-hidden={theirs}>
          <div className="pill">
            <img src="/waffle.svg" alt="" width={20} height={20} />
            <span className="rec"><i />12:04</span>
            <span className="pill-btn">ask <kbd>⌘</kbd><kbd>↵</kbd></span>
            <span className="pill-btn dim">hide <kbd>⌘</kbd><kbd>\</kbd></span>
          </div>

          <div className="panel">
            <p className="asked">what should i say?</p>
            <p className="heard"><b>them</b> so where are we on the migration?</p>
            <p className="said">
              Say it&apos;s two weeks out. The schema change is done and the backfill is what&apos;s left.
              Offer Thursday for a demo.
            </p>
            <div className="next">
              <span><kbd>⌘</kbd><kbd>1</kbd> what&apos;s the risk?</span>
              <span><kbd>⌘</kbd><kbd>2</kbd> draft the follow-up</span>
            </div>
            <div className="ask-row">
              <span className="ask-input">ask a follow-up</span>
              <span className="ask-model"><ClaudeIcon size={14} /> sonnet</span>
              <span className="ask-send">↵</span>
            </div>
          </div>
        </div>

        <div className="dock" aria-hidden="true">
          {DOCK.map((app) => (
            <span key={app} className={app === 'zoom' ? 'open' : ''}>
              <img src={`/apps/${app}.png`} alt="" width={40} height={40} />
            </span>
          ))}
          {/* Waffle leaves the dock too on the shared screen. */}
          <i className={theirs ? 'gone' : ''} />
          <span className={`open waffle-app${theirs ? ' gone' : ''}`}>
            <img src="/waffle.svg" alt="" width={30} height={30} />
          </span>
        </div>
      </div>
    </div>
  );
}
