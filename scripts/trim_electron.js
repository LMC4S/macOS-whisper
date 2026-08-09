// electron-builder afterPack hook: drop SwiftShader (Chromium's software
// Vulkan fallback for WebGL) from the Electron Framework. Verse renders no
// WebGL, and on a real GPU Chromium never falls back to it, so it is dead
// weight (~16 MB installed). The framework is re-signed ad hoc afterwards so
// its code seal stays valid on arm64.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function trimElectron(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename;
  const framework = path.join(
    context.appOutDir,
    `${appName}.app`,
    "Contents",
    "Frameworks",
    "Electron Framework.framework"
  );
  const libraries = path.join(framework, "Versions", "A", "Libraries");
  let removed = false;
  for (const name of ["libvk_swiftshader.dylib", "vk_swiftshader_icd.json"]) {
    const target = path.join(libraries, name);
    if (fs.existsSync(target)) {
      fs.rmSync(target);
      removed = true;
    }
  }
  if (removed) {
    execFileSync("codesign", ["--force", "--sign", "-", framework]);
  }
};
