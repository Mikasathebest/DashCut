export {};

declare global {
  type AiConfig = { baseUrl: string; apiKey: string; model: string };
  type AiModel = { id: string; mode: string };
  type TimedSubtitle = { id: number; start: number; end: number; zh: string; en: string };
  type AgentProviderConfig = { kind: "openai" | "anthropic"; baseUrl: string; model: string; hasKey: { openai: boolean; anthropic: boolean }; persistentKeys: boolean };
  type AgentEvent = { runId: string } & (
    | { type: "start" | "end" | "stopped" }
    | { type: "assistant" | "done"; text: string }
    | { type: "tool-call"; id: string; name: string; arguments: Record<string, unknown> }
    | { type: "tool-result"; id: string; name: string; result: unknown }
    | { type: "error"; message: string }
  );
  type HardwareTier = "unsupported" | "minimum" | "recommended";

  /*
   * Multi-track composition contract shared by the editor preview and the FFmpeg exporter.
   * All times are seconds. A clip occupies [start, start + (out - in) / speed) on the timeline.
   * Visual layers are composited onto a black canvas in array order (first = bottom).
   */
  type AnimationType = "none" | "fade" | "slide-left" | "slide-right" | "slide-up" | "slide-down" | "zoom-in" | "zoom-out" | "wipe-left" | "wipe-right";
  type KeyframeEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "hold";
  /** Points are in seconds from the clip's timeline start; the easing of a point shapes the segment that follows it. */
  type KeyframePoint = { time: number; value: number; easing: KeyframeEasing };
  type VisualKeyframes = Partial<Record<"x" | "y" | "scale" | "rotation" | "opacity", KeyframePoint[]>>;
  type VisualEffect = "bw" | "vintage" | "vignette" | "sharpen" | "denoise" | "beauty" | "blur" | "chroma-key";
  type AudioEffect = "denoise" | "voice-enhance" | "loudnorm";
  interface ClipAudioSettings {
    volume: number; // 0..2, 1 = unchanged
    fadeIn: number; // seconds
    fadeOut: number; // seconds
    muted: boolean;
    effects: AudioEffect[];
    /** When present, replaces `volume` over time; fades still apply on top. */
    volumeKeyframes?: KeyframePoint[];
  }
  interface CompositionVisual {
    path: string;
    /** "rgba": a single raw RGBA frame (titles/text rendered by the editor), alpha preserved. */
    kind: "video" | "image" | "gif" | "rgba";
    rgba?: { width: number; height: number };
    start: number;
    in: number; // source seconds; for images/GIFs the display range (GIFs loop from in)
    out: number;
    speed: number; // 0.1..10; images ignore it
    reverse: boolean;
    freezeAt: number | null; // video only: hold the source frame at this time for the whole clip
    mirror: boolean; // horizontal flip, applied after crop
    rotate90: 0 | 90 | 180 | 270; // clockwise, applied after mirror
    crop: { x: number; y: number; w: number; h: number }; // normalized source rect, applied first
    // The cropped/rotated frame is fit (contain) into the canvas, then scaled by `scale`,
    // rotated `rotation` degrees clockwise about its centre, and centred at
    // (W/2 + x*W, H/2 + y*H). Opacity 0..1.
    transform: { x: number; y: number; scale: number; rotation: number; opacity: number };
    /** Keyframed properties replace the matching static transform value; animations still apply on top. */
    keyframes?: VisualKeyframes;
    // brightness -1..1 (0), contrast 0..2 (1), saturation 0..3 (1), temperature -1..1 (0, warm > 0).
    adjust: { brightness: number; contrast: number; saturation: number; temperature: number };
    effects: VisualEffect[];
    chromaKey: { color: string; similarity: number }; // used when effects includes "chroma-key"
    // In-animation runs over the first `duration` s, out-animation over the last `duration` s.
    // p goes 0→1 (in) or 1→0 (out), linear. fade: opacity *= p. slide-*: offset by (1-p) canvas
    // widths/heights from that side (slide-left enters from the left). zoom-in: scale *= 0.5+0.5p.
    // zoom-out: scale *= 1.5-0.5p. wipe-right: only the left p fraction of the layer box is visible
    // (reveals left→right); wipe-left: only the right p fraction is visible (reveals right→left).
    animationIn: { type: AnimationType; duration: number };
    animationOut: { type: AnimationType; duration: number };
    hasAudio: boolean;
    audio: ClipAudioSettings;
  }
  interface CompositionAudio {
    path: string;
    start: number;
    in: number;
    out: number;
    speed: number;
    audio: ClipAudioSettings;
  }
  interface CompositionRequest {
    width: number;
    height: number;
    fps: 30 | 60;
    platform: "bilibili" | "youtube";
    duration: number;
    visuals: CompositionVisual[];
    audios: CompositionAudio[];
    subtitles: Array<{ start: number; end: number; zh: string; en: string }>;
    subtitleStyle: Record<string, string | number>;
    subtitleMode: "zh" | "en" | "both";
  }

  interface HardwareProfile {
    platform: string;
    arch: string;
    cpu: { model: string; logicalCores: number };
    memory: { totalGb: number; freeGb: number };
    diskFreeGb: number;
    gpus: Array<{
      name: string;
      vendor: string;
      memoryGb: number | null;
      driver: string;
      fasterWhisperAcceleration: boolean;
    }>;
    runtime: null | {
      kind: "bundled" | "development" | "missing";
      ready: boolean;
      info: null | { python: string; fasterWhisper: string; ctranslate2: string; cudaDeviceCount: number };
      error?: string;
    };
    assessment: {
      tier: HardwareTier;
      model: string;
      computeType: string;
      blockers: string[];
      notes: string[];
    };
  }

  interface Window {
    dashCutDesktop?: {
      platform: string;
      version: string;
      getFilePath(file: File): string;
      listAiModels(config: AiConfig): Promise<AiModel[]>;
      translateSubtitles(request: { config: AiConfig; subtitles: TimedSubtitle[] }): Promise<TimedSubtitle[]>;
      transcribeCloud(request: { config: AiConfig; clips: Array<{ id: number; path: string }> }): Promise<{
        model: string;
        timing: "estimated";
        failedChunks: number;
        totalChunks: number;
        results: Array<{ clipId: number; language: string; segments: Array<{ start: number; end: number; text: string; zh: string; en: string }> }>;
      }>;
      getHardwareProfile(): Promise<HardwareProfile>;
      getLocalModels(): Promise<LocalModelInfo[]>;
      installLocalModel(model: string): Promise<{ model: string; sizeBytes?: number; alreadyInstalled?: boolean }>;
      removeLocalModel(model: string): Promise<{ model: string; removed: boolean }>;
      exportVideo(request: {
        segments: Array<{ path: string; kind: "video" | "image" | "gif"; sourceStart: number; sourceEnd: number }>;
        subtitles: Array<{ start: number; end: number; zh: string; en: string }>;
        subtitleStyle: Record<string, string | number>;
        musicPath: string;
        musicVolume: number;
        fps: 30 | 60;
        resolution: 720 | 1080 | 2160;
        platform: "bilibili" | "youtube";
      }): Promise<{ canceled?: boolean; outputPath?: string; duration?: number; subtitleFiles?: string[] }>;
      revealExport(target: string): Promise<void>;
      exportComposition(request: CompositionRequest): Promise<{ canceled?: boolean; outputPath?: string; duration?: number; subtitleFiles?: string[] }>;
      extractWaveform(source: string): Promise<{ duration: number; peaksPerSecond: number; peaks: number[] }>;
      detectScenes(source: string, range: { in: number; out: number }): Promise<number[]>;
      detectSpeechSegments(source: string, range: { in: number; out: number }): Promise<{ speech: Array<{ start: number; end: number }>; silences: Array<{ start: number; end: number }> }>;
      saveRecording(bytes: ArrayBuffer): Promise<string>;
      requestMicrophone(): Promise<boolean>;
      registerMedia(paths: string[]): Promise<string[]>;
      saveProject(request: { document: unknown; projectPath: string; saveAs: boolean }): Promise<{ canceled?: boolean; projectPath?: string }>;
      openProject(projectPath?: string): Promise<{ canceled?: boolean; projectPath?: string; document?: unknown; missing?: string[] }>;
      recentProjects(): Promise<Array<{ path: string; title: string; openedAt: string; exists: boolean }>>;
      removeRecentProject(projectPath: string): Promise<unknown>;
      autosaveProject(request: { document: unknown; projectPath: string }): Promise<void>;
      recoveryList(): Promise<Array<{ id: string; title: string; savedAt: string; projectPath: string }>>;
      readRecovery(id: string): Promise<{ document: unknown; projectPath: string; missing: string[] }>;
      discardRecovery(id: string): Promise<void>;
      locateMedia(request: { name: string; otherNames: string[] }): Promise<{ canceled?: boolean; path?: string; siblings?: Record<string, string> }>;
      setProjectState(state: { dirty: boolean; id: string }): Promise<void>;
      closeReady(): Promise<void>;
      agentConfig(): Promise<AgentProviderConfig>;
      saveAgentConfig(config: { kind: "openai" | "anthropic"; baseUrl: string; model: string; apiKey?: string }): Promise<AgentProviderConfig>;
      clearAgentKey(kind: "openai" | "anthropic"): Promise<void>;
      agentSend(request: { message: string; system: string; tools: Array<{ name: string; description: string; parameters: unknown }> }): Promise<{ runId: string }>;
      agentStop(): Promise<void>;
      agentReset(): Promise<void>;
      agentToolResponse(response: { requestId: string; result?: unknown; error?: string }): Promise<void>;
      onAgentEvent(callback: (event: AgentEvent) => void): () => void;
      onAgentToolRequest(callback: (request: { requestId: string; name: string; args: Record<string, unknown> }) => void): () => void;
      onMenuCommand(callback: (command: string) => void): () => void;
      onExportProgress(callback: (progress: { progress: number; stage: string }) => void): () => void;
      onCaptionProgress(callback: (progress: { progress: number; stage: string }) => void): () => void;
      transcribeLocal(request: {
        clips: Array<{ id: number; path: string }>;
        model: string;
        device: "cpu" | "cuda";
        computeType: string;
        hotwords?: string;
        verbatim?: boolean;
      }): Promise<{
        model: string;
        device: string;
        computeType: string;
        results: Array<{
          clipId: number;
          language: string;
          languageProbability: number;
          segments: Array<{ start: number; end: number; text: string; words?: Array<{ start: number; end: number; word: string }> }>;
        }>;
      }>;
    };
  }

  interface LocalModelInfo {
    id: "small" | "medium" | "turbo" | "large-v3";
    label: string;
    approximateGb: number;
    quality: string;
    description: string;
    installed: boolean;
    sizeBytes: number;
  }
}
