const { verifyWindowsAudioAddon } = require('./windows-audio-addon-guard');

const fs = require('fs');
const path = require('path');

// Release builds set KNOT_REQUIRE_NVIDIA_VAAPI so a Linux package can never
// ship without the bundled driver (scripts/build-nvidia-vaapi.sh). Local
// builds without it still work; NVIDIA users then fall back to a system driver.
function verifyBundledNvidiaVaapi(projectDir) {
  if (process.env.KNOT_REQUIRE_NVIDIA_VAAPI !== '1') return;
  const driver = path.join(projectDir, 'vendor', 'nvidia-vaapi', 'nvidia_drv_video.so');
  let size = 0;
  try { size = fs.statSync(driver).size; } catch {}
  if (size < 16 * 1024) throw new Error(`Bundled NVIDIA VA-API driver missing at ${driver}; run scripts/build-nvidia-vaapi.sh`);
}

module.exports = async context => {
  if (context.electronPlatformName === 'win32') verifyWindowsAudioAddon(context.packager.projectDir);
  if (context.electronPlatformName === 'linux') verifyBundledNvidiaVaapi(context.packager.projectDir);
};
