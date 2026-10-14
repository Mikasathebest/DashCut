// Copies browser runtimes that the editor loads at run time into public/vendor (not committed).
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "public", "vendor", "mediapipe");
const source = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
// SIMD build plus the fallback for CPUs without WebAssembly SIMD.
for (const file of ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"]) {
  await cp(path.join(source, file), path.join(target, file));
}
console.log(`MediaPipe vision runtime copied to ${path.relative(root, target)}`);
