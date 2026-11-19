'use client';

import { useEffect, useRef } from 'react';
import { GitHubIcon } from './icons';
import { DOWNLOAD_URL, GITHUB_URL } from '@/lib/links';

// After any download link on the page is clicked, a small thank-you that asks for a GitHub star.
// The download itself is left alone: the link still does what it always did.
export default function DownloadThanks() {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.('a');
      if (link?.getAttribute('href') !== DOWNLOAD_URL) return;
      // Let the browser start the download before the popup takes the screen.
      setTimeout(() => {
        if (!dialog.current?.open) dialog.current?.showModal();
      }, 400);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  const close = () => dialog.current?.close();

  return (
    <dialog
      ref={dialog}
      className="thanks"
      aria-labelledby="thanks-title"
      onClick={(e) => {
        if (e.target === dialog.current) close(); // a click on the backdrop
      }}
    >
      <button type="button" className="thanks-x" onClick={close} aria-label="close">×</button>
      <img src="/waffle.svg" alt="" width={56} height={56} />
      <h2 id="thanks-title">thanks for downloading.</h2>
      <p>waffle is free and open source. if you like it, a star on github helps other people find it.</p>
      <div className="thanks-row">
        <a className="btn dark" href={GITHUB_URL} target="_blank" rel="noreferrer" onClick={close}>
          <GitHubIcon size={17} /> star on github
        </a>
        <button type="button" className="btn" onClick={close}>maybe later</button>
      </div>
    </dialog>
  );
}
