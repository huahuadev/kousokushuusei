import { applyMaskedMethod, eraseToOriginal } from "./imageOps";
import type { Method, MethodParams, Tool } from "./types";

export interface EditorState {
  hasImage: boolean;
  dirty: boolean;
  canUndo: boolean;
}

export class Editor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private original: ImageData | null = null;
  private current: ImageData | null = null;
  private history: ImageData[] = [];
  private maxHistory = 30;

  private tool: Tool = "lasso";
  private method: Method = "black";
  private params: MethodParams = { blockSize: 2.0, blurSigma: 1.5 };
  private brushPercent = 3;

  private isDragging = false;
  private lastX = 0;
  private lastY = 0;
  private lassoPath: Array<{ x: number; y: number }> = [];
  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;
  private locked = false;
  private onLockedAttempt: (() => void) | null = null;

  private onChange: (state: EditorState) => void;

  constructor(canvas: HTMLCanvasElement, onChange: (state: EditorState) => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.previewCanvas = document.createElement("canvas");
    this.previewCtx = this.previewCanvas.getContext("2d")!;
    this.onChange = onChange;
    this.bindEvents();
  }

  private emit(): void {
    this.onChange({
      hasImage: this.original !== null,
      dirty: this.history.length > 0,
      canUndo: this.history.length > 0,
    });
  }

  async loadFromBlob(blob: Blob): Promise<void> {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("画像読込失敗"));
        el.src = url;
      });
      this.canvas.width = img.naturalWidth;
      this.canvas.height = img.naturalHeight;
      this.previewCanvas.width = img.naturalWidth;
      this.previewCanvas.height = img.naturalHeight;
      this.ctx.drawImage(img, 0, 0);
      const data = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      this.original = new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
      this.current = new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
      this.history = [];
      this.lassoPath = [];
      this.fitCanvasSize();
    } finally {
      URL.revokeObjectURL(url);
    }
    this.emit();
  }

  clear(): void {
    this.original = null;
    this.current = null;
    this.history = [];
    this.lassoPath = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.emit();
  }

  private fitCanvasSize(): void {
    const wrap = this.canvas.parentElement;
    if (!wrap) return;
    const maxW = wrap.clientWidth - 20;
    const maxH = wrap.clientHeight - 20;
    const ratio = this.canvas.width / this.canvas.height;
    let w = this.canvas.width;
    let h = this.canvas.height;
    if (w > maxW) { w = maxW; h = w / ratio; }
    if (h > maxH) { h = maxH; w = h * ratio; }
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  setTool(t: Tool): void { this.tool = t; }
  setMethod(m: Method): void { this.method = m; }
  setParams(p: Partial<MethodParams>): void { this.params = { ...this.params, ...p }; }
  setBrushPercent(p: number): void { this.brushPercent = p; }
  setLocked(v: boolean): void { this.locked = v; }
  setOnLockedAttempt(cb: (() => void) | null): void { this.onLockedAttempt = cb; }

  undo(): void {
    if (this.history.length === 0) return;
    const prev = this.history.pop()!;
    this.current = prev;
    this.repaint();
    this.emit();
  }

  resetAll(): void {
    if (!this.original) return;
    this.current = new ImageData(
      new Uint8ClampedArray(this.original.data),
      this.original.width,
      this.original.height
    );
    this.history = [];
    this.repaint();
    this.emit();
  }

  exportCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  private repaint(): void {
    if (!this.current) return;
    this.ctx.putImageData(this.current, 0, 0);
  }

  private snapshot(): void {
    if (!this.current) return;
    if (this.history.length >= this.maxHistory) this.history.shift();
    this.history.push(
      new ImageData(new Uint8ClampedArray(this.current.data), this.current.width, this.current.height)
    );
  }

  private bindEvents(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this.onDown(e));
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerup", (e) => this.onUp(e));
    c.addEventListener("pointercancel", (e) => this.onUp(e));
    c.addEventListener("pointerleave", (e) => {
      if (this.isDragging) this.onUp(e);
    });
    window.addEventListener("resize", () => {
      if (this.current) this.fitCanvasSize();
    });
  }

  private toLocal(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * this.canvas.height;
    return { x, y };
  }

  private brushRadius(): number {
    if (!this.canvas.width) return 10;
    const longSide = Math.max(this.canvas.width, this.canvas.height);
    return (longSide * this.brushPercent) / 100;
  }

  private onDown(e: PointerEvent): void {
    if (!this.current) return;
    if (this.locked) {
      if (this.onLockedAttempt) this.onLockedAttempt();
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.isDragging = true;
    const { x, y } = this.toLocal(e);
    this.lastX = x;
    this.lastY = y;
    this.snapshot();
    if (this.tool === "lasso") {
      this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
      this.lassoPath = [{ x, y }];
      this.drawLassoOverlay();
    } else {
      this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
      this.previewCtx.fillStyle = "white";
      this.drawBrushDot(x, y);
    }
  }

  private onMove(e: PointerEvent): void {
    if (!this.isDragging || !this.current) return;
    const { x, y } = this.toLocal(e);
    if (this.tool === "lasso") {
      this.lassoPath.push({ x, y });
      this.drawLassoOverlay();
    } else {
      this.drawBrushLine(this.lastX, this.lastY, x, y);
      this.lastX = x;
      this.lastY = y;
      this.repaintWithPreview();
    }
  }

  private onUp(e: PointerEvent): void {
    if (!this.isDragging) return;
    this.isDragging = false;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
    if (!this.current) return;

    if (this.tool === "lasso") {
      if (this.lassoPath.length >= 3) {
        this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
        this.previewCtx.fillStyle = "white";
        this.previewCtx.beginPath();
        this.previewCtx.moveTo(this.lassoPath[0].x, this.lassoPath[0].y);
        for (const p of this.lassoPath) this.previewCtx.lineTo(p.x, p.y);
        this.previewCtx.closePath();
        this.previewCtx.fill();
      }
      this.lassoPath = [];
    }

    const mask = this.buildMaskFromPreview();
    this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);

    if (this.tool === "eraser") {
      this.current = eraseToOriginal(this.current, this.original!, mask);
    } else {
      this.current = applyMaskedMethod(this.current, this.original!, mask, this.method, this.params);
    }
    this.repaint();
    this.emit();
  }

  private drawBrushDot(x: number, y: number): void {
    const r = this.brushRadius();
    this.previewCtx.beginPath();
    this.previewCtx.arc(x, y, r, 0, Math.PI * 2);
    this.previewCtx.fill();
  }

  private drawBrushLine(x0: number, y0: number, x1: number, y1: number): void {
    const r = this.brushRadius();
    this.previewCtx.lineCap = "round";
    this.previewCtx.lineJoin = "round";
    this.previewCtx.lineWidth = r * 2;
    this.previewCtx.strokeStyle = "white";
    this.previewCtx.beginPath();
    this.previewCtx.moveTo(x0, y0);
    this.previewCtx.lineTo(x1, y1);
    this.previewCtx.stroke();
  }

  private drawLassoOverlay(): void {
    if (!this.current) return;
    this.ctx.putImageData(this.current, 0, 0);
    if (this.lassoPath.length === 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const scale = rect.width > 0 ? this.canvas.width / rect.width : 1;
    const dashLen = 8 * scale;
    const gapLen = 6 * scale;
    const widthBlack = 3 * scale;
    const widthWhite = 1.5 * scale;

    this.ctx.save();
    this.ctx.lineCap = "butt";
    this.ctx.lineJoin = "miter";

    if (this.lassoPath.length === 1) {
      const p = this.lassoPath[0];
      const r = 4 * scale;
      this.ctx.fillStyle = "rgba(0,0,0,0.75)";
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, r + scale, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.fillStyle = "white";
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      this.ctx.fill();
    } else {
      this.ctx.beginPath();
      this.ctx.moveTo(this.lassoPath[0].x, this.lassoPath[0].y);
      for (let i = 1; i < this.lassoPath.length; i++) {
        this.ctx.lineTo(this.lassoPath[i].x, this.lassoPath[i].y);
      }
      this.ctx.setLineDash([]);
      this.ctx.lineWidth = widthBlack;
      this.ctx.strokeStyle = "rgba(0,0,0,0.75)";
      this.ctx.stroke();
      this.ctx.setLineDash([dashLen, gapLen]);
      this.ctx.lineWidth = widthWhite;
      this.ctx.strokeStyle = "rgba(255,255,255,1)";
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  private repaintWithPreview(): void {
    if (!this.current) return;
    this.ctx.putImageData(this.current, 0, 0);
    this.ctx.save();
    this.ctx.globalAlpha = 0.4;
    this.ctx.fillStyle = this.tool === "eraser" ? "#4ec07a" : "#4f8cff";
    this.ctx.globalCompositeOperation = "source-atop";
    const pImg = this.previewCtx.getImageData(0, 0, this.previewCanvas.width, this.previewCanvas.height);
    const d = pImg.data;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] > 0) {
        d[i - 3] = this.tool === "eraser" ? 78 : 79;
        d[i - 2] = this.tool === "eraser" ? 192 : 140;
        d[i - 1] = this.tool === "eraser" ? 122 : 255;
        d[i] = 180;
      }
    }
    const tmp = document.createElement("canvas");
    tmp.width = this.previewCanvas.width;
    tmp.height = this.previewCanvas.height;
    tmp.getContext("2d")!.putImageData(pImg, 0, 0);
    this.ctx.globalAlpha = 1;
    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.drawImage(tmp, 0, 0);
    this.ctx.restore();
  }

  private buildMaskFromPreview(): Uint8Array {
    const w = this.previewCanvas.width;
    const h = this.previewCanvas.height;
    const img = this.previewCtx.getImageData(0, 0, w, h);
    const mask = new Uint8Array(w * h);
    const d = img.data;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      if (d[i + 3] > 8) mask[j] = 1;
    }
    return mask;
  }
}
