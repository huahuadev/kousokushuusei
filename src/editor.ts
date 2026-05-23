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

  private lassoSvg: SVGSVGElement | null = null;
  private lassoPathOuter: SVGPathElement | null = null;
  private lassoPathInner: SVGPathElement | null = null;

  private onChange: (state: EditorState) => void;

  constructor(canvas: HTMLCanvasElement, onChange: (state: EditorState) => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.previewCanvas = document.createElement("canvas");
    this.previewCtx = this.previewCanvas.getContext("2d")!;
    this.onChange = onChange;
    this.bindEvents();
  }

  setLassoSvg(svg: SVGSVGElement, outer: SVGPathElement, inner: SVGPathElement): void {
    this.lassoSvg = svg;
    this.lassoPathOuter = outer;
    this.lassoPathInner = inner;
    outer.setAttribute("fill", "none");
    outer.setAttribute("stroke", "rgba(0,0,0,0.75)");
    outer.setAttribute("stroke-width", "3");
    outer.setAttribute("stroke-linecap", "round");
    outer.setAttribute("stroke-linejoin", "round");
    outer.setAttribute("vector-effect", "non-scaling-stroke");
    inner.setAttribute("fill", "none");
    inner.setAttribute("stroke", "white");
    inner.setAttribute("stroke-width", "1.5");
    inner.setAttribute("stroke-linecap", "round");
    inner.setAttribute("stroke-linejoin", "round");
    inner.setAttribute("stroke-dasharray", "8 6");
    inner.setAttribute("vector-effect", "non-scaling-stroke");
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
      if (this.lassoSvg) {
        this.lassoSvg.setAttribute("viewBox", `0 0 ${img.naturalWidth} ${img.naturalHeight}`);
        this.setLassoVisible(false);
      }
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
    this.setLassoVisible(false);
    this.emit();
  }

  private fitCanvasSize(): void {
    const wrap = this.canvas.closest(".canvas-wrap") as HTMLElement | null;
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

  getBrushCssDiameter(): number {
    if (!this.canvas.width) return 0;
    const rect = this.canvas.getBoundingClientRect();
    const scale = rect.width > 0 ? rect.width / this.canvas.width : 1;
    return this.brushRadius() * 2 * scale;
  }

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
      this.updateLassoSvg();
    } else if (this.tool === "eraser") {
      this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
      this.previewCtx.fillStyle = "white";
      this.drawBrushDot(x, y);
      this.commitEraserSegment();
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
      this.updateLassoSvg();
    } else if (this.tool === "eraser") {
      this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
      this.previewCtx.fillStyle = "white";
      this.drawBrushLine(this.lastX, this.lastY, x, y);
      this.lastX = x;
      this.lastY = y;
      this.commitEraserSegment();
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
        this.fillSmoothPath(this.previewCtx, this.lassoPath);
      }
      this.lassoPath = [];
      this.updateLassoSvg();
    } else if (this.tool === "eraser") {
      this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
      this.emit();
      return;
    }

    const mask = this.buildMaskFromPreview();
    this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
    this.current = applyMaskedMethod(this.current, this.original!, mask, this.method, this.params);
    this.repaint();
    this.emit();
  }

  private commitEraserSegment(): void {
    if (!this.current || !this.original) return;
    const mask = this.buildMaskFromPreview();
    this.current = eraseToOriginal(this.current, this.original, mask);
    this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
    this.repaint();
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

  private setLassoVisible(visible: boolean): void {
    if (!this.lassoSvg) return;
    if (visible) {
      this.lassoSvg.removeAttribute("hidden");
      this.lassoSvg.style.display = "block";
    } else {
      this.lassoSvg.setAttribute("hidden", "");
      this.lassoSvg.style.display = "none";
    }
  }

  private updateLassoSvg(): void {
    if (!this.lassoSvg || !this.lassoPathOuter || !this.lassoPathInner) return;
    if (this.lassoPath.length === 0) {
      this.setLassoVisible(false);
      this.lassoPathOuter.setAttribute("d", "");
      this.lassoPathInner.setAttribute("d", "");
      return;
    }
    this.setLassoVisible(true);
    const d = this.buildSvgPathData(this.lassoPath);
    this.lassoPathOuter.setAttribute("d", d);
    this.lassoPathInner.setAttribute("d", d);
  }

  private buildSvgPathData(path: Array<{ x: number; y: number }>): string {
    if (path.length === 0) return "";
    if (path.length === 1) {
      const p = path[0];
      const r = 0.5;
      return `M ${p.x - r} ${p.y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`;
    }
    let d = `M ${path[0].x} ${path[0].y}`;
    if (path.length < 3) {
      for (let i = 1; i < path.length; i++) d += ` L ${path[i].x} ${path[i].y}`;
      return d;
    }
    for (let i = 1; i < path.length - 1; i++) {
      const cx = (path[i].x + path[i + 1].x) / 2;
      const cy = (path[i].y + path[i + 1].y) / 2;
      d += ` Q ${path[i].x} ${path[i].y} ${cx} ${cy}`;
    }
    const last = path[path.length - 1];
    d += ` L ${last.x} ${last.y}`;
    return d;
  }

  private buildSmoothPath(
    ctx: CanvasRenderingContext2D,
    path: Array<{ x: number; y: number }>
  ): void {
    ctx.beginPath();
    if (path.length === 0) return;
    ctx.moveTo(path[0].x, path[0].y);
    if (path.length < 3) {
      for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
      return;
    }
    for (let i = 1; i < path.length - 1; i++) {
      const cx = (path[i].x + path[i + 1].x) / 2;
      const cy = (path[i].y + path[i + 1].y) / 2;
      ctx.quadraticCurveTo(path[i].x, path[i].y, cx, cy);
    }
    const last = path[path.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  private fillSmoothPath(
    ctx: CanvasRenderingContext2D,
    path: Array<{ x: number; y: number }>
  ): void {
    this.buildSmoothPath(ctx, path);
    ctx.closePath();
    ctx.fill();
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
