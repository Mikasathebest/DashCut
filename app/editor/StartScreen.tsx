"use client";

import { DragEvent, useState } from "react";
import { Icon } from "./icons";
import { formatClock } from "./Timeline";
import { getLanguage, t } from "../i18n";

export type ProjectLibrary = { recent: ProjectSummary[]; found: ProjectSummary[] };

type Props = {
  library: ProjectLibrary | null;
  desktop: boolean;
  /** Set when the screen was opened over a project, so it can go back to it. */
  canResume: boolean;
  onNew: () => void;
  onOpen: (projectPath?: string) => void;
  onRemove: (projectPath: string) => void;
  onRefresh: () => void;
  onResume: () => void;
};

function when(value: string | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return t("今天 {time}", { time: date.toLocaleTimeString(getLanguage() === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" }) });
  if (days === 1) return t("昨天");
  if (days < 7) return t("{count} 天前", { count: days });
  return date.toLocaleDateString(getLanguage() === "zh" ? "zh-CN" : "en-US");
}

function folderOf(projectPath: string) {
  const parts = projectPath.split(/[\\/]/);
  return parts.slice(-2, -1)[0] ?? "";
}

function ProjectCard({ item, onOpen, onRemove }: { item: ProjectSummary; onOpen: () => void; onRemove?: () => void }) {
  const meta = item.missing ? t("文件已移动或删除") : [when(item.openedAt ?? item.modifiedAt), item.duration ? formatClock(item.duration, false) : t("空项目")].filter(Boolean).join(" · ");
  return <div className={`project-card${item.missing ? " missing" : ""}`}>
    <button className="project-card-open" disabled={item.missing} title={item.path} onClick={onOpen}>
      <span className={`project-thumb${item.ratio === "9:16" ? " portrait" : ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- inline data URLs from the project file */}
        {item.preview ? <img src={item.preview} alt="" draggable={false} /> : <Icon name="film" size={26} />}
        {item.ratio === "9:16" && <em>9:16</em>}
      </span>
      <strong>{item.title}</strong>
      <small>{meta}</small>
      <small className="project-folder">{folderOf(item.path)}</small>
    </button>
    {onRemove && <button className="project-card-remove" title={t("从最近项目中移除")} onClick={onRemove}><Icon name="close" size={12} /></button>}
  </div>;
}

/** Shown on launch: create a project, reopen a recent one or open a .dashcut file found on disk. */
export function StartScreen({ library, desktop, canResume, onNew, onOpen, onRemove, onRefresh, onResume }: Props) {
  const [dragging, setDragging] = useState(false);
  const recent = library?.recent ?? [];
  const found = library?.found ?? [];

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = [...event.dataTransfer.files].find((item) => item.name.toLowerCase().endsWith(".dashcut"));
    const target = file && window.dashCutDesktop?.getFilePath?.(file);
    if (target) onOpen(target);
  }

  return <div className={`start-screen${dragging ? " dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }} onDrop={drop}>
    <div className="start-inner">
      <header className="start-header">
        <div className="brand"><span className="brand-mark"><i></i><i></i></span><strong>DashCut <em>极剪</em></strong></div>
        {canResume && <button className="ghost-action" onClick={onResume}>{t("返回当前项目")}</button>}
      </header>

      <section className="start-hero">
        <button className="start-new" onClick={onNew}>
          <span className="start-new-icon"><Icon name="plus" size={30} /></span>
          <span><strong>{t("新建项目")}</strong><small>{t("从空白时间轴开始，导入视频、图片和音频")}</small></span>
          <kbd suppressHydrationWarning>{typeof navigator !== "undefined" && !/Mac/i.test(navigator.platform) ? "Ctrl+N" : "⌘N"}</kbd>
        </button>
        <button className="start-open" disabled={!desktop} onClick={() => onOpen()}>
          <Icon name="film" size={20} />
          <span><strong>{t("打开项目…")}</strong><small>{desktop ? t("选择或拖入 .dashcut 文件") : t("打开项目仅支持桌面版")}</small></span>
        </button>
      </section>

      <section className="start-section">
        <h2>{t("最近项目")}<span>{recent.length || ""}</span></h2>
        {recent.length
          ? <div className="project-grid">{recent.map((item) => <ProjectCard key={item.path} item={item} onOpen={() => onOpen(item.path)} onRemove={() => onRemove(item.path)} />)}</div>
          : <p className="start-empty">{library ? t("还没有打开过的项目。新建一个开始剪辑吧。") : t("正在读取…")}</p>}
      </section>

      {desktop && <section className="start-section">
        <h2>{t("可导入的项目")}<span>{found.length || ""}</span><button className="start-refresh" title={t("重新查找")} onClick={onRefresh}><Icon name="reset" size={12} /></button></h2>
        <p className="start-hint">{t("在影片、文稿、桌面、下载以及最近项目所在的文件夹中找到的 .dashcut 文件")}</p>
        {found.length
          ? <div className="project-grid">{found.map((item) => <ProjectCard key={item.path} item={item} onOpen={() => onOpen(item.path)} />)}</div>
          : <p className="start-empty">{library ? t("没有找到其他 .dashcut 项目。") : t("正在查找…")}</p>}
      </section>}
    </div>
    {dragging && <div className="start-drop">{t("松开以打开项目")}</div>}
  </div>;
}
