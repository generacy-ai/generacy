/**
 * Thrown when a circular `extends` chain is detected during workflow resolution.
 * The chain includes the full list of file paths forming the cycle.
 */
export class CircularExtendsError extends Error {
  public readonly chain: string[];

  constructor(chain: string[]) {
    super(`Circular extends detected: ${chain.join(' → ')}`);
    this.name = 'CircularExtendsError';
    this.chain = chain;
  }
}
