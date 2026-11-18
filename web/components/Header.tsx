'use client';

import { useEffect, useState } from 'react';
import { AppleIcon, GitHubIcon } from './icons';
import { DOWNLOAD_URL, GITHUB_URL } from '@/lib/links';

// Always on screen. Past the top of the page it shrinks into a dark pill, like Waffle's own.
export default function Header() {
  const [pill, setPill] = useState(false);

  useEffect(() => {
    const onScroll = () => setPill(window.scrollY > 72);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`top${pill ? ' pill-mode' : ''}`}>
      <div className="nav">
        <a className="brand" href="/" aria-label="waffle">
          <img src="/waffle.svg" alt="" width={30} height={30} />
          <span>waffle</span>
        </a>
        <nav>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer"><GitHubIcon size={17} /> github</a>
          <a className="nav-cta" href={DOWNLOAD_URL}><AppleIcon size={15} /> download</a>
        </nav>
      </div>
    </header>
  );
}
