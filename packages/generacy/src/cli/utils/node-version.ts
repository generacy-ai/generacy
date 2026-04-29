export function checkNodeVersion(minimum: number): void {
  const current = parseInt(process.versions.node.split('.')[0]!, 10);
  if (current < minimum) {
    console.error(
      `generacy requires Node.js ${minimum} or later (you have ${process.versions.node}).\n` +
      `Install the latest LTS: https://nodejs.org/en/download`
    );
    process.exit(1);
  }
}
