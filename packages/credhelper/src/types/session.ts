export interface BeginSessionRequest {
  role: string;
  sessionId: string;
}

export interface BeginSessionResponse {
  sessionDir: string;
  expiresAt: Date;
}

export interface EndSessionRequest {
  sessionId: string;
}
