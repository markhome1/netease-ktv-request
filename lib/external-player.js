const { spawn } = require('child_process');

function interpolate(template, context) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(context[key] ?? ''));
}

function getLaunchTarget(song) {
  return song.audioUrl || song.neteaseResolved?.canonicalUrl || song.neteaseUrl || '';
}

function launchExternalPlayer(config, song) {
  const commandTemplate = String(config.command || '').trim();
  if (!commandTemplate) {
    throw new Error('未配置外部播放器命令');
  }

  const target = getLaunchTarget(song);
  if (!target) {
    throw new Error('当前歌曲没有可用的启动目标');
  }

  const context = {
    url: target,
    audioUrl: song.audioUrl || '',
    neteaseUrl: song.neteaseResolved?.canonicalUrl || song.neteaseUrl || '',
    title: song.title || '',
    artist: song.artist || '',
    requester: song.requester || ''
  };

  const finalCommand = interpolate(commandTemplate, context);
  const child = spawn(finalCommand, {
    shell: true,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  return {
    command: finalCommand,
    target
  };
}

module.exports = {
  interpolate,
  getLaunchTarget,
  launchExternalPlayer
};
