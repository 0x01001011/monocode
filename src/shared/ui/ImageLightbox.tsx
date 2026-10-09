import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LAYER } from "../lib/layers";
import { X } from "./icons";

type Props = {
  src: string;
  alt: string;
  onClose: () => void;
};

type View = { scale: number; x: number; y: number };

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const DOUBLE_CLICK_SCALE = 2.5;
const IDENTITY: View = { scale: 1, x: 0, y: 0 };

// WebKit's non-standard pinch event; WKWebView sends these instead of
// ctrl+wheel for trackpad pinches.
type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };

export function ImageLightbox({ src, alt, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [view, setViewState] = useState<View>(IDENTITY);
  const viewRef = useRef(view);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const setView = (next: View) => {
      const clamped = clampView(next, container, imageRef.current);
      viewRef.current = clamped;
      setViewState(clamped);
    };

    // Zooms toward the pointer so the pixel under it stays put.
    const zoomAt = (scale: number, clientX: number, clientY: number) => {
      const current = viewRef.current;
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
      if (nextScale === MIN_SCALE) return setView(IDENTITY);
      const rect = container.getBoundingClientRect();
      const dx = clientX - (rect.left + rect.width / 2);
      const dy = clientY - (rect.top + rect.height / 2);
      const ratio = nextScale / current.scale;
      setView({
        scale: nextScale,
        x: dx - ratio * (dx - current.x),
        y: dy - ratio * (dy - current.y),
      });
    };

    let gestureStartScale: number | null = null;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      if (event.ctrlKey) {
        if (gestureStartScale !== null) return;
        const factor = Math.exp(-event.deltaY * unit * 0.01);
        zoomAt(viewRef.current.scale * factor, event.clientX, event.clientY);
        return;
      }
      const current = viewRef.current;
      if (current.scale === MIN_SCALE) return;
      setView({
        ...current,
        x: current.x - event.deltaX * unit,
        y: current.y - event.deltaY * unit,
      });
    };

    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartScale = viewRef.current.scale;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (gestureStartScale === null) return;
      const gesture = event as GestureEvent;
      zoomAt(gestureStartScale * gesture.scale, gesture.clientX, gesture.clientY);
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gestureStartScale = null;
    };

    const onDoubleClick = (event: MouseEvent) => {
      if (event.target !== imageRef.current) return;
      if (viewRef.current.scale > MIN_SCALE) setView(IDENTITY);
      else zoomAt(DOUBLE_CLICK_SCALE, event.clientX, event.clientY);
    };

    const onResize = () => setView(viewRef.current);

    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("gesturestart", onGestureStart);
    container.addEventListener("gesturechange", onGestureChange);
    container.addEventListener("gestureend", onGestureEnd);
    container.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("resize", onResize);
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("gesturestart", onGestureStart);
      container.removeEventListener("gesturechange", onGestureChange);
      container.removeEventListener("gestureend", onGestureEnd);
      container.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const startDrag = (event: React.PointerEvent<HTMLImageElement>) => {
    if (event.button !== 0 || viewRef.current.scale === MIN_SCALE) return;
    const container = containerRef.current;
    if (!container) return;
    const origin = { ...viewRef.current, pointerX: event.clientX, pointerY: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);

    const target = event.currentTarget;
    const onMove = (move: PointerEvent) => {
      const next = clampView(
        {
          scale: origin.scale,
          x: origin.x + move.clientX - origin.pointerX,
          y: origin.y + move.clientY - origin.pointerY,
        },
        container,
        imageRef.current,
      );
      viewRef.current = next;
      setViewState(next);
    };
    const onUp = () => {
      setDragging(false);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  const zoomed = view.scale > MIN_SCALE;

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Image preview: ${alt}`}
      className="fixed inset-0 flex items-center justify-center overflow-hidden bg-black/85 p-6 backdrop-blur-sm"
      style={{ zIndex: LAYER.dialog }}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        draggable={false}
        onPointerDown={startDrag}
        className={`max-h-full max-w-full select-none object-contain shadow-2xl ${
          zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"
        }`}
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          transition: dragging ? undefined : "transform 60ms ease-out",
        }}
      />
      <button
        ref={closeRef}
        type="button"
        aria-label="Close image preview"
        title="Close"
        onClick={onClose}
        className="absolute right-4 top-4 grid size-9 place-items-center rounded-full border border-white/15 bg-black/45 text-white/80 shadow-lg backdrop-blur-md hover:bg-black/65 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
      >
        <X className="size-4" strokeWidth={2} />
      </button>
    </div>,
    document.body,
  );
}

// Keeps a zoomed image covering the viewport on each axis it overflows, and
// centered on each axis it doesn't.
function clampView(
  view: View,
  container: HTMLElement,
  image: HTMLElement | null,
): View {
  if (!image || view.scale <= MIN_SCALE) return IDENTITY;
  const maxX = Math.max(0, (image.offsetWidth * view.scale - container.clientWidth) / 2);
  const maxY = Math.max(0, (image.offsetHeight * view.scale - container.clientHeight) / 2);
  return {
    scale: view.scale,
    x: Math.min(maxX, Math.max(-maxX, view.x)),
    y: Math.min(maxY, Math.max(-maxY, view.y)),
  };
}
