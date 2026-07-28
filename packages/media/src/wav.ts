/**
 * Writing a WAV file by hand.
 *
 * The music library is synthesised rather than downloaded, so something has to
 * turn float samples into bytes ffmpeg will read. A RIFF header is 44 bytes of
 * well-documented arithmetic; a dependency for it would be a dependency to
 * audit, update and explain, and this is the smaller thing to own.
 *
 * 16-bit PCM, because the encoder that runs next is lossy anyway and a 24-bit
 * intermediate would only make the file bigger on its way to being AAC.
 */

export type WavOptions = {
  sampleRate?: number;
  /** Interleaved channel count. Two buffers in means stereo. */
  channels?: number;
};

/** Clamp a float sample into 16-bit range without wrapping round to silence. */
export function toInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  // 32767 rather than 32768 so +1.0 is representable and does not wrap to -1.
  return Math.round(clamped * 32767);
}

/**
 * Interleave channels and wrap them in a RIFF/WAVE header.
 *
 * Takes one Float32Array per channel; every channel must be the same length,
 * which is a fact the synthesiser controls and a mistake worth failing on
 * loudly rather than producing a file with a stuttering right speaker.
 */
export function encodeWav(channels: readonly Float32Array[], options: WavOptions = {}): Buffer {
  const channelCount = options.channels ?? channels.length;
  const sampleRate = options.sampleRate ?? 44_100;
  if (channels.length === 0) throw new RangeError('encodeWav needs at least one channel');
  const frames = channels[0]?.length ?? 0;
  for (const channel of channels) {
    if (channel.length !== frames) throw new RangeError('channels must be the same length');
  }

  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'latin1');
  buffer.write('fmt ', 12, 'latin1');
  buffer.writeUInt32LE(16, 16); // PCM header length
  buffer.writeUInt16LE(1, 20); // format: linear PCM
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(8 * bytesPerSample, 34);
  buffer.write('data', 36, 'latin1');
  buffer.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const source = channels[Math.min(channel, channels.length - 1)] as Float32Array;
      buffer.writeInt16LE(toInt16(source[frame] as number), offset);
      offset += bytesPerSample;
    }
  }

  return buffer;
}
