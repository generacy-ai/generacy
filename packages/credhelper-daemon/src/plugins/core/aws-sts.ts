import crypto from 'node:crypto';
import { z } from 'zod';
import type {
  CredentialTypePlugin,
  ExposureKind,
  Secret,
  ExposureConfig,
  PluginExposureData,
  MintContext,
} from '@generacy-ai/credhelper';

const credentialSchema = z.object({
  roleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/.+$/),
  externalId: z.string().optional(),
  region: z.string().optional(),
});

const scopeSchema = z.object({
  sessionPolicy: z.record(z.unknown()).optional(),
  durationSeconds: z.number().int().min(900).max(43200).optional(),
});

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function signV4(params: {
  method: string;
  url: URL;
  body: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}): Record<string, string> {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const service = 'sts';
  const credScope = `${dateStamp}/${params.region}/${service}/aws4_request`;

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    'host': params.url.host,
    'x-amz-date': amzDate,
  };
  if (params.sessionToken) {
    headers['x-amz-security-token'] = params.sessionToken;
  }

  const signedHeaderKeys = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}\n`)
    .join('');
  const payloadHash = sha256(params.body);
  const canonicalRequest = [
    params.method,
    '/',
    '',
    canonicalHeaders,
    signedHeaderKeys,
    payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credScope,
    sha256(canonicalRequest),
  ].join('\n');

  let signingKey: Buffer = hmacSha256(`AWS4${params.secretAccessKey}`, dateStamp);
  signingKey = hmacSha256(signingKey, params.region);
  signingKey = hmacSha256(signingKey, service);
  signingKey = hmacSha256(signingKey, 'aws4_request');

  const signature = hmacSha256(signingKey, stringToSign).toString('hex');
  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credScope}, ` +
    `SignedHeaders=${signedHeaderKeys}, Signature=${signature}`;

  return headers;
}

function parseXmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>([^<]+)</${tag}>`);
  const match = xml.match(re);
  if (!match) {
    throw new Error(`Missing <${tag}> in STS response`);
  }
  return match[1]!;
}

export const awsStsPlugin: CredentialTypePlugin = {
  type: 'aws-sts',
  credentialSchema,
  scopeSchema,
  supportedExposures: ['env'] as ExposureKind[],

  async mint(ctx: MintContext): Promise<{ value: Secret; expiresAt: Date }> {
    const raw = await ctx.backend.fetchSecret(ctx.backendKey);
    const baseCreds = JSON.parse(raw) as {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };

    const { roleArn, externalId, region } = credentialSchema.parse(ctx.config);
    const { sessionPolicy, durationSeconds } = scopeSchema.parse(ctx.scope);

    const effectiveRegion = region ?? 'us-east-1';
    const stsUrl = new URL(`https://sts.${effectiveRegion}.amazonaws.com/`);

    const bodyParams = new URLSearchParams();
    bodyParams.set('Action', 'AssumeRole');
    bodyParams.set('Version', '2011-06-15');
    bodyParams.set('RoleArn', roleArn);
    bodyParams.set('RoleSessionName', `credhelper-${Date.now()}`);
    if (externalId) {
      bodyParams.set('ExternalId', externalId);
    }
    if (durationSeconds !== undefined) {
      bodyParams.set('DurationSeconds', String(durationSeconds));
    }
    if (sessionPolicy) {
      bodyParams.set('Policy', JSON.stringify(sessionPolicy));
    }

    const body = bodyParams.toString();

    const headers = signV4({
      method: 'POST',
      url: stsUrl,
      body,
      region: effectiveRegion,
      accessKeyId: baseCreds.accessKeyId,
      secretAccessKey: baseCreds.secretAccessKey,
      sessionToken: baseCreds.sessionToken,
    });

    const response = await fetch(stsUrl.toString(), {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`AWS STS error (${response.status}): ${text}`);
    }

    const xml = await response.text();
    const accessKeyId = parseXmlTag(xml, 'AccessKeyId');
    const secretAccessKey = parseXmlTag(xml, 'SecretAccessKey');
    const sessionToken = parseXmlTag(xml, 'SessionToken');
    const expiration = parseXmlTag(xml, 'Expiration');

    return {
      value: {
        value: JSON.stringify({ accessKeyId, secretAccessKey, sessionToken }),
        format: 'json',
      },
      expiresAt: new Date(expiration),
    };
  },

  renderExposure(
    kind: ExposureKind,
    secret: Secret,
    _cfg: ExposureConfig,
  ): PluginExposureData {
    if (kind === 'env') {
      const creds = JSON.parse(secret.value) as {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken: string;
      };
      return {
        kind: 'env',
        entries: [
          { key: 'AWS_ACCESS_KEY_ID', value: creds.accessKeyId },
          { key: 'AWS_SECRET_ACCESS_KEY', value: creds.secretAccessKey },
          { key: 'AWS_SESSION_TOKEN', value: creds.sessionToken },
        ],
      };
    }
    throw new Error(`Unsupported exposure kind: ${kind}`);
  },
};
