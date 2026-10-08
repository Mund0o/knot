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

// The same for the GPU decoder helper (scripts/build-nvdec-helper.sh): without it a viewer with an NVIDIA card silently decodes on the CPU.
function verifyBundledNvdecHelper(projectDir) {
  if (process.env.KNOT_REQUIRE_NVDEC_HELPER !== '1') return;
  const helper = path.join(projectDir, 'vendor', 'knot-nvdec', 'knot-nvdec');
  let size = 0;
  try { size = fs.statSync(helper).size; } catch {}
  if (size < 8 * 1024) throw new Error(`Bundled GPU decoder helper missing at ${helper}; run scripts/build-nvdec-helper.sh`);
}

module.exports = async context => {
  if (context.electronPlatformName === 'win32') verifyWindowsAudioAddon(context.packager.projectDir);
  if (context.electronPlatformName === 'linux') { verifyBundledNvidiaVaapi(context.packager.projectDir); verifyBundledNvdecHelper(context.packager.projectDir); }
};
