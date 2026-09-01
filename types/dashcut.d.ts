export {};

declare global {
  type HardwareTier = "unsupported" | "minimum" | "recommended";

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
      getHardwareProfile(): Promise<HardwareProfile>;
      getLocalModels(): Promise<LocalModelInfo[]>;
      installLocalModel(model: string): Promise<{ model: string; sizeBytes?: number; alreadyInstalled?: boolean }>;
      removeLocalModel(model: string): Promise<{ model: string; removed: boolean }>;
      exportVideo(request: {
        segments: Array<{ path: string; sourceStart: number; sourceEnd: number }>;
        subtitles: Array<{ start: number; end: number; zh: string; en: string }>;
        subtitleStyle: Record<string, string | number>;
        musicPath: string;
        musicVolume: number;
        fps: 30 | 60;
        resolution: 720 | 1080 | 2160;
        platform: "bilibili" | "youtube";
      }): Promise<{ canceled?: boolean; outputPath?: string; duration?: number; subtitleFiles?: string[] }>;
      revealExport(target: string): Promise<void>;
      onExportProgress(callback: (progress: { progress: number; stage: string }) => void): () => void;
      transcribeLocal(request: {
        clips: Array<{ id: number; path: string }>;
        model: string;
        device: "cpu" | "cuda";
        computeType: string;
      }): Promise<{
        model: string;
        device: string;
        computeType: string;
        results: Array<{
          clipId: number;
          language: string;
          languageProbability: number;
          segments: Array<{ start: number; end: number; text: string }>;
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
