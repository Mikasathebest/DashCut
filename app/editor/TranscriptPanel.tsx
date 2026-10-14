"use client";

import { KeyboardEvent, memo, useEffect, useMemo, useState } from "react";
import { Icon } from "./icons";
import type { CleanCutItem, TranscriptBlock, TranscriptWord } from "./transcript";

type TranscriptPanelProps = {
  blocks: TranscriptBlock[];
  time: number;
  flagged: CleanCutItem[];
  busy: boolean;
  canTranscribe: boolean;
  onSeek: (time: number) => void;
  onDelete: (words: TranscriptWord[]) => void;
  onTranscribe: () => void;
  onCleanCut: () => void;
};

const flagLabels: Record<CleanCutItem["kind"], string> = { filler: "语气词", pause: "停顿", stutter: "口吃", retake: "重复", silence: "静音" };

/** Editable transcript: select words (click, drag or shift-click) and delete them to cut the media underneath. */
export const TranscriptPanel = memo(function TranscriptPanel({ blocks, time, flagged, busy, canTranscribe, onSeek, onDelete, onTranscribe, onCleanCut }: TranscriptPanelProps) {
  const words = useMemo(() => blocks.flatMap((block) => block.words), [blocks]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const range = anchor === null || focus === null ? null : [Math.min(anchor, focus), Math.max(anchor, focus)] as const;
  const selected = range ? words.slice(range[0], range[1] + 1) : [];
  const current = words.findIndex((word) => time >= word.start && time < word.end);

  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    window.addEventListener("mouseup", stop, { once: true });
    return () => window.removeEventListener("mouseup", stop);
  }, [dragging]);

  function flagFor(word: TranscriptWord) {
    return flagged.find((item) => item.clipId === word.clipId && word.sourceStart < item.sourceEnd - 0.01 && word.sourceEnd > item.sourceStart + 0.01);
  }

  function remove() {
    if (!selected.length) return;
    onDelete(selected);
    setAnchor(null);
    setFocus(null);
  }

  function onKeyDown(event: KeyboardEvent) {
    if ((event.key === "Backspace" || event.key === "Delete") && selected.length) {
      event.preventDefault();
      event.stopPropagation();
      remove();
    }
    if (event.key === "Escape") {
      setAnchor(null);
      setFocus(null);
    }
  }

  // Group into paragraphs: a new paragraph at every recogniser sentence or clip boundary.
  const paragraphs: TranscriptWord[][] = [];
  words.forEach((word, index) => {
    const previous = words[index - 1];
    if (!previous || previous.clipId !== word.clipId || previous.sentence !== word.sentence) paragraphs.push([]);
    paragraphs.at(-1)!.push(word);
  });
  let flatIndex = -1;

  return <div className="transcript-panel" tabIndex={0} onKeyDown={onKeyDown}>
    <div className="transcript-actions">
      <button className="ghost-action" disabled={busy || !canTranscribe} onClick={onTranscribe}><Icon name="talk" size={13} />{words.length ? "重新识别文稿" : "识别文稿"}</button>
      <button className="primary" disabled={busy || !words.length} onClick={onCleanCut}><Icon name="rough" size={13} />智能精剪</button>
    </div>
    {selected.length > 0 && <div className="transcript-selection"><span>已选 {selected.length} 个词 · {(selected.at(-1)!.end - selected[0].start).toFixed(1)} 秒</span><button onClick={remove}><Icon name="trash" size={12} />删除并剪掉（⌫）</button></div>}
    {!words.length && <p className="empty-hint">{canTranscribe ? "点击「识别文稿」获得带时间戳的逐字稿。之后可以像编辑文档一样：选中文字并删除，对应的视频和字幕会一起剪掉。" : "先把含人声的视频或音频拖到时间轴。"}</p>}
    <div className="transcript-text" onMouseLeave={() => setDragging(false)}>
      {paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>
        <time onClick={() => onSeek(paragraph[0].start)}>{Math.floor(paragraph[0].start / 60)}:{String(Math.floor(paragraph[0].start % 60)).padStart(2, "0")}</time>
        {paragraph.map((word) => {
          flatIndex += 1;
          const index = flatIndex;
          const flag = flagFor(word);
          const inRange = range && index >= range[0] && index <= range[1];
          return <span key={`${word.clipId}-${word.index}`}
            className={`transcript-word${inRange ? " selected" : ""}${index === current ? " current" : ""}${flag ? ` flag-${flag.kind}` : ""}${word.prob < 0.5 ? " unsure" : ""}`}
            title={flag ? `${flagLabels[flag.kind]}：${flag.label}` : word.prob < 0.5 ? `识别置信度 ${Math.round(word.prob * 100)}%` : undefined}
            onMouseDown={(event) => {
              event.preventDefault();
              if (event.shiftKey && anchor !== null) return setFocus(index);
              setAnchor(index);
              setFocus(index);
              setDragging(true);
            }}
            onMouseEnter={() => { if (dragging) setFocus(index); }}
            onDoubleClick={() => onSeek(word.start)}>{word.text}</span>;
        })}
      </p>)}
    </div>
    {words.length > 0 && <p className="transcript-legend"><i className="flag-filler" />语气词 <i className="flag-stutter" />口吃 <i className="flag-retake" />重复 <i className="unsure" />低置信度 · 双击跳转</p>}
  </div>;
});
