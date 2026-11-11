import { type PointerEvent as ReactPointerEvent, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ViewTransform {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.3;
const MAX_K = 1.75;
const FIT_PAD = 18;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Pan and zoom for the diagram canvas.
 *
 * Drag the background to pan; scroll pans; pinch or Ctrl/Cmd + scroll zooms
 * around the pointer. The view keeps itself fitted to the content until the
 * user moves it, and `fit()` hands control back.
 */
export function usePanZoom(viewportRef: RefObject<HTMLDivElement | null>, content: { width: number; height: number }) {
  const [view, setView] = useState<ViewTransform>({ x: 0, y: 0, k: 1 });
  const [panning, setPanning] = useState(false);
  const auto = useRef(true);
  const drag = useRef<{ id: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  const computeFit = useCallback((): ViewTransform | undefined => {
    const el = viewportRef.current;
    if (!el || content.width === 0) return undefined;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    if (vw === 0 || vh === 0) return undefined;
    const k = clamp(Math.min((vw - FIT_PAD * 2) / content.width, (vh - FIT_PAD * 2) / content.height, 1), MIN_K, 1);
    const x = (vw - content.width * k) / 2;
    // Top-align tall content; centre content that is shorter than the viewport.
    const y = Math.max(FIT_PAD, (vh - content.height * k) / 2);
    return { x, y, k };
  }, [viewportRef, content.width, content.height]);

  const fit = useCallback(() => {
    auto.current = true;
    const next = computeFit();
    if (next) setView(next);
  }, [computeFit]);

  useLayoutEffect(() => {
    if (!auto.current) return;
    const next = computeFit();
    if (next) setView(next);
  }, [computeFit]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!auto.current) return;
      const next = computeFit();
      if (next) setView(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewportRef, computeFit]);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const py = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    auto.current = false;
    setView((v) => {
      const k = clamp(v.k * factor, MIN_K, MAX_K);
      const ratio = k / v.k;
      return { k, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
    });
  }, [viewportRef]);

  // Wheel needs a non-passive listener so the page itself never zooms or scrolls.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * 0.0045), event.clientX, event.clientY);
      } else {
        auto.current = false;
        const dx = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
        const dy = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY;
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewportRef, zoomAt]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      // Cards, nodes and controls opt out of panning.
      if ((event.target as HTMLElement).closest('[data-nopan]')) return;
      drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y };
      event.currentTarget.setPointerCapture(event.pointerId);
      setPanning(true);
    },
    [view.x, view.y],
  );

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.startX;
    const dy = event.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 2) auto.current = false;
    setView((v) => ({ ...v, x: d.originX + dx, y: d.originY + dy }));
  }, []);

  const endPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  return {
    view,
    panning,
    fit,
    zoomIn: () => zoomAt(1.2),
    zoomOut: () => zoomAt(1 / 1.2),
    /** Spread onto the viewport element. */
    handlers: { onPointerDown, onPointerMove, onPointerUp: endPan, onPointerCancel: endPan },
  };
}
