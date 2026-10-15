"use client";

import { HealthIssue, severityOrder } from "./health";
import { t } from "../i18n";

type HealthCheckProps = {
  running: boolean;
  stage: string;
  issues: HealthIssue[] | null;
  onRun: () => void;
  onFix: (issue: HealthIssue) => void;
  onSeek: (time: number) => void;
  onClose: () => void;
};

const severityLabels = { error: "需要处理", warning: "建议修改", info: "提示" } as const;

/** Pre-publish report: picture, sound, captions and media, each with a jump or a one-click fix. */
export function HealthCheck({ running, stage, issues, onRun, onFix, onSeek, onClose }: HealthCheckProps) {
  const sorted = issues ? [...issues].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || (a.time ?? 0) - (b.time ?? 0)) : [];
  const counts = { error: sorted.filter((issue) => issue.severity === "error").length, warning: sorted.filter((issue) => issue.severity === "warning").length };
  return <div className="modal-backdrop" onMouseDown={() => !running && onClose()}><section className="cleancut-modal health-modal" onMouseDown={(event) => event.stopPropagation()}>
    <header><div><span className="eyebrow">PRE-PUBLISH CHECK</span><h2>{t("发布前检查")}</h2><small>{t("检查响度、黑屏、长时间无声、字幕可读性和缺失素材")}</small></div><button onClick={onClose} disabled={running}>×</button></header>
    <div className="cleancut-body">
      {running ? <p className="health-running"><i />{stage || t("正在分析成片…")}</p>
        : !issues ? <p className="empty-hint">{t("会在本机完整渲染一遍（不写入文件）来测量响度并检测黑屏和静音，长视频需要一些时间。")}</p>
          : !sorted.length ? <p className="health-ok">✓ {t("没有发现问题，可以导出发布。")}</p>
            : <>
              <p className="health-summary">{counts.error ? t("{count} 项需要处理，", { count: counts.error }) : ""}{t("{warnings} 项建议修改，共 {total} 项", { warnings: counts.warning, total: sorted.length })}</p>
              {sorted.map((issue) => <div key={issue.id} className={`health-item ${issue.severity}`}>
                <span className="health-badge">{t(severityLabels[issue.severity])}</span>
                <div><b>{issue.title}</b><small>{issue.detail}</small></div>
                <div className="health-actions">
                  {issue.time !== undefined && <button onClick={() => onSeek(issue.time!)}>{t("跳转")}</button>}
                  {issue.fix && <button className="fix" onClick={() => onFix(issue)}>{issue.fix === "loudness" ? t("开启标准化") : issue.fix === "relink" ? t("重新定位") : t("编辑字幕")}</button>}
                </div>
              </div>)}
            </>}
    </div>
    <footer><span>{t("检查不会修改项目")}</span><div><button className="ghost-action" onClick={onClose} disabled={running}>{t("关闭")}</button><button className="primary" onClick={onRun} disabled={running}>{issues ? t("重新检查") : t("开始检查")}</button></div></footer>
  </section></div>;
}
