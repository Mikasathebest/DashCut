// Main-process strings (menus, native dialogs) follow the language chosen in the editor.
const english = {
  "DashCut 项目": "DashCut project",
  "导出视频": "Export video",
  "导出": "Export",
  "MP4 视频": "MP4 video",
  "QuickTime 视频": "QuickTime movie",
  "M4A 音频": "M4A audio",
  "WAV 音频": "WAV audio",
  "GIF 动图": "GIF animation",
  "项目另存为": "Save project as",
  "保存项目": "Save project",
  "打开项目": "Open project",
  "未命名项目": "Untitled project",
  "文件": "File",
  "新建项目": "New Project",
  "打开项目…": "Open Project…",
  "保存": "Save",
  "另存为…": "Save As…",
  "导入素材…": "Import Media…",
  "导出视频…": "Export…",
  "极剪助手": "DashCut Assistant",
  "编辑": "Edit",
  "撤销": "Undo",
  "重做": "Redo",
  "剪切": "Cut",
  "复制": "Copy",
  "粘贴": "Paste",
  "复制并粘贴": "Duplicate",
  "全选": "Select All",
  "正在合成配音…": "Synthesizing the dub…",
  "下载声音分离模型": "Downloading the separation model",
  "声音分离": "Separating voice and background",
  "不保存": "Don't Save",
  "取消": "Cancel",
  "项目有未保存的修改": "The project has unsaved changes",
  "关闭前要保存当前项目吗？": "Save the current project before closing?",
  "重新定位「{name}」": "Locate “{name}”",
  "人脸检测模型下载不完整": "The face detection model download was incomplete",
  "人脸检测模型下载失败（HTTP {status}）": "Face detection model download failed (HTTP {status})",
};

let language = "zh";

function setLanguage(next) {
  language = next === "en" ? "en" : "zh";
}

function tr(source, values) {
  const text = language === "en" ? english[source] ?? source : source;
  return values ? text.replace(/\{(\w+)\}/g, (match, key) => key in values ? String(values[key]) : match) : text;
}

module.exports = { setLanguage, tr };
