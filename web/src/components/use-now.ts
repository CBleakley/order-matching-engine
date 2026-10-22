import { useEffect, useState } from 'react';

// The current time in milliseconds, refreshed every `periodMs`.
export function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, periodMs);
    return () => {
      clearInterval(timer);
    };
  }, [periodMs]);
  return now;
}
