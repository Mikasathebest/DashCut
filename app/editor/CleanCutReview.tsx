"use client";

import { useMemo, useState } from "react";
import { t } from "../i18n";
import type { CleanCutItem, CleanCutKind, CleanCutSettings } from "./transcript";

const kindLabels: Record<CleanCutKind, string> = { filler: "语气词", pause: "长停顿", stutter: "口吃重复", retake: "重复的句子", silence: "静音" };

type CleanCutReviewProps = {
  items: CleanCutItem[];
  settings: CleanCutSettings;
  scope: string;
  onSettings: (settings: CleanCutSettings) => void;
  onSeek: (time: number) => void;
  onApply: (items: CleanCutItem[]) => void;
  onClose: () => void;
};

/** Review list for clean cuts: nothing is removed until the user applies the checked items. */
export function CleanCutReview({ items, settings, scope, onSettings, onSeek, onApply, onClose }: CleanCutReviewProps) {
  // Per-item overrides survive re-analysis when settings change.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [showSettings, setShowSettings] = useState(false);
  const reviewed = useMemo(() => items.map((item) => ({ ...item, accepted: overrides[item.id] ?? item.accepted })), [items, overrides]);
  const accepted = reviewed.filter((item) => item.accepted);
  const saved = accepted.reduce((sum, item) => sum + item.end - item.start, 0);
  const groups = (Object.keys(kindLabels) as CleanCutKind[]).map((kind) => ({ kind, items: reviewed.filter((item) => item.kind === kind) })).filter((group) => group.items.length);

  function setGroup(kind: CleanCutKind, value: boolean) {
    setOverrides((current) => ({ ...current, ...Object.fromEntries(reviewed.filter((item) => item.kind === kind).map((item) => [item.id, value])) }));
  }

  return <div className="modal-backdrop" onMouseDown={onClose}><section className="cleancut-modal" onMouseDown={(event) => event.stopPropagation()}>
    <header><div><span className="eyebrow">CLEAN CUT</span><h2>{t("智能精剪审阅")}</h2><small>{scope}</small></div><button onClick={onClose}>×</button></header>
    <div className="cleancut-body">
      <button className="ghost-action settings-toggle" onClick={() => setShowSettings(!showSettings)}>{t("检测设置")} {showSettings ? "⌃" : "⌄"}</button>
      {showSettings && <div className="cleancut-settings">
        <div className="cleancut-kinds">{(Object.keys(settings.kinds) as Array<keyof CleanCutSettings["kinds"]>).map((kind) => <label key={kind}><input type="checkbox" checked={settings.kinds[kind]} onChange={(event) => onSettings({ ...settings, kinds: { ...settings.kinds, [kind]: event.target.checked } })} />{t(kindLabels[kind])}</label>)}</div>
        <label className="inspector-slider"><span>{t("停顿阈值")}</span><input type="range" min="0.3" max="3" step="0.1" value={settings.pauseThreshold} onChange={(event) => onSettings({ ...settings, pauseThreshold: Number(event.target.value) })} /><b>{settings.pauseThreshold.toFixed(1)}s</b><i /></label>
        <label className="inspector-slider"><span>{t("保留间隙")}</span><input type="range" min="0" max="0.5" step="0.05" value={settings.keepPause} onChange={(event) => onSettings({ ...settings, keepPause: Number(event.target.value) })} /><b>{settings.keepPause.toFixed(2)}s</b><i /></label>
        <label className="cleancut-list">{t("默认删除的语气词")}<input value={settings.strongFillers.join("，")} onChange={(event) => onSettings({ ...settings, strongFillers: event.target.value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean) })} /></label>
        <label className="cleancut-list">{t("需确认的口头禅")}<input value={settings.weakFillers.join("，")} onChange={(event) => onSettings({ ...settings, weakFillers: event.target.value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean) })} /></label>
      </div>}
      {!reviewed.length && <p className="empty-hint">{t("没有发现可以剪掉的内容。可以在检测设置里降低停顿阈值或增加语气词。")}</p>}
      <div className="cleancut-groups">{groups.map((group) => <section key={group.kind}>
        <h4><span>{t(kindLabels[group.kind])} · {group.items.length}</span><button onClick={() => setGroup(group.kind, true)}>{t("全选")}</button><button onClick={() => setGroup(group.kind, false)}>{t("全不选")}</button></h4>
        {group.items.map((item) => <label key={item.id} className={`cleancut-item${item.accepted ? "" : " kept"}`}>
          <input type="checkbox" checked={item.accepted} onChange={(event) => setOverrides((current) => ({ ...current, [item.id]: event.target.checked }))} />
          <button type="button" onClick={() => onSeek(Math.max(0, item.start - 0.5))}>{Math.floor(item.start / 60)}:{(item.start % 60).toFixed(1).padStart(4, "0")}</button>
          <span>{item.label}</span>
          <small>{(item.end - item.start).toFixed(2)}s</small>
        </label>)}
      </section>)}</div>
    </div>
    <footer><span>{t("将剪掉 {count} 处，共 {seconds} 秒；可用 ⌘Z 一步撤销", { count: accepted.length, seconds: saved.toFixed(1) })}</span><div><button className="ghost-action" onClick={onClose}>{t("取消")}</button><button className="primary" disabled={!accepted.length} onClick={() => onApply(accepted)}>{t("应用精剪")}</button></div></footer>
  </section></div>;
}
