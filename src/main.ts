import "./style.css";
import JSZip from "jszip";
import { Editor } from "./editor";
import {
  deleteBackupFile,
  hasFsAccess,
  mimeForExt,
  pickInputViaFsAccess,
  readBackupBlob,
  readProgressFile,
  writeBackupFile,
  writeProgressFile,
} from "./folderIO";
import { canvasToBlob } from "./imageOps";
import type { ImageEntry, Method, ProgressFile, Tool } from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const els = {
  stepInput: $<HTMLElement>("stepInput"),
  stepWarning: $<HTMLElement>("stepWarning"),
  stepEditor: $<HTMLElement>("stepEditor"),

  btnPickInputBig: $<HTMLButtonElement>("btnPickInputBig"),
  pickedFolderName: $<HTMLElement>("pickedFolderName"),
  fsUnsupported: $<HTMLElement>("fsUnsupported"),
  btnBackToInput: $<HTMLButtonElement>("btnBackToInput"),

  btnStartEditing: $<HTMLButtonElement>("btnStartEditing"),

  btnBackToWizard: $<HTMLButtonElement>("btnBackToWizard"),
  btnExportZip: $<HTMLButtonElement>("btnExportZip"),
  modeIndicator: $<HTMLSpanElement>("modeIndicator"),
  btnPrev: $<HTMLButtonElement>("btnPrev"),
  btnNext: $<HTMLButtonElement>("btnNext"),
  btnUndo: $<HTMLButtonElement>("btnUndo"),
  btnReset: $<HTMLButtonElement>("btnReset"),
  btnSave: $<HTMLButtonElement>("btnSave"),
  progressText: $<HTMLSpanElement>("progressText"),
  imageCount: $<HTMLSpanElement>("imageCount"),
  treeRoot: $<HTMLDivElement>("treeRoot"),
  canvas: $<HTMLCanvasElement>("canvas"),
  lassoSvg: document.getElementById("lassoSvg") as unknown as SVGSVGElement,
  lassoPathOuter: document.getElementById("lassoPathOuter") as unknown as SVGPathElement,
  lassoPathInner: document.getElementById("lassoPathInner") as unknown as SVGPathElement,
  canvasPlaceholder: $<HTMLParagraphElement>("canvasPlaceholder"),
  brushCursor: $<HTMLDivElement>("brushCursor"),
  currentPath: $<HTMLSpanElement>("currentPath"),
  saveStatus: $<HTMLSpanElement>("saveStatus"),
  methodSelect: $<HTMLSelectElement>("methodSelect"),
  brushSize: $<HTMLInputElement>("brushSize"),
  brushSizeVal: $<HTMLSpanElement>("brushSizeVal"),
  blockSize: $<HTMLInputElement>("blockSize"),
  blockSizeVal: $<HTMLSpanElement>("blockSizeVal"),
  blurSigma: $<HTMLInputElement>("blurSigma"),
  blurSigmaVal: $<HTMLSpanElement>("blurSigmaVal"),

  tutorialPopover: $<HTMLElement>("tutorialPopover"),
  tutorialStepNo: $<HTMLElement>("tutorialStepNo"),
  tutorialTitle: $<HTMLElement>("tutorialTitle"),
  tutorialText: $<HTMLElement>("tutorialText"),
  btnTutorialSkip: $<HTMLButtonElement>("btnTutorialSkip"),
  btnTutorialNext: $<HTMLButtonElement>("btnTutorialNext"),
  btnShowTutorial: $<HTMLButtonElement>("btnShowTutorial"),

  zipModal: $<HTMLElement>("zipModal"),
  zipModalOverlay: $<HTMLElement>("zipModalOverlay"),
  zipModalCount: $<HTMLElement>("zipModalCount"),
  btnCloseZipModal: $<HTMLButtonElement>("btnCloseZipModal"),
  btnZipDownload: $<HTMLButtonElement>("btnZipDownload"),
};

type Step = "input" | "warning" | "editor";

const state = {
  step: "input" as Step,
  rootName: "",
  rootInputHandle: null as FileSystemDirectoryHandle | null,
  entries: [] as ImageEntry[],
  activeIndex: -1,
  hasFs: hasFsAccess(),
};

const TUTORIAL_SEEN_KEY = "image-mask:tutorial-seen";

const editor = new Editor(els.canvas, (s) => {
  els.btnUndo.disabled = !s.canUndo;
  els.btnSave.disabled = !s.hasImage;
});
editor.setLassoSvg(els.lassoSvg, els.lassoPathOuter, els.lassoPathInner);

async function persistProgress(): Promise<void> {
  if (!state.hasFs || !state.rootInputHandle) return;
  const progress: ProgressFile = {
    version: 1,
    rootName: state.rootName,
    lastUsedAt: Date.now(),
    entries: state.entries.map((e) => ({ relPath: e.relPath, status: e.status })),
  };
  try {
    await writeProgressFile(state.rootInputHandle, progress);
  } catch (e) {
    console.warn("progress write failed", e);
  }
}

function setStep(step: Step) {
  state.step = step;
  els.stepInput.hidden = step !== "input";
  els.stepWarning.hidden = step !== "warning";
  els.stepEditor.hidden = step !== "editor";
}

function applyFsSupport() {
  if (state.hasFs) return;
  els.fsUnsupported.hidden = false;
  els.btnPickInputBig.disabled = true;
}

function setModeIndicator() {
  if (state.rootInputHandle) {
    els.modeIndicator.textContent = `読み込み先: ${state.rootName}/`;
  } else {
    els.modeIndicator.textContent = "—";
  }
}

function setProgressText() {
  if (state.entries.length === 0) {
    els.progressText.textContent = "";
    return;
  }
  const saved = state.entries.filter((e) => e.status === "saved").length;
  const edited = state.entries.filter((e) => e.status === "edited").length;
  els.progressText.textContent = `${state.rootName} — ${state.entries.length} 枚 (保存済 ${saved} / 編集済 ${edited})`;
}

function renderTree() {
  els.imageCount.textContent = String(state.entries.length);
  if (state.entries.length === 0) {
    els.treeRoot.innerHTML = '<p class="empty">画像がありません。</p>';
    return;
  }
  const byFolder = new Map<string, ImageEntry[]>();
  for (const e of state.entries) {
    const arr = byFolder.get(e.folderPath) ?? [];
    arr.push(e);
    byFolder.set(e.folderPath, arr);
  }
  const folders = Array.from(byFolder.keys()).sort();
  const frag = document.createDocumentFragment();
  for (const folder of folders) {
    const group = document.createElement("div");
    group.className = "tree-folder";
    const head = document.createElement("div");
    head.className = "tree-folder-head";
    head.textContent = folder === "" ? "(ルート)" : folder + "/";
    group.appendChild(head);
    for (const entry of byFolder.get(folder)!) {
      const row = document.createElement("div");
      row.className = "tree-image";
      if (state.entries[state.activeIndex]?.id === entry.id) row.classList.add("active");
      const name = document.createElement("span");
      name.className = "tree-image-name";
      name.textContent = entry.fileName;
      const status = document.createElement("span");
      const isErr = !!entry.error;
      status.className = `tree-image-status ${isErr ? "err" : entry.status}`;
      status.textContent = isErr
        ? "失敗"
        : entry.status === "saved"
        ? "保存済"
        : entry.status === "edited"
        ? "編集済"
        : "未";
      if (isErr && entry.error) status.title = entry.error;
      row.appendChild(name);
      row.appendChild(status);
      row.addEventListener("click", () => {
        const idx = state.entries.indexOf(entry);
        if (idx >= 0) void selectEntry(idx);
      });
      group.appendChild(row);
    }
    frag.appendChild(group);
  }
  els.treeRoot.replaceChildren(frag);
}

async function selectEntry(index: number) {
  if (index < 0 || index >= state.entries.length) return;
  state.activeIndex = index;
  const entry = state.entries[index];
  els.currentPath.textContent = entry.relPath;
  els.canvasPlaceholder.style.display = "none";
  updateSaveStatusText();
  await editor.loadFromBlob(entry.editedBlob ?? entry.file);
  applyLockForEntry(entry);
  updateNavButtons();
  renderTree();
}

function applyLockForEntry(entry: ImageEntry) {
  editor.setLocked(entry.status === "saved");
}

function onLockedEditAttempt() {
  const ok = confirm(
    "この画像は保存済みです。\n\nリセットして元の画像から編集し直しますか？"
  );
  if (ok) void onReset();
}

function updateNavButtons() {
  els.btnPrev.disabled = state.activeIndex <= 0;
  els.btnNext.disabled = state.activeIndex < 0 || state.activeIndex >= state.entries.length - 1;
}

async function mergeFromBackup(
  rootHandle: FileSystemDirectoryHandle,
  entries: ImageEntry[],
  progress: ProgressFile
): Promise<void> {
  const statusMap = new Map(progress.entries.map((e) => [e.relPath, e.status]));
  for (const entry of entries) {
    const prev = statusMap.get(entry.relPath);
    if (!prev) continue;
    entry.status = prev;
    if (prev === "edited" || prev === "saved") {
      const blob = await readBackupBlob(rootHandle, entry.relPath);
      if (blob) entry.editedBlob = blob;
    }
  }
}

async function onPickInput() {
  try {
    let rootName: string;
    let entries: ImageEntry[];
    const picked = await pickInputViaFsAccess();
    rootName = picked.rootName;
    entries = picked.entries;
    const rootHandle: FileSystemDirectoryHandle = picked.rootHandle;

    let hasResume = false;
    const progress = await readProgressFile(rootHandle);
    if (progress) {
      const saved = progress.entries.filter((e) => e.status === "saved").length;
      const edited = progress.entries.filter((e) => e.status === "edited").length;
      if (saved + edited > 0) {
        await mergeFromBackup(rootHandle, entries, progress);
        hasResume = true;
      }
    }

    state.rootName = rootName;
    state.entries = entries;
    state.activeIndex = -1;
    state.rootInputHandle = rootHandle;

    await persistProgress();

    if (hasResume && entries.length > 0) {
      await startEditing();
      return;
    }

    if (entries.length === 0) {
      alert("画像が見つかりませんでした。jpg / png / webp が含まれるフォルダを選んでください。");
      return;
    }
    els.pickedFolderName.textContent = rootName;
    els.btnStartEditing.disabled = false;
    setStep("warning");
  } catch (e: any) {
    if (e?.name === "AbortError") return;
    alert(`入力フォルダ取得失敗: ${e?.message ?? e}`);
  }
}

async function startEditing() {
  setStep("editor");
  setModeIndicator();
  renderTree();
  setProgressText();
  const firstPending = state.entries.findIndex((e) => e.status !== "saved");
  if (firstPending >= 0) await selectEntry(firstPending);
  else if (state.entries.length > 0) await selectEntry(0);
  maybeShowTutorial();
}

type TutorialStep = {
  target: () => HTMLElement | null;
  title: string;
  body: string;
};

const tutorialSteps: TutorialStep[] = [
  {
    target: () => document.querySelector(".editor-toolbar") as HTMLElement,
    title: "ここで編集します",
    body: `<strong>投げ縄</strong>で囲む or <strong>ブラシ</strong>で塗ると、その範囲に
      <strong>黒塗り / 白塗り / モザイク / ぼかし</strong> が適用されます。
      強度やブラシサイズもここで調整できます。`,
  },
  {
    target: () => els.btnSave,
    title: "保存して次の画像へ",
    body: `編集が終わったら <kbd>S</kbd> キー、または <strong>この「保存して次へ」</strong>
      ボタンを押すと、修正済み画像が保存され、自動で次の画像に進みます。`,
  },
  {
    target: () => els.btnReset,
    title: "やり直したくなったら",
    body: `保存した画像はそのままでは編集できません。<strong>リセット</strong> を押すと
      元の画像に戻り、もう一度編集できるようになります。`,
  },
  {
    target: () => els.btnExportZip,
    title: "配布するとき",
    body: `<strong>「📦 ZIP でダウンロード」</strong> から、編集済み画像を
      フラット形式でまとめて取り出せます (配布用)。`,
  },
  {
    target: () => null,
    title: "途中でやめても大丈夫",
    body: `タブを閉じても、<strong>同じフォルダをもう一度開けば続きから再開</strong> できます。<br />
      進捗は選んだフォルダ内の <code>_image-mask-edited/</code> に保存されています。`,
  },
];

let tutorialIdx = -1;

function maybeShowTutorial() {
  try {
    if (localStorage.getItem(TUTORIAL_SEEN_KEY) === "1") return;
  } catch {
    /* ignore */
  }
  showTutorial();
}

function showTutorial() {
  tutorialIdx = 0;
  renderTutorial();
}

function renderTutorial() {
  if (tutorialIdx < 0 || tutorialIdx >= tutorialSteps.length) {
    dismissTutorial();
    return;
  }
  const step = tutorialSteps[tutorialIdx];
  const target = step.target();
  clearHighlight();
  if (target) target.classList.add("highlight-pulse");

  els.tutorialStepNo.textContent = `${tutorialIdx + 1} / ${tutorialSteps.length}`;
  els.tutorialTitle.textContent = step.title;
  els.tutorialText.innerHTML = step.body;
  els.btnTutorialNext.textContent =
    tutorialIdx === tutorialSteps.length - 1 ? "わかった" : "次へ →";

  els.tutorialPopover.style.visibility = "hidden";
  els.tutorialPopover.hidden = false;
  els.tutorialPopover.classList.toggle("centered", !target);
  requestAnimationFrame(() => {
    if (target) positionTutorialAt(target);
    else centerTutorial();
    els.tutorialPopover.style.visibility = "";
  });
}

function centerTutorial() {
  const popRect = els.tutorialPopover.getBoundingClientRect();
  const left = Math.max(8, (window.innerWidth - popRect.width) / 2);
  const top = Math.max(8, (window.innerHeight - popRect.height) / 2);
  els.tutorialPopover.style.left = `${left}px`;
  els.tutorialPopover.style.top = `${top}px`;
  els.tutorialPopover.classList.remove("place-above");
}

function clearHighlight() {
  document
    .querySelectorAll(".highlight-pulse")
    .forEach((el) => el.classList.remove("highlight-pulse"));
}

function nextTutorial() {
  tutorialIdx++;
  if (tutorialIdx >= tutorialSteps.length) {
    dismissTutorial();
    return;
  }
  renderTutorial();
}

function dismissTutorial() {
  els.tutorialPopover.hidden = true;
  tutorialIdx = -1;
  clearHighlight();
  try {
    localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
}

function positionTutorialAt(target: HTMLElement) {
  const targetRect = target.getBoundingClientRect();
  const popRect = els.tutorialPopover.getBoundingClientRect();
  const margin = 12;

  const spaceBelow = window.innerHeight - targetRect.bottom;
  const placeAbove = spaceBelow < popRect.height + margin + 8;

  let left = targetRect.left + targetRect.width / 2 - popRect.width / 2;
  const maxLeft = window.innerWidth - popRect.width - 8;
  if (left > maxLeft) left = maxLeft;
  if (left < 8) left = 8;

  const top = placeAbove
    ? targetRect.top - popRect.height - margin
    : targetRect.bottom + margin;

  els.tutorialPopover.style.left = `${left}px`;
  els.tutorialPopover.style.top = `${top}px`;
  els.tutorialPopover.classList.toggle("place-above", placeAbove);

  const arrow = els.tutorialPopover.querySelector(".tutorial-arrow") as HTMLElement;
  const arrowOffset = targetRect.left + targetRect.width / 2 - left - 7;
  arrow.style.left = `${Math.max(14, Math.min(popRect.width - 28, arrowOffset))}px`;
}

function backToWizard() {
  state.entries = [];
  state.activeIndex = -1;
  state.rootInputHandle = null;
  state.rootName = "";
  editor.clear();
  editor.setLocked(false);
  els.canvasPlaceholder.style.display = "block";
  els.btnStartEditing.disabled = true;
  els.progressText.textContent = "";
  setStep("input");
}

type SaveJob = {
  entry: ImageEntry;
  canvas: HTMLCanvasElement;
};

const saveQueue: SaveJob[] = [];
let saveWorkerRunning = false;

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d");
  if (ctx) ctx.drawImage(src, 0, 0);
  return c;
}

function updateSaveStatusText() {
  const pending = saveQueue.length + (saveWorkerRunning ? 1 : 0);
  const failed = state.entries.filter((e) => e.error).length;
  const parts: string[] = [];
  if (pending > 0) parts.push(`保存中 ${pending} 件`);
  if (failed > 0) parts.push(`失敗 ${failed} 件`);
  if (parts.length === 0) {
    if (els.saveStatus.classList.contains("err")) return;
    els.saveStatus.textContent = "";
    els.saveStatus.className = "save-status";
  } else {
    els.saveStatus.textContent = parts.join(" / ");
    els.saveStatus.className = failed > 0 ? "save-status err" : "save-status ok";
  }
}

async function processSaveJob(job: SaveJob) {
  const { entry, canvas } = job;
  const mime = mimeForExt(entry.ext);
  const quality = mime === "image/jpeg" || mime === "image/webp" ? 0.92 : undefined;
  try {
    const blob = await canvasToBlob(canvas, mime, quality);
    entry.editedBlob = blob;
    if (state.hasFs && state.rootInputHandle) {
      await writeBackupFile(state.rootInputHandle, entry.relPath, blob);
      entry.status = "saved";
    } else {
      entry.status = "edited";
    }
    entry.error = undefined;
    if (state.hasFs) {
      await persistProgress();
    }
  } catch (e: any) {
    entry.error = e?.message ?? String(e);
    entry.status = "pending";
    console.error(`[save] ${entry.relPath}:`, e);
  }
}

async function runSaveWorker() {
  if (saveWorkerRunning) return;
  saveWorkerRunning = true;
  try {
    while (saveQueue.length > 0) {
      const job = saveQueue.shift()!;
      await processSaveJob(job);
      setProgressText();
      renderTree();
      updateSaveStatusText();
    }
  } finally {
    saveWorkerRunning = false;
    setProgressText();
    renderTree();
    updateSaveStatusText();
  }
}

async function onReset() {
  const idx = state.activeIndex;
  if (idx < 0) return;
  const entry = state.entries[idx];
  const hadEdit = entry.status === "edited" || entry.status === "saved" || !!entry.editedBlob;

  entry.editedBlob = undefined;
  entry.error = undefined;
  entry.status = "pending";

  if (hadEdit && state.hasFs && state.rootInputHandle) {
    try {
      await deleteBackupFile(state.rootInputHandle, entry.relPath);
    } catch (e) {
      console.warn("delete backup failed", e);
    }
    await persistProgress();
  }

  await editor.loadFromBlob(entry.file);
  applyLockForEntry(entry);
  setProgressText();
  renderTree();
  updateSaveStatusText();
}

async function onSave() {
  const idx = state.activeIndex;
  if (idx < 0) return;
  const entry = state.entries[idx];
  const sourceCanvas = editor.exportCanvas();
  const cloned = cloneCanvas(sourceCanvas);

  entry.status = "edited";
  entry.error = undefined;
  saveQueue.push({ entry, canvas: cloned });
  setProgressText();
  renderTree();
  updateSaveStatusText();
  void runSaveWorker();

  const nextIdx = idx + 1;
  if (nextIdx < state.entries.length) {
    await selectEntry(nextIdx);
  }
}

function openZipModal() {
  const targets = state.entries.filter((e) => e.editedBlob);
  els.zipModalCount.textContent = `(${targets.length} ファイル)`;
  els.btnZipDownload.disabled = targets.length === 0;
  els.zipModal.hidden = false;
}

function closeZipModal() {
  els.zipModal.hidden = true;
}

function outputRelPath(relPath: string, flat: boolean): string {
  if (!flat) return relPath;
  return relPath.replace(/\//g, "_");
}

async function onZipDownload() {
  const targets = state.entries.filter((e) => e.editedBlob);
  if (targets.length === 0) return;
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="zipStyle"]:checked'
  );
  const flat = checked?.value !== "structured";

  els.btnZipDownload.disabled = true;
  const prev = els.btnZipDownload.textContent;
  els.btnZipDownload.textContent = "ZIP 生成中…";
  try {
    const zip = new JSZip();
    for (const entry of targets) {
      const blob = entry.editedBlob!;
      const buf = await blob.arrayBuffer();
      zip.file(outputRelPath(entry.relPath, flat), buf);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `${state.rootName || "output"}_${flat ? "flat" : "structured"}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    closeZipModal();
    els.saveStatus.textContent = `ZIP を書き出しました (${flat ? "フラット" : "階層"} / ${targets.length} 件)`;
    els.saveStatus.className = "save-status ok";
  } catch (e: any) {
    alert(`ZIP 書き出し失敗: ${e?.message ?? e}`);
  } finally {
    els.btnZipDownload.textContent = prev;
    els.btnZipDownload.disabled = targets.length === 0;
  }
}

function bindUi() {
  els.btnPickInputBig.addEventListener("click", () => void onPickInput());
  els.btnBackToInput.addEventListener("click", () => setStep("input"));
  els.btnStartEditing.addEventListener("click", () => void startEditing());
  els.btnStartEditing.disabled = true;

  els.btnBackToWizard.addEventListener("click", backToWizard);
  els.btnExportZip.addEventListener("click", () => {
    dismissTutorial();
    openZipModal();
  });
  els.btnZipDownload.addEventListener("click", () => void onZipDownload());
  els.btnCloseZipModal.addEventListener("click", closeZipModal);
  els.zipModalOverlay.addEventListener("click", closeZipModal);
  els.btnTutorialNext.addEventListener("click", nextTutorial);
  els.btnTutorialSkip.addEventListener("click", dismissTutorial);
  els.btnShowTutorial.addEventListener("click", showTutorial);
  window.addEventListener("resize", () => {
    if (!els.tutorialPopover.hidden && tutorialIdx >= 0) {
      const t = tutorialSteps[tutorialIdx].target();
      if (t) positionTutorialAt(t);
      else centerTutorial();
    }
  });

  els.btnPrev.addEventListener("click", () => void selectEntry(state.activeIndex - 1));
  els.btnNext.addEventListener("click", () => void selectEntry(state.activeIndex + 1));
  els.btnUndo.addEventListener("click", () => editor.undo());
  els.btnReset.addEventListener("click", () => void onReset());
  els.btnSave.addEventListener("click", () => void onSave());
  editor.setOnLockedAttempt(onLockedEditAttempt);

  let currentTool: Tool = "lasso";
  let cursorOnCanvas = false;

  const showCursor = () => {
    if (currentTool === "lasso" || !cursorOnCanvas) {
      els.brushCursor.hidden = true;
      return;
    }
    const d = editor.getBrushCssDiameter();
    if (d <= 0) {
      els.brushCursor.hidden = true;
      return;
    }
    els.brushCursor.style.width = `${d}px`;
    els.brushCursor.style.height = `${d}px`;
    els.brushCursor.classList.toggle("eraser", currentTool === "eraser");
    els.brushCursor.hidden = false;
  };

  document.querySelectorAll<HTMLInputElement>('input[name="tool"]').forEach((inp) => {
    inp.addEventListener("change", () => {
      if (inp.checked) {
        currentTool = inp.value as Tool;
        editor.setTool(currentTool);
        showCursor();
      }
    });
  });

  els.canvas.addEventListener("pointerenter", () => {
    cursorOnCanvas = true;
    showCursor();
  });
  els.canvas.addEventListener("pointerleave", () => {
    cursorOnCanvas = false;
    els.brushCursor.hidden = true;
  });
  els.canvas.addEventListener("pointermove", (e) => {
    if (els.brushCursor.hidden) return;
    els.brushCursor.style.left = `${e.clientX}px`;
    els.brushCursor.style.top = `${e.clientY}px`;
  });
  els.methodSelect.addEventListener("change", () =>
    editor.setMethod(els.methodSelect.value as Method)
  );
  els.brushSize.addEventListener("input", () => {
    const v = Number(els.brushSize.value);
    els.brushSizeVal.textContent = v.toFixed(1);
    editor.setBrushPercent(v);
    showCursor();
  });
  els.blockSize.addEventListener("input", () => {
    const v = Number(els.blockSize.value);
    els.blockSizeVal.textContent = v.toFixed(1);
    editor.setParams({ blockSize: v });
  });
  els.blurSigma.addEventListener("input", () => {
    const v = Number(els.blurSigma.value);
    els.blurSigmaVal.textContent = v.toFixed(1);
    editor.setParams({ blurSigma: v });
  });

  document.addEventListener("keydown", (e) => {
    if (state.step !== "editor") return;
    const target = e.target as HTMLElement | null;
    const inField =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      editor.undo();
      return;
    }
    if (inField || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "s") {
      e.preventDefault();
      if (!els.btnSave.disabled) void onSave();
    } else if (k === "arrowleft" || k === "a") {
      if (!els.btnPrev.disabled) {
        e.preventDefault();
        void selectEntry(state.activeIndex - 1);
      }
    } else if (k === "arrowright" || k === "d") {
      if (!els.btnNext.disabled) {
        e.preventDefault();
        void selectEntry(state.activeIndex + 1);
      }
    } else if (k === "z") {
      e.preventDefault();
      editor.undo();
    }
  });

  editor.setBrushPercent(Number(els.brushSize.value));
  editor.setParams({
    blockSize: Number(els.blockSize.value),
    blurSigma: Number(els.blurSigma.value),
  });
  editor.setMethod(els.methodSelect.value as Method);
}

applyFsSupport();
bindUi();
setStep("input");
