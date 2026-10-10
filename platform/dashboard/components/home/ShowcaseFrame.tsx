'use client';

import { useEffect, useState } from 'react';

/** Embeds /showcase.html (the animated console tour) and sizes it to the height it reports. */
export function ShowcaseFrame() {
  const [height, setHeight] = useState(920);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data as { type?: string; h?: number };
      if (d?.type === 'aapstack-showcase-height' && typeof d.h === 'number' && d.h > 200) setHeight(Math.ceil(d.h));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <iframe
      src="/showcase.html"
      title="AapStack console tour: phone OTP, table editor, SQL editor and email sign-in"
      loading="lazy"
      className="block w-full border-0"
      style={{ height }}
    />
  );
}
