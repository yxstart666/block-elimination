import { UI_FRAMES } from './atlas-data.ts';

export type UiSpriteId = keyof typeof UI_FRAMES;
type SpriteFrame = { atlas: string; frame: { x: number; y: number; w: number; h: number };
  nineSliceInsets?: readonly number[]; logicalSize?: readonly number[] };
type ImageHandle = { src: string; onload: (() => void) | null; onerror: (() => void) | null };
const IMAGE_FILES = ['tiles.png', 'icons.png', 'ui.png', 'background.png'] as const;

/** Platform-owned image handles; no DOM or WeChat globals are accessed here. */
export class UiAssets {
  private images = new Map<string, ImageHandle>();
  private loaded = new Set<string>();
  private errors = new Set<string>();
  private disposed = false;
  private onReady: () => void;

  constructor(imageFactory: (() => any) | undefined, basePath = 'assets/ui/', onReady: () => void = () => {}) {
    this.onReady = onReady;
    const base = `${basePath.replace(/\/+$/, '')}/`;
    if (!imageFactory) { IMAGE_FILES.forEach(file => this.errors.add(file)); return; }
    for (const file of IMAGE_FILES) {
      try {
        const image = imageFactory() as ImageHandle;
        if (!image || typeof image !== 'object') throw new Error('Image factory returned no handle');
        this.images.set(file, image);
        let settled = false;
        const settle = (success: boolean) => {
          if (settled || this.disposed) return;
          settled = true;
          image.onload = null; image.onerror = null;
          if (success) this.loaded.add(file); else this.errors.add(file);
          // A synchronous test image must not re-enter a GameApp constructor.
          void Promise.resolve().then(() => { if (!this.disposed) this.onReady(); });
        };
        image.onload = () => settle(true);
        image.onerror = () => settle(false);
        image.src = base + file;
      } catch { this.errors.add(file); }
    }
  }

  get ready(): boolean { return !this.disposed && this.loaded.size === IMAGE_FILES.length; }
  get failed(): boolean { return this.errors.size > 0; }

  draw(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, w: number, h: number, nineSlice = false): boolean {
    const item = (UI_FRAMES as Record<string, SpriteFrame>)[id];
    if (this.disposed || !item || !this.loaded.has(item.atlas) || ![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return false;
    const image = this.images.get(item.atlas)!;
    const frame = item.frame;
    if (!nineSlice || !item.nineSliceInsets) {
      ctx.drawImage(image as unknown as CanvasImageSource, frame.x, frame.y, frame.w, frame.h, x, y, w, h);
      return true;
    }
    const [left, top, right, bottom] = item.nineSliceInsets;
    const unit = item.logicalSize ? Math.min(item.logicalSize[0] / frame.w, item.logicalSize[1] / frame.h) : 1;
    // Keep corners at their intended logical size. Only shrink for tiny targets.
    const scale = unit * Math.min(1, w / ((left + right) * unit), h / ((top + bottom) * unit));
    const sx = [frame.x, frame.x + left, frame.x + frame.w - right, frame.x + frame.w];
    const sy = [frame.y, frame.y + top, frame.y + frame.h - bottom, frame.y + frame.h];
    let dx = [x, x + left * scale, x + w - right * scale, x + w];
    let dy = [y, y + top * scale, y + h - bottom * scale, y + h];
    // Canvas antialiases separately drawn rectangles. Shared fractional edges
    // can otherwise leave hairlines between the nine patches at mobile DPRs.
    const matrix = typeof ctx.getTransform === 'function' ? ctx.getTransform() : undefined;
    if (matrix && Math.abs(matrix.b) < 1e-8 && Math.abs(matrix.c) < 1e-8 &&
      [matrix.a, matrix.d, matrix.e, matrix.f].every(Number.isFinite) && Math.abs(matrix.a) > 0 && Math.abs(matrix.d) > 0) {
      dx = dx.map(value => (Math.round(value * matrix.a + matrix.e) - matrix.e) / matrix.a);
      dy = dy.map(value => (Math.round(value * matrix.d + matrix.f) - matrix.f) / matrix.d);
    }
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
      const sw = sx[col + 1] - sx[col], sh = sy[row + 1] - sy[row];
      const dw = dx[col + 1] - dx[col], dh = dy[row + 1] - dy[row];
      if (sw > 0 && sh > 0 && dw > 0 && dh > 0) ctx.drawImage(image as unknown as CanvasImageSource,
        sx[col], sy[row], sw, sh, dx[col], dy[row], dw, dh);
    }
    return true;
  }

  /** Preserve icon proportions inside the requested rectangle. */
  fit(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, w: number, h: number): boolean {
    const item = (UI_FRAMES as Record<string, SpriteFrame>)[id];
    if (!item) return false;
    const scale = Math.min(w / item.frame.w, h / item.frame.h);
    const width = item.frame.w * scale, height = item.frame.h * scale;
    return this.draw(ctx, id, x + (w - width) / 2, y + (h - height) / 2, width, height);
  }

  /** The source background is 390×844; cover without distorting its texture. */
  background(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): boolean {
    if (this.disposed || !this.loaded.has('background.png') || ![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return false;
    const sourceW = 390, sourceH = 844, ratio = Math.max(w / sourceW, h / sourceH);
    const sw = w / ratio, sh = h / ratio;
    ctx.drawImage(this.images.get('background.png') as unknown as CanvasImageSource,
      (sourceW - sw) / 2, (sourceH - sh) / 2, sw, sh, x, y, w, h);
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const image of this.images.values()) { image.onload = null; image.onerror = null; }
    this.images.clear(); this.loaded.clear();
  }
}
