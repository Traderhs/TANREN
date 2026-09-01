export interface JapaneseImeSegment {
  text: string;
  kind: "yomi" | "focus" | "other";
  caretOffset?: number;
  candidates?: string[];
  candidateIndex?: number;
}

export interface JapaneseImeKeyTap {
  key: string;
  code?: string;
  repeat?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

export interface JapaneseImeSession {
  readonly active: boolean;
  setActive(on: boolean): boolean;
  feed(event: JapaneseImeKeyTap): boolean;
  feedUp(event: JapaneseImeKeyTap): boolean;
  selectCandidate(index: number): boolean;
  reset(): void;
}

export interface JapaneseImeCallbacks {
  show(segments: JapaneseImeSegment[]): void;
  hide(): void;
  commit(text: string): void;
  hostKey(name: string): void;
}

interface HechimaConnection {
  init(paths?: {
    wasmJs?: string;
    dataUrl?: string;
    learning?: boolean;
    scope?: string;
  }): Promise<unknown>;
  callbacks(): Record<string, unknown>;
}

interface HechimaApi {
  version: string;
  connectWorker(worker: Worker, options?: { maxCands?: number }): HechimaConnection;
  createFep(callbacks: Record<string, unknown>): JapaneseImeSession;
}

export interface JapaneseImeRuntime {
  version: string;
  createSession(callbacks: JapaneseImeCallbacks): JapaneseImeSession;
}

const HECHIMA_SCRIPT = "vendor/hechima/hechima.js";
const HECHIMA_WORKER = "vendor/hechima/hechima-worker.js";
const HECHIMA_WASM_JS = "vendor/hechima-wasm/hechima-wasm.js";
const HECHIMA_WASM = "vendor/hechima-wasm/mozc.data";
const EXPECTED_HECHIMA_VERSION = "0.22.1";

let scriptPromise: Promise<void> | null = null;
let runtimePromise: Promise<JapaneseImeRuntime> | null = null;

function assetUrl(path: string) {
  return new URL(path, document.baseURI).toString();
}

function loadHechimaScript() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-tanren-hechima="true"]');
    if (existing) {
      if ((globalThis as typeof globalThis & { Hechima?: HechimaApi }).Hechima) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Hechima script could not be loaded.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = assetUrl(HECHIMA_SCRIPT);
    script.async = true;
    script.dataset.tanrenHechima = "true";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Hechima script could not be loaded.")), { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    scriptPromise = null;
    throw error;
  });
  return scriptPromise;
}

async function createRuntime(): Promise<JapaneseImeRuntime> {
  await loadHechimaScript();
  const hechima = (globalThis as typeof globalThis & { Hechima?: HechimaApi }).Hechima;
  if (!hechima) throw new Error("Hechima did not expose its runtime API.");
  if (hechima.version !== EXPECTED_HECHIMA_VERSION) {
    throw new Error(`Unsupported Hechima version: ${hechima.version || "unknown"}`);
  }

  const worker = new Worker(assetUrl(HECHIMA_WORKER));
  const connection = hechima.connectWorker(worker, { maxCands: 20 });
  let timeoutId: number | null = null;
  const workerFailure = new Promise<never>((_, reject) => {
    worker.addEventListener("error", (event) => {
      reject(new Error(event.message || "Japanese IME worker could not be loaded."));
    }, { once: true });
  });
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error("Japanese IME initialization timed out.")), 15_000);
  });

  try {
    await Promise.race([
      connection.init({
        wasmJs: assetUrl(HECHIMA_WASM_JS),
        dataUrl: assetUrl(HECHIMA_WASM),
        learning: false,
        scope: "tanren",
      }),
      workerFailure,
      timeout,
    ]);
  } catch (error) {
    worker.terminate();
    throw error;
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }

  return {
    version: hechima.version,
    createSession(callbacks) {
      return hechima.createFep({
        ...connection.callbacks(),
        ...callbacks,
      });
    },
  };
}

export function loadJapaneseImeRuntime() {
  if (!runtimePromise) {
    runtimePromise = createRuntime().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

const SHIFTED_DIGITS: Record<string, string> = {
  Digit1: "!",
  Digit2: "@",
  Digit3: "#",
  Digit4: "$",
  Digit5: "%",
  Digit6: "^",
  Digit7: "&",
  Digit8: "*",
  Digit9: "(",
  Digit0: ")",
};

const PUNCTUATION: Record<string, [string, string]> = {
  Backquote: ["`", "~"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
};

function rawKeyFromCode(event: Pick<KeyboardEvent, "key" | "code" | "shiftKey">) {
  if (/^Key[A-Z]$/.test(event.code)) {
    const letter = event.code.slice(3).toLowerCase();
    return event.shiftKey ? letter.toUpperCase() : letter;
  }
  if (/^Digit[0-9]$/.test(event.code)) {
    return event.shiftKey ? SHIFTED_DIGITS[event.code] ?? event.key : event.code.slice(5);
  }
  if (/^Numpad[0-9]$/.test(event.code)) return event.code.slice(6);
  if (event.code === "Space") return " ";
  if (event.code === "NumpadDecimal") return ".";
  if (event.code === "NumpadAdd") return "+";
  if (event.code === "NumpadSubtract") return "-";
  if (event.code === "NumpadMultiply") return "*";
  if (event.code === "NumpadDivide") return "/";
  const punctuation = PUNCTUATION[event.code];
  if (punctuation) return punctuation[event.shiftKey ? 1 : 0];
  return event.key;
}

export function japaneseImeKeyTap(event: Pick<KeyboardEvent, "key" | "code" | "repeat" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">): JapaneseImeKeyTap {
  return {
    key: rawKeyFromCode(event),
    code: event.code,
    repeat: event.repeat,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
  };
}

export function japaneseImeKeyStartsInput(tap: JapaneseImeKeyTap) {
  return !tap.ctrlKey && !tap.altKey && !tap.metaKey && tap.key.length === 1 && tap.key.trim().length > 0;
}

