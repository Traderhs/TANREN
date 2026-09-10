export type EffectSound = "page-flutter" | "book-close" | "correct" | "incorrect" | "complete";

type SampleOptions = {
  volume: number;
  delayMs?: number;
  stopAfterMs?: number;
  playbackRate?: number;
};

const samples = {
  pageTurn: "/sfx/page-turn.mp3",
  bookClose: "/sfx/book-close.mp3",
  correct: "/sfx/correct.mp3",
  incorrect: "/sfx/incorrect.mp3",
  complete: "/sfx/complete.mp3",
} as const;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function playSample(src: string, masterVolume: number, options: SampleOptions) {
  const play = () => {
    const audio = new Audio(src);
    audio.preload = "auto";
    audio.volume = clamp01(masterVolume * options.volume) * 0.5;
    audio.playbackRate = options.playbackRate ?? 1;
    void audio.play().then(() => {
      if (options.stopAfterMs) {
        window.setTimeout(() => {
          audio.pause();
          audio.currentTime = 0;
        }, options.stopAfterMs);
      }
    }).catch(() => undefined);
  };

  if (options.delayMs) window.setTimeout(play, options.delayMs);
  else play();
}

export function playEffectSound(sound: EffectSound, volume: number) {
  const level = clamp01(volume);
  if (level <= 0) return;

  switch (sound) {
    case "page-flutter":
      playSample(samples.pageTurn, level, { volume: 0.52, stopAfterMs: 750 });
      break;
    case "book-close":
      playSample(samples.bookClose, level, { volume: 0.68, stopAfterMs: 600 });
      break;
    case "correct":
      playSample(samples.correct, level, { volume: 1.35, playbackRate: 1.2, stopAfterMs: 900 });
      break;
    case "incorrect":
      playSample(samples.incorrect, level, { volume: 1.35, stopAfterMs: 900 });
      break;
    case "complete":
      playSample(samples.complete, level, { volume: 1.0, stopAfterMs: 1800 });
      break;
  }
}

