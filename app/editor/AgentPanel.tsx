"use client";

import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { AgentSkill, toolLabels } from "./agent-tools";
import { t } from "../i18n";

export type AgentMessage =
  | { id: string; kind: "user" | "assistant" | "error" | "status"; text: string }
  | { id: string; kind: "tool"; name: string; status: "running" | "done" | "failed"; detail: string }
  | { id: string; kind: "plan"; summary: string; steps: string[]; decision: "pending" | "approved" | "rejected"; feedback?: string }
  | { id: string; kind: "edits"; changes: string[]; revision: number; undone: boolean };

type AgentPanelProps = {
  messages: AgentMessage[];
  running: boolean;
  config: AgentProviderConfig | null;
  skills: AgentSkill[];
  onSend: (text: string, skill?: AgentSkill) => void;
  onStop: () => void;
  onReset: () => void;
  onPlan: (id: string, approved: boolean, feedback: string) => void;
  onUndo: (id: string) => void;
  onSaveConfig: (config: { kind: "openai" | "anthropic"; baseUrl: string; model: string; apiKey: string }) => Promise<void>;
  onClose: () => void;
};

export function AgentPanel({ messages, running, config, skills, onSend, onStop, onReset, onPlan, onUndo, onSaveConfig, onClose }: AgentPanelProps) {
  const [input, setInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState({ kind: "anthropic" as "openai" | "anthropic", baseUrl: "", model: "", apiKey: "" });
  const [feedback, setFeedback] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const hasKey = config ? config.hasKey[config.kind] : false;

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  function openSettings() {
    if (config) setDraft({ kind: config.kind, baseUrl: config.baseUrl, model: config.model, apiKey: "" });
    setSettingsOpen(!settingsOpen);
  }

  function submit() {
    const text = input.trim();
    if (!text || running) return;
    onSend(text);
    setInput("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return <aside className="inspector agent-panel">
    <header className="agent-header">
      <div><b>{t("极剪助手")}</b><small>{config ? `${config.kind === "anthropic" ? "Claude" : t("OpenAI 兼容")} · ${config.model || t("默认模型")}` : t("未配置")}</small></div>
      <div>
        <button title={t("新对话")} onClick={onReset} disabled={running}><Icon name="reset" size={13} /></button>
        <button title={t("模型设置")} className={settingsOpen ? "active" : ""} onClick={openSettings}><Icon name="more" size={13} /></button>
        <button title={t("返回属性面板（⌘J）")} onClick={onClose}>×</button>
      </div>
    </header>
    {(settingsOpen || (config && !hasKey)) && <form className="agent-settings" onSubmit={(event) => { event.preventDefault(); void onSaveConfig(draft).then(() => { setSettingsOpen(false); setDraft((value) => ({ ...value, apiKey: "" })); }); }}>
      <label>{t("服务")}<select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as "openai" | "anthropic", model: event.target.value === "anthropic" ? "claude-opus-5-5" : "" })}><option value="anthropic">Claude（Anthropic API）</option><option value="openai">{t("OpenAI 兼容接口")}</option></select></label>
      <label>API Base URL<input value={draft.baseUrl} placeholder={draft.kind === "anthropic" ? "https://api.anthropic.com" : "https://…/v1"} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
      <label>{t("模型")}<input value={draft.model} placeholder={draft.kind === "anthropic" ? "claude-opus-5-5" : t("支持工具调用的模型")} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label>
      <label>API Key<input type="password" autoComplete="off" value={draft.apiKey} placeholder={config?.hasKey[draft.kind] ? t("已保存，留空则不修改") : t("输入密钥")} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /></label>
      <small>{config?.persistentKeys === false ? t("此系统无法加密存储，密钥仅保存在本次运行中。") : t("密钥经系统钥匙串加密后保存在本机，不会明文写入磁盘。")}</small>
      <button className="primary" type="submit">{t("保存设置")}</button>
    </form>}
    <div className="agent-messages" ref={listRef}>
      {!messages.length && <div className="agent-welcome">
        <p>{t("用一句话告诉我想怎么剪。我会先读取时间轴、给出方案，你确认后才会修改，⌘Z 可以一步撤销。")}</p>
        <div className="agent-skills">{skills.map((skill) => <button key={skill.id} disabled={running || !hasKey} onClick={() => onSend(t(skill.request), skill)}><b>{t(skill.title)}</b><small>{t(skill.description)}</small></button>)}</div>
      </div>}
      {messages.map((message) => {
        if (message.kind === "user") return <div key={message.id} className="agent-bubble user">{message.text}</div>;
        if (message.kind === "assistant") return <div key={message.id} className="agent-bubble">{message.text}</div>;
        if (message.kind === "error") return <div key={message.id} className="agent-note error">{message.text}</div>;
        if (message.kind === "status") return <div key={message.id} className="agent-note">{message.text}</div>;
        if (message.kind === "tool") return <div key={message.id} className={`agent-tool ${message.status}`}><i />{toolLabels[message.name] ? t(toolLabels[message.name]) : message.name}{message.detail && <small>{message.detail}</small>}</div>;
        if (message.kind === "plan") return <div key={message.id} className={`agent-plan ${message.decision}`}>
          <b>{t("方案")}</b><p>{message.summary}</p>
          <ol>{message.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
          {message.decision === "pending" ? <div className="agent-plan-actions">
            <input value={feedback} placeholder={t("修改意见（可选）")} onChange={(event) => setFeedback(event.target.value)} />
            <button className="ghost-action" onClick={() => { onPlan(message.id, false, feedback); setFeedback(""); }}>{t("修改方案")}</button>
            <button className="primary" onClick={() => { onPlan(message.id, true, ""); setFeedback(""); }}>{t("确认执行")}</button>
          </div> : <small>{message.decision === "approved" ? t("已确认") : message.feedback ? t("已要求修改：{feedback}", { feedback: message.feedback }) : t("已要求修改")}</small>}
        </div>;
        if (message.kind !== "edits") return null;
        return <div key={message.id} className={`agent-edits${message.undone ? " undone" : ""}`}>
          <b>{t("已应用 {count} 项修改", { count: message.changes.length })}</b>
          <ul>{message.changes.slice(0, 12).map((change, index) => <li key={index}>{change}</li>)}{message.changes.length > 12 && <li>{t("… 另外 {count} 项", { count: message.changes.length - 12 })}</li>}</ul>
          <button disabled={message.undone} onClick={() => onUndo(message.id)}><Icon name="undo" size={12} />{message.undone ? t("已撤销") : t("撤销这次修改")}</button>
        </div>;
      })}
      {running && <div className="agent-note running"><i />{t("正在思考…")}</div>}
    </div>
    <div className="agent-input">
      <textarea value={input} rows={2} placeholder={hasKey ? t("例如：把开头 10 秒的停顿剪掉，并把画面调亮一点") : t("先在右上角设置模型和 API Key")} disabled={!hasKey} onChange={(event) => setInput(event.target.value)} onKeyDown={onKeyDown} />
      {running ? <button className="agent-stop" onClick={onStop}><Icon name="pause" size={13} />{t("停止")}</button> : <button className="primary" disabled={!input.trim() || !hasKey} onClick={submit}>{t("发送")}</button>}
    </div>
  </aside>;
}
