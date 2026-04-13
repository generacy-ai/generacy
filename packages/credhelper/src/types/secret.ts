export interface Secret {
  value: string;
  format?: 'token' | 'json' | 'key' | 'opaque';
}
