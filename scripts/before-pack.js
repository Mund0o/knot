const { verifyWindowsAudioAddon } = require('./windows-audio-addon-guard');

module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return;
  verifyWindowsAudioAddon(context.packager.projectDir);
};
