/**
 * `music-tempo` ships no types. Only the two members this product uses are
 * declared, deliberately: an over-complete guess at somebody else's API is a
 * lie the compiler will believe.
 */
declare module 'music-tempo' {
  export type MusicTempoParams = {
    bufferSize?: number;
    hopSize?: number;
    timeStep?: number;
    minBeatInterval?: number;
    maxBeatInterval?: number;
    [key: string]: number | undefined;
  };

  export default class MusicTempo {
    constructor(audioData: Float32Array | number[], params?: MusicTempoParams);
    /** Beats per minute, as a fixed-precision string; "-1" when unknown. */
    readonly tempo: string;
    /** Beat times in seconds. */
    readonly beats: number[];
  }
}
