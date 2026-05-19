import { Transform, type TransformCallback } from 'node:stream';

const URL_PATTERN = /https?:\/\/\S+/;

export class UrlScanner extends Transform {
  private _detectedUrl: string | null = null;
  private _resolve: ((url: string) => void) | null = null;
  readonly urlDetected: Promise<string>;

  constructor() {
    super();
    this.urlDetected = new Promise<string>((resolve) => {
      this._resolve = resolve;
    });
  }

  get detectedUrl(): string | null {
    return this._detectedUrl;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    // Always pass data through
    this.push(chunk);

    // Only scan if we haven't found a URL yet
    if (this._detectedUrl === null) {
      const text = chunk.toString('utf-8');
      const match = URL_PATTERN.exec(text);
      if (match) {
        this._detectedUrl = match[0];
        if (this._resolve) {
          this._resolve(match[0]);
          this._resolve = null;
        }
      }
    }

    callback();
  }
}
