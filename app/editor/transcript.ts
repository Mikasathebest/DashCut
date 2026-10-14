// Transcript view of the timeline and "clean cut" analysis (fillers, pauses, repeated takes). Pure.
import { clipEnd, sourceRangeToTimeline, trackClips } from "./model.ts";
import type { Clip, Project, TimedWord } from "./model.ts";
export type { TimedWord };

export type TranscriptWord = TimedWord & { clipId: string; index: number; sourceStart: number; sourceEnd: number; sentence: number };
export type TranscriptBlock = { clipId: string; assetId: string; start: number; end: number; words: TranscriptWord[] };

export type CleanCutKind = "filler" | "pause" | "stutter" | "retake" | "silence";
export type CleanCutItem = { id: string; kind: CleanCutKind; label: string; clipId: string; sourceStart: number; sourceEnd: number; start: number; end: number; accepted: boolean };
export type CleanCutSettings = {
  strongFillers: string[]; // removed by default
  weakFillers: string[]; // flagged for review but kept by default
  pauseThreshold: number; // seconds of silence between words worth cutting
  keepPause: number; // seconds left on each side of a cut pause
  retakeSimilarity: number; // 0..1, adjacent sentences at least this similar count as a retake
  kinds: Record<Exclude<CleanCutKind, "silence">, boolean>;
};

export const defaultCleanCutSettings: CleanCutSettings = {
  strongFillers: ["嗯", "啊", "呃", "额", "唔", "um", "uh", "erm", "hmm", "uhm"],
  weakFillers: ["那个", "就是", "然后", "这个", "就是说", "like", "you know", "i mean", "so", "basically", "actually"],
  pauseThreshold: 0.8,
  keepPause: 0.15,
  retakeSimilarity: 0.6,
  kinds: { filler: true, pause: true, stutter: true, retake: true },
};

const punctuation = /[\s\p{P}\p{S}]+/gu;
export function normalizeToken(text: string) {
  return text.toLowerCase().replace(punctuation, "");
}

/** Words of every transcribed clip, mapped to timeline time and ordered as they play. */
export function timelineTranscript(project: Project): TranscriptBlock[] {
  const transcripts = project.transcripts ?? {};
  const blocks: TranscriptBlock[] = [];
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of trackClips(project, track.id)) {
      const transcript = transcripts[clip.assetId];
      if (!transcript || clip.audio.muted) continue;
      const words: TranscriptWord[] = [];
      transcript.words.forEach((word, index) => {
        const middle = (word.start + word.end) / 2;
        if (middle < clip.in || middle >= clip.out) return;
        const range = sourceRangeToTimeline(clip, word.start, word.end);
        if (!range) return;
        const sentence = transcript.sentences.findIndex((item) => middle >= item.start && middle < item.end);
        words.push({ ...word, start: range.start, end: range.end, clipId: clip.id, index, sourceStart: range.sourceStart, sourceEnd: range.sourceEnd, sentence });
      });
      if (words.length) blocks.push({ clipId: clip.id, assetId: clip.assetId, start: clip.start, end: clipEnd(clip), words });
    }
  }
  return blocks.sort((a, b) => a.start - b.start);
}

function item(kind: CleanCutKind, label: string, clip: Clip, sourceStart: number, sourceEnd: number, accepted: boolean): CleanCutItem | null {
  const range = sourceRangeToTimeline(clip, sourceStart, sourceEnd);
  if (!range || range.end - range.start < 0.04) return null;
  return { id: `${kind}-${clip.id}-${sourceStart.toFixed(3)}`, kind, label, clipId: clip.id, sourceStart: range.sourceStart, sourceEnd: range.sourceEnd, start: range.start, end: range.end, accepted };
}

/** Finds token runs equal to a phrase; CJK phrases may span several recogniser tokens. */
function findPhrase(tokens: string[], phrase: string) {
  const target = phrase.toLowerCase().split(/\s+/).map(normalizeToken).filter(Boolean);
  const joined = target.join("");
  const hits: Array<[number, number]> = [];
  if (!joined) return hits;
  for (let start = 0; start < tokens.length; start += 1) {
    let text = "";
    for (let end = start; end < tokens.length && text.length < joined.length; end += 1) {
      text += tokens[end];
      if (text === joined) hits.push([start, end]);
    }
  }
  return hits;
}

/** Bigram Dice similarity of two normalized sentences. */
export function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (text: string) => {
    const counts = new Map<string, number>();
    for (let index = 0; index < text.length - 1; index += 1) counts.set(text.slice(index, index + 2), (counts.get(text.slice(index, index + 2)) ?? 0) + 1);
    return counts;
  };
  const left = grams(a);
  const right = grams(b);
  let shared = 0;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  const total = Math.max(1, a.length - 1 + b.length - 1);
  return (2 * shared) / total;
}

export function analyzeCleanCut(project: Project, settings: CleanCutSettings, clipIds?: string[]): CleanCutItem[] {
  const items: CleanCutItem[] = [];
  const transcripts = project.transcripts ?? {};
  for (const clip of project.clips) {
    if (clipIds && !clipIds.includes(clip.id)) continue;
    const transcript = transcripts[clip.assetId];
    if (!transcript || clip.reverse || clip.freezeAt !== null) continue;
    const words = transcript.words.filter((word) => {
      const middle = (word.start + word.end) / 2;
      return middle >= clip.in && middle < clip.out;
    });
    if (!words.length) continue;
    const tokens = words.map((word) => normalizeToken(word.text));
    const push = (value: CleanCutItem | null) => { if (value) items.push(value); };

    if (settings.kinds.filler) {
      const taken = new Set<number>();
      const scan = (phrases: string[], accepted: boolean) => {
        for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
          for (const [from, to] of findPhrase(tokens, phrase)) {
            if (Array.from({ length: to - from + 1 }, (_, offset) => from + offset).some((index) => taken.has(index))) continue;
            for (let index = from; index <= to; index += 1) taken.add(index);
            push(item("filler", words.slice(from, to + 1).map((word) => word.text).join("").trim(), clip, words[from].start, words[to].end, accepted));
          }
        }
      };
      scan(settings.strongFillers, true);
      // Tokens made only of hesitation sounds ("嗯嗯", "啊啊") count as strong fillers too.
      const sounds = new Set(settings.strongFillers.filter((filler) => [...normalizeToken(filler)].length === 1).map(normalizeToken));
      tokens.forEach((token, index) => {
        if (!taken.has(index) && token && [...token].every((char) => sounds.has(char))) {
          taken.add(index);
          push(item("filler", words[index].text.trim(), clip, words[index].start, words[index].end, true));
        }
      });
      scan(settings.weakFillers, false);
    }

    if (settings.kinds.stutter) {
      for (let index = 1; index < tokens.length; index += 1) {
        if (!tokens[index] || tokens[index] !== tokens[index - 1] || tokens[index] === tokens[index + 1]) continue;
        // Walk back over the whole run of repeats and keep only the last one.
        let first = index - 1;
        while (first > 0 && tokens[first - 1] === tokens[index]) first -= 1;
        const run = index - first + 1;
        // Doubled single Chinese characters are usually grammatical (看看, 聊聊, 试试); flag only 3+.
        if (/^\p{Script=Han}$/u.test(tokens[index]) && run < 3) continue;
        push(item("stutter", Array.from({ length: run }, () => words[index].text.trim()).join("…"), clip, words[first].start, words[index].start, true));
      }
    }

    if (settings.kinds.pause) {
      const gaps: Array<[number, number]> = [[clip.in, words[0].start], ...words.slice(1).map((word, index): [number, number] => [words[index].end, word.start]), [words.at(-1)!.end, clip.out]];
      for (const [from, to] of gaps) {
        if (to - from >= settings.pauseThreshold) push(item("pause", `停顿 ${(to - from).toFixed(1)} 秒`, clip, from + settings.keepPause, to - settings.keepPause, true));
      }
    }

    if (settings.kinds.retake) {
      const sentences = transcript.sentences.filter((sentence) => sentence.end > clip.in && sentence.start < clip.out);
      const text = (sentence: { start: number; end: number }) => words.filter((word) => (word.start + word.end) / 2 >= sentence.start && (word.start + word.end) / 2 < sentence.end).map((word) => normalizeToken(word.text)).join("");
      for (let index = 0; index < sentences.length - 1; index += 1) {
        const current = text(sentences[index]);
        const following = text(sentences[index + 1]);
        if (current.length < 3) continue;
        // An abandoned take is usually a near-duplicate or a truncated start of the next sentence.
        const isRetake = similarity(current, following) >= settings.retakeSimilarity || (following.startsWith(current) && current.length >= 4);
        if (isRetake) push(item("retake", `重复的句子：${current.slice(0, 18)}`, clip, Math.max(clip.in, sentences[index].start), Math.min(clip.out, sentences[index + 1].start), true));
      }
    }
  }
  return items.sort((a, b) => a.start - b.start);
}

/** Converts silence ranges from FFmpeg (source seconds) into review items for clips without a transcript. */
export function silenceItems(clip: Clip, silences: Array<{ start: number; end: number }>, keep: number): CleanCutItem[] {
  return silences.flatMap((silence) => {
    const value = item("silence", `静音 ${(silence.end - silence.start).toFixed(1)} 秒`, clip, silence.start + keep, silence.end - keep, true);
    return value ? [value] : [];
  });
}

/** Source ranges covering selected transcript words, merged when the words touch. */
export function wordsToCuts(words: TranscriptWord[]) {
  const sorted = [...words].sort((a, b) => a.clipId.localeCompare(b.clipId) || a.sourceStart - b.sourceStart);
  const cuts: Array<{ clipId: string; start: number; end: number }> = [];
  for (const word of sorted) {
    const last = cuts.at(-1);
    if (last && last.clipId === word.clipId && word.sourceStart - last.end < 0.35) last.end = Math.max(last.end, word.sourceEnd);
    else cuts.push({ clipId: word.clipId, start: word.sourceStart, end: word.sourceEnd });
  }
  return cuts;
}

/** Sentence spans from word punctuation and pauses; recogniser segments can merge several sentences. */
export function deriveSentences(words: TimedWord[], gap = 0.6) {
  const sentences: Array<{ start: number; end: number }> = [];
  let start: number | null = null;
  words.forEach((word, index) => {
    if (start === null) start = word.start;
    const next = words[index + 1];
    const ends = /[。！？!?.…]\s*$/u.test(word.text) || !next || next.start - word.end > gap;
    if (ends) {
      // Extend to just before the next word so midpoints never fall between sentences.
      sentences.push({ start, end: next ? Math.max(word.end, next.start - 0.001) : word.end + 0.001 });
      start = null;
    }
  });
  return sentences;
}
