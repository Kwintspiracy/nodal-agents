// fake-audio.ts — un AudioContext factice pour les tests de la voix (#943).
//
// La page joue la voix sur UN AudioContext (`voice-playback.ts`), qu'elle garde
// d'un test à l'autre. Ce faux note donc tout dans un registre de MODULE,
// remis à zéro par `installFakeAudio()` : ce que la page a programmé, à quel
// instant, avec quels échantillons. Les tests lisent ce registre — ce qui
// aurait été entendu, et quand —, jamais un nombre d'appels.

export type Scheduled = {
  /** L'instant de départ demandé, en secondes du contexte. */
  at: number;
  duration: number;
  /** Les échantillons, arrondis au millième pour se lire. */
  samples: number[];
  stopped: boolean;
  /** Le morceau a fini de jouer (le test le décide). */
  finish: () => void;
};

const recorder = {
  scheduled: [] as Scheduled[],
  currentTime: 0,
};

type FakeBuffer = {
  duration: number;
  sampleRate: number;
  data: Float32Array;
  getChannelData: (c: number) => Float32Array;
};

function buffer(n: number, sampleRate: number): FakeBuffer {
  const data = new Float32Array(n);
  return { duration: n / sampleRate, sampleRate, data, getChannelData: () => data };
}

class FakeAudioContext {
  state = 'running';
  destination = {};
  get currentTime(): number {
    return recorder.currentTime;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  createBuffer(_channels: number, n: number, sampleRate: number): FakeBuffer {
    return buffer(n, sampleRate);
  }
  /**
   * Deux formats, comme un navigateur en lit : un WAV PCM 16 bits mono (la
   * fréquence à l'octet 24, les échantillons après 44), et un « MP3 » factice
   * qui, comme une vraie trame, ne se décode qu'ENTIER : `ID3`, un octet de
   * longueur L, puis L octets (un échantillon chacun, sur 8 kHz). Coupé, il
   * est refusé. Tout le reste est refusé aussi.
   */
  decodeAudioData(bytes: ArrayBuffer): Promise<FakeBuffer> {
    const view = new DataView(bytes);
    const u8 = new Uint8Array(bytes);
    if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
      const len = u8[3] ?? 0;
      if (bytes.byteLength !== 4 + len) return Promise.reject(new Error('truncated MP3 frame'));
      const b = buffer(len, 8000);
      for (let i = 0; i < len; i++) b.data[i] = u8[4 + i]! / 256;
      return Promise.resolve(b);
    }
    if (bytes.byteLength < 44 || view.getUint32(0, false) !== 0x52494646) {
      return Promise.reject(new Error('Unable to decode audio data'));
    }
    const rate = view.getUint32(24, true);
    const n = (bytes.byteLength - 44) / 2;
    const b = buffer(n, rate);
    for (let i = 0; i < n; i++) b.data[i] = view.getInt16(44 + i * 2, true) / 32768;
    return Promise.resolve(b);
  }
  createBufferSource() {
    const source = {
      buffer: null as FakeBuffer | null,
      onended: null as null | (() => void),
      connect: () => {},
      start: (at: number) => {
        const b = source.buffer!;
        const entry: Scheduled = {
          at,
          duration: b.duration,
          samples: [...b.data].map((v) => Math.round(v * 1000) / 1000),
          stopped: false,
          finish: () => source.onended?.(),
        };
        recorder.scheduled.push(entry);
        (source as { entry?: Scheduled }).entry = entry;
      },
      stop: () => {
        const entry = (source as { entry?: Scheduled }).entry;
        if (entry) entry.stopped = true;
        source.onended?.();
      },
    };
    return source;
  }
}

/** Installe le faux (à appeler dans `beforeEach`, avec `vi.stubGlobal`) et rend son registre. */
export function installFakeAudio(stub: (name: string, value: unknown) => void): typeof recorder {
  recorder.scheduled = [];
  recorder.currentTime = 0;
  stub('AudioContext', FakeAudioContext);
  return recorder;
}

/** Un morceau de PCM 16 bits mono, tel que la route l'envoie en base64. */
export function pcmBase64(samples: number[]): string {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf.toString('base64');
}

/** Le corps SSE d'une fin de tour, événement par événement. */
export function sseBody(events: Array<[string, unknown]>): string {
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}
