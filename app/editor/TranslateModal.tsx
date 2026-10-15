"use client";

import { useEffect, useState } from "react";
import { t } from "../i18n";

export type Voice = { id: string; name: string; language: string };
export type TranslateOriginal = "background" | "duck" | "mute";
export type TranslateRequest = { language: "zh" | "en"; voice: string; original: TranslateOriginal };

type TranslateModalProps = {
  running: boolean;
  stage: string;
  captionCount: number;
  separationAvailable: boolean;
  onRun: (request: TranslateRequest) => void;
  onCaptions: () => void;
  onClose: () => void;
};

const originalLabels: Array<[TranslateOriginal, string, string]> = [
  ["background", "保留背景音", "分离出背景音乐和环境声，去掉原来的人声"],
  ["duck", "压低原声", "原声降到 15%，配音盖在上面"],
  ["mute", "静音原声", "只保留配音"],
];

/** Video translation: captions → target-language text → system TTS dub aligned to each caption. */
export function TranslateModal({ running, stage, captionCount, separationAvailable, onRun, onCaptions, onClose }: TranslateModalProps) {
  const [language, setLanguage] = useState<"zh" | "en">("en");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voice, setVoice] = useState("");
  const [original, setOriginal] = useState<TranslateOriginal>(separationAvailable ? "background" : "duck");
  useEffect(() => { void window.dashCutDesktop?.dubVoices().then(setVoices).catch(() => setVoices([])); }, []);
  const matching = voices.filter((item) => item.language.toLowerCase().startsWith(language));

  return <div className="modal-backdrop" onMouseDown={() => !running && onClose()}><section className="cleancut-modal translate-modal" onMouseDown={(event) => event.stopPropagation()}>
    <header><div><span className="eyebrow">VIDEO TRANSLATION</span><h2>{t("视频翻译")}</h2><small>{t("按字幕时间把译文配成语音，配音放在新的音频轨上")}</small></div><button onClick={onClose} disabled={running}>×</button></header>
    <div className="cleancut-body translate-body">
      {!captionCount && <p className="empty-hint">{t("需要先有字幕：配音会按每条字幕的时间对齐。")} <button className="ghost-action" onClick={onCaptions} disabled={running}>{t("识别字幕")}</button></p>}
      <label className="text-row">{t("翻译成")}<div className="segmented"><button className={language === "en" ? "active" : ""} onClick={() => { setLanguage("en"); setVoice(""); }}>English</button><button className={language === "zh" ? "active" : ""} onClick={() => { setLanguage("zh"); setVoice(""); }}>{t("中文")}</button></div></label>
      <label className="text-row">{t("配音声音")}<select value={voice} onChange={(event) => setVoice(event.target.value)}><option value="">{t("自动选择")}</option>{matching.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="translate-original">{originalLabels.map(([mode, label, note]) => <button key={mode} disabled={mode === "background" && !separationAvailable} className={original === mode ? "active" : ""} onClick={() => setOriginal(mode)}><b>{t(label)}</b><small>{t(note)}</small></button>)}</div>
      <p className="inspector-note">{t("缺少目标语言的字幕会先用 AI 翻译（需要 API 设置）；配音使用系统自带语音，在本机生成。说得太长的句子会自动加快，最多 1.6 倍。")}</p>
      {running && <p className="health-running"><i />{stage || t("正在准备")}</p>}
    </div>
    <footer><span>{t("可以撤销")}</span><div><button className="ghost-action" onClick={onClose} disabled={running}>{t("取消")}</button><button className="primary" disabled={running || !captionCount} onClick={() => onRun({ language, voice, original })}>{t("开始翻译")}</button></div></footer>
  </section></div>;
}
