import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { columnIndexFromX, snapMinutes } from './calendar-layout.js';

/** How far the pointer must travel before a press becomes a drag (a plain click stays a click). */
const DRAG_THRESHOLD_PX = 4;

export interface DragPreview {
  id: string;
  /** Minutes the appointment moved, snapped to the step. */
  deltaMinutes: number;
  /** The column under the pointer. */
  columnIndex: number;
}

export interface DragDrop {
  id: string;
  deltaMinutes: number;
  columnIndex: number;
  /** Whether it landed where it started. */
  moved: boolean;
}

/**
 * Dragging an appointment with a mouse or a pen (touch keeps scrolling; a phone uses the list and
 * the "Reprogramar" action). The vertical distance becomes minutes, and the column comes from the
 * absolute pointer position over the columns area.
 */
export function useEventDrag(options: {
  columnsArea: () => HTMLElement | null;
  columns: number;
  pxPerMinute: number;
  step: number;
  startColumnIndex: (id: string) => number;
  onDrop: (drop: DragDrop) => void;
}) {
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const press = useRef<{ id: string; x: number; y: number; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const measure = useCallback((current: { y: number }, clientX: number, clientY: number) => {
    const area = latest.current.columnsArea();
    if (!area) return null;
    const rect = area.getBoundingClientRect();
    const { pxPerMinute, step, columns } = latest.current;
    return {
      deltaMinutes: snapMinutes((clientY - current.y) / pxPerMinute, step),
      columnIndex: columnIndexFromX({ x: clientX, left: rect.left, width: rect.width, columns }),
    };
  }, []);

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const current = press.current;
      if (!current) return;
      if (!current.dragging) {
        const travelled = Math.hypot(event.clientX - current.x, event.clientY - current.y);
        if (travelled < DRAG_THRESHOLD_PX) return;
        current.dragging = true;
      }
      const target = measure(current, event.clientX, event.clientY);
      if (target) setPreview({ id: current.id, ...target });
    }

    function onUp(event: PointerEvent) {
      const current = press.current;
      press.current = null;
      setPreview(null);
      if (!current?.dragging) return;
      suppressClick.current = true;
      // The click that follows a drag must not open the appointment.
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      const target = measure(current, event.clientX, event.clientY);
      if (!target) return;
      const origin = latest.current.startColumnIndex(current.id);
      latest.current.onDrop({
        id: current.id,
        ...target,
        moved: target.deltaMinutes !== 0 || target.columnIndex !== origin,
      });
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [measure]);

  const begin = useCallback((event: ReactPointerEvent, id: string) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    press.current = { id, x: event.clientX, y: event.clientY, dragging: false };
  }, []);

  /** True once, right after a drag ended, so the click that follows can be ignored. */
  const consumeClickSuppression = useCallback(() => {
    const value = suppressClick.current;
    suppressClick.current = false;
    return value;
  }, []);

  return { preview, begin, consumeClickSuppression };
}
