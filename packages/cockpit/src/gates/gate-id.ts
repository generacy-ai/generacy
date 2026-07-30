/**
 * Back-compat shim. Canonical gateKey/gateId derivation now lives in
 * `./schema.ts` — the single source. Prefer importing `deriveGateKey` /
 * `deriveGateId` from `./schema.js` (or the package index).
 *
 * NOTE the signature moved: `deriveGateKey(issueRef: string, gateType, generation)`
 * now takes the FLAT `owner/repo#N` ref string, not an object. Use
 * `issueRefToString` (schemas.ts) to convert an object ref first.
 */
export { deriveGateKey, deriveGateId } from './schema.js';
