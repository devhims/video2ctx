'use client';

import { useEffect, useRef, useState } from 'react';
import { AgentMarkdown } from './AgentMarkdown';

const CHARACTERS_PER_SECOND = 110;
const MIN_PAINT_INTERVAL_MS = 32;

export function StreamingAgentMarkdown({ text }: { text: string }) {
  const [visibleText, setVisibleText] = useState('');
  const [reduceMotion, setReduceMotion] = useState(false);
  const targetRef = useRef(text);
  const visibleRef = useRef('');

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduceMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    targetRef.current = text;
    if (reduceMotion) {
      visibleRef.current = text;
      setVisibleText(text);
    } else if (!text.startsWith(visibleRef.current)) {
      visibleRef.current = '';
      setVisibleText('');
    }
  }, [reduceMotion, text]);

  useEffect(() => {
    if (reduceMotion) return;
    let frame = 0;
    let carry = 0;
    let previous = performance.now();
    let lastPaint = previous;
    const reveal = (now: number) => {
      const target = targetRef.current;
      if (!target.startsWith(visibleRef.current)) {
        visibleRef.current = '';
        setVisibleText('');
      }
      carry += ((now - previous) / 1000) * CHARACTERS_PER_SECOND;
      previous = now;
      if (now - lastPaint >= MIN_PAINT_INTERVAL_MS && carry >= 1 && visibleRef.current.length < target.length) {
        const count = Math.floor(carry);
        carry -= count;
        visibleRef.current = target.slice(0, visibleRef.current.length + count);
        setVisibleText(visibleRef.current);
        lastPaint = now;
      }
      frame = requestAnimationFrame(reveal);
    };
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [reduceMotion]);

  return <div data-streaming-answer aria-busy={visibleText.length < text.length}>
    <AgentMarkdown>{visibleText}</AgentMarkdown>
  </div>;
}
