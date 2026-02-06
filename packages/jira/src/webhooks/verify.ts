import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verification result
 */
export interface VerificationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Options for webhook verification
 */
export interface VerifyOptions {
  /** The webhook secret configured in Jira */
  secret: string;
  /** The raw request body as a string */
  body: string;
  /** The signature from the X-Hub-Signature header (if using HMAC) */
  signature?: string;
  /** List of allowed IP addresses or CIDR ranges (Atlassian IPs) */
  allowedIps?: string[];
  /** The IP address of the request origin */
  sourceIp?: string;
}

/**
 * Atlassian Cloud outbound IP ranges
 * These should be periodically updated from:
 * https://support.atlassian.com/organization-administration/docs/ip-addresses-and-domains-for-atlassian-cloud-products/
 */
export const ATLASSIAN_IP_RANGES = [
  '13.52.5.96/28',
  '13.236.8.224/28',
  '18.136.214.96/28',
  '18.184.99.224/28',
  '18.234.32.224/28',
  '18.246.31.224/28',
  '52.215.192.224/28',
  '104.192.136.0/21',
  '185.166.140.0/22',
];

/**
 * Verify webhook signature using HMAC-SHA256
 */
export function verifySignature(
  body: string,
  signature: string,
  secret: string
): VerificationResult {
  if (!signature) {
    return { valid: false, reason: 'Missing signature header' };
  }

  if (!secret) {
    return { valid: false, reason: 'Missing webhook secret' };
  }

  try {
    // Jira uses sha256= prefix similar to GitHub
    const expectedPrefix = 'sha256=';
    if (!signature.startsWith(expectedPrefix)) {
      return { valid: false, reason: 'Invalid signature format' };
    }

    const providedHash = signature.slice(expectedPrefix.length);
    const hmac = createHmac('sha256', secret);
    hmac.update(body);
    const expectedHash = hmac.digest('hex');

    // Use timing-safe comparison
    const providedBuffer = Buffer.from(providedHash, 'hex');
    const expectedBuffer = Buffer.from(expectedHash, 'hex');

    if (providedBuffer.length !== expectedBuffer.length) {
      return { valid: false, reason: 'Signature mismatch' };
    }

    const valid = timingSafeEqual(providedBuffer, expectedBuffer);
    return valid
      ? { valid: true }
      : { valid: false, reason: 'Signature mismatch' };
  } catch (error) {
    return {
      valid: false,
      reason: `Verification error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Check if an IP address is within a CIDR range
 */
function isIpInRange(ip: string, cidr: string): boolean {
  const [rangeIp, prefixLength] = cidr.split('/');
  if (!rangeIp || !prefixLength) {
    return false;
  }

  const prefix = parseInt(prefixLength, 10);
  const ipParts = ip.split('.').map(Number);
  const rangeParts = rangeIp.split('.').map(Number);

  if (ipParts.length !== 4 || rangeParts.length !== 4) {
    return false;
  }

  // Convert to 32-bit integers
  const ipInt =
    (ipParts[0]! << 24) | (ipParts[1]! << 16) | (ipParts[2]! << 8) | ipParts[3]!;
  const rangeInt =
    (rangeParts[0]! << 24) |
    (rangeParts[1]! << 16) |
    (rangeParts[2]! << 8) |
    rangeParts[3]!;

  // Create mask
  const mask = prefix === 0 ? 0 : -1 << (32 - prefix);

  return (ipInt & mask) === (rangeInt & mask);
}

/**
 * Verify that the source IP is from Atlassian
 */
export function verifySourceIp(
  ip: string,
  allowedRanges: string[] = ATLASSIAN_IP_RANGES
): VerificationResult {
  if (!ip) {
    return { valid: false, reason: 'Missing source IP' };
  }

  const isAllowed = allowedRanges.some((range) => {
    // Handle both single IPs and CIDR ranges
    if (range.includes('/')) {
      return isIpInRange(ip, range);
    }
    return ip === range;
  });

  return isAllowed
    ? { valid: true }
    : { valid: false, reason: `IP ${ip} not in allowed ranges` };
}

/**
 * Comprehensive webhook verification
 */
export function verifyWebhook(options: VerifyOptions): VerificationResult {
  const { secret, body, signature, allowedIps, sourceIp } = options;

  // Verify signature if provided
  if (signature && secret) {
    const signatureResult = verifySignature(body, signature, secret);
    if (!signatureResult.valid) {
      return signatureResult;
    }
  }

  // Verify source IP if checking is requested
  if (allowedIps && sourceIp) {
    const ipResult = verifySourceIp(sourceIp, allowedIps);
    if (!ipResult.valid) {
      return ipResult;
    }
  }

  // If no verification was requested or all passed
  return { valid: true };
}

/**
 * Create a verification middleware for Express-like frameworks
 */
export function createVerificationMiddleware(secret: string) {
  return (
    req: { body: string; headers: Record<string, string>; ip?: string },
    res: { status: (code: number) => { send: (msg: string) => void } },
    next: () => void
  ): void => {
    const signature = req.headers['x-hub-signature-256'] ?? req.headers['x-hub-signature'];
    const result = verifyWebhook({
      secret,
      body: req.body,
      signature,
      sourceIp: req.ip,
      allowedIps: ATLASSIAN_IP_RANGES,
    });

    if (!result.valid) {
      res.status(401).send(`Webhook verification failed: ${result.reason}`);
      return;
    }

    next();
  };
}
