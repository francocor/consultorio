import type { ConsentMarkInput } from '@consultorio/contracts';
import { Eraser, PenLine, Type } from 'lucide-react';
import { useId, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../shared/lib/cn.js';
import { Button } from '../../../shared/ui/button.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';

/** The drawing surface. The image is small on purpose: the server refuses a heavy one. */
const CANVAS_WIDTH = 480;
const CANVAS_HEIGHT = 160;
const MIN_TYPED_LENGTH = 2;

type Mode = 'draw' | 'type';

export interface SignaturePadProps {
  /** Called with the mark the signer left, or null when there is none (cleared, name too short). */
  onChange: (mark: ConsentMarkInput | null) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * The mark of a signer: a drawing on a canvas, or a typed name. The typed name is the way for who
 * cannot draw (keyboard, screen reader): it is a full alternative, not a fallback, and the two
 * modes are two buttons placed BEFORE the canvas so they are the first thing a keyboard reaches.
 * Shared with the patient portal (`features/consent/index.ts`).
 */
export function SignaturePad({ onChange, disabled = false, className }: SignaturePadProps) {
  const { t } = useTranslation('consent');
  const [mode, setMode] = useState<Mode>('draw');
  const [typed, setTyped] = useState('');
  const [drawn, setDrawn] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const typedId = useId();

  // Changing mode forgets the other mark: what is sent is what the signer sees.
  const switchTo = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setDrawn(false);
    setTyped('');
    onChange(null);
  };

  const context = () => canvas.current?.getContext('2d') ?? null;

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = rect.width === 0 ? 1 : CANVAS_WIDTH / rect.width;
    const scaleY = rect.height === 0 ? 1 : CANVAS_HEIGHT / rect.height;
    return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
  };

  const start = (event: PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const ctx = context();
    if (!ctx) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const { x, y } = point(event);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111827';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.01, y + 0.01);
    ctx.stroke();
  };

  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = context();
    if (!ctx) return;
    const { x, y } = point(event);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const element = canvas.current;
    if (!element) return;
    setDrawn(true);
    onChange({ kind: 'drawn', imageDataUrl: element.toDataURL('image/png') });
  };

  const clear = () => {
    const element = canvas.current;
    const ctx = context();
    if (element && ctx) ctx.clearRect(0, 0, element.width, element.height);
    setDrawn(false);
    onChange(null);
  };

  return (
    <div className={cn('grid gap-3', className)}>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('signing.mark.mode')}>
        <Button
          type="button"
          variant={mode === 'draw' ? 'default' : 'outline'}
          size="sm"
          aria-pressed={mode === 'draw'}
          disabled={disabled}
          onClick={() => {
            switchTo('draw');
          }}
        >
          <PenLine aria-hidden="true" />
          {t('signing.mark.draw')}
        </Button>
        <Button
          type="button"
          variant={mode === 'type' ? 'default' : 'outline'}
          size="sm"
          aria-pressed={mode === 'type'}
          disabled={disabled}
          onClick={() => {
            switchTo('type');
          }}
        >
          <Type aria-hidden="true" />
          {t('signing.mark.type')}
        </Button>
      </div>

      {mode === 'draw' ? (
        <div className="grid gap-2">
          <canvas
            ref={canvas}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            role="img"
            aria-label={drawn ? t('signing.mark.canvasDrawn') : t('signing.mark.canvas')}
            className="h-40 w-full touch-none rounded-md border border-input bg-card"
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
          <div>
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={clear}>
              <Eraser aria-hidden="true" />
              {t('signing.mark.clear')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-1.5">
          <Label htmlFor={typedId}>{t('signing.mark.typedLabel')}</Label>
          <Input
            id={typedId}
            value={typed}
            maxLength={120}
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => {
              const name = event.target.value;
              setTyped(name);
              onChange(name.trim().length >= MIN_TYPED_LENGTH ? { kind: 'typed', name } : null);
            }}
          />
          <p className="text-sm text-muted-foreground">{t('signing.mark.typedHint')}</p>
        </div>
      )}
    </div>
  );
}
