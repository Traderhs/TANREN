import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ history: [] as { key: string; value: string }[][] }));
vi.mock("./api", () => ({
  api: {
    japaneseImeLearningHistory: async () => storage.history.map((segments) => segments.map((segment) => ({ ...segment }))),
    recordJapaneseImeLearning: async (segments: { key: string; value: string }[]) => {
      storage.history.push(segments.map((segment) => ({ ...segment })));
    },
    undoJapaneseImeLearning: async () => { storage.history.pop(); },
  },
}));

describe("Japanese IME learning across restarts", () => {
  beforeEach(() => {
    vi.resetModules();
    storage.history = [];
    vi.stubGlobal("document", { baseURI: "http://localhost:1420/", querySelector: () => ({}) });
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval });
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("Worker", class {
      addEventListener() {}
      terminate() {}
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function mockEngine() {
    const connection = {
      init: vi.fn(async () => ({ features: { persist: true } })),
      learn: vi.fn(async () => true),
      revert: vi.fn(async () => true),
      callbacks: () => ({}),
    };
    let callbacks: Record<string, unknown> = {};
    vi.stubGlobal("Hechima", {
      version: "0.22.1",
      connectWorker: () => connection,
      createFep: (registered: Record<string, unknown>) => {
        callbacks = registered;
        return {};
      },
    });
    return { connection, callbacks: () => callbacks };
  }

  it("records committed conversions in app storage, then replays them in a fresh runtime", async () => {
    const first = mockEngine();
    const { loadJapaneseImeRuntime, flushJapaneseImeLearning } = await import("./japaneseIme");
    const runtime = await loadJapaneseImeRuntime();
    expect(first.connection.init).toHaveBeenCalledWith(expect.objectContaining({ learning: true, persist: false }));
    runtime.createSession({ show() {}, hide() {}, commit() {}, hostKey() {} });
    const segments = [{ key: "きょう", value: "今日" }];
    (first.callbacks().learn as (value: typeof segments) => void)(segments);
    await flushJapaneseImeLearning();
    expect(storage.history).toEqual([segments]);

    vi.resetModules(); // Simulate closing TANREN and loading a new process.
    const reopened = mockEngine();
    const nextRuntime = await (await import("./japaneseIme")).loadJapaneseImeRuntime();
    expect(reopened.connection.learn).toHaveBeenCalledWith(segments);
    nextRuntime.createSession({ show() {}, hide() {}, commit() {}, hostKey() {} });
    const nextSegments = [{ key: "あした", value: "明日" }];
    (reopened.callbacks().learn as (value: typeof nextSegments) => void)(nextSegments);
    await vi.waitFor(() => expect(storage.history).toEqual([segments, nextSegments]));
  });

  it("migrates the old browser backup only once into persistent app storage", async () => {
    const legacy = [{ key: "がっこう", value: "学校" }];
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify([legacy]) });
    const first = mockEngine();
    await (await import("./japaneseIme")).loadJapaneseImeRuntime();
    expect(storage.history).toEqual([legacy]);
    expect(first.connection.learn).toHaveBeenCalledWith(legacy);

    vi.resetModules();
    const reopened = mockEngine();
    await (await import("./japaneseIme")).loadJapaneseImeRuntime();
    expect(storage.history).toEqual([legacy]);
    expect(reopened.connection.learn).toHaveBeenCalledTimes(1);
  });
});
