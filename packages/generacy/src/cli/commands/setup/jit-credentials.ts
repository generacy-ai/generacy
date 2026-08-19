/**
 * Detection for the cluster-base JIT git credential helper.
 *
 * Wizard-mode (cloud) clusters authenticate git via `git-credential-generacy`
 * (generacy-ai/generacy#766, wired by cluster-base's setup-credentials.sh):
 * every git operation mints a fresh GitHub App installation token from the
 * control-plane, so auth can never go stale. The only GitHub token present in
 * the container environment is the activation-time `ghs_` installation token
 * sourced from wizard-credentials.env — it expires one hour after activation.
 *
 * `setup auth` and `setup workspace` predate that helper: given a GH_TOKEN
 * they configure `credential.helper store` / run `gh auth setup-git`, which
 * REPLACES the JIT helper wiring with a static copy of the 1-hour token and
 * breaks all git auth in the container an hour later
 * (generacy-ai/cluster-base#66 saw the same clobber from VS Code).
 *
 * Both commands consult this gate and leave git/gh credential configuration
 * alone when the JIT helper is active.
 */
import { execSafe } from '../../utils/exec.js';

const JIT_HELPER_MARKER = 'git-credential-generacy';

/**
 * True when this container relies on the JIT git credential helper.
 *
 * Requires BOTH wizard bootstrap mode and the helper actually present in git
 * config: on wizard clusters running a pre-JIT cluster-base image the helper
 * was never configured, and skipping the legacy static setup there would
 * leave the container with no git credentials at all.
 */
export function jitCredentialHelperActive(): boolean {
  if (process.env['GENERACY_BOOTSTRAP_MODE'] !== 'wizard') {
    return false;
  }
  const helpers = execSafe(
    'git config --global --get-all credential.https://github.com.helper',
  );
  return helpers.ok && helpers.stdout.includes(JIT_HELPER_MARKER);
}
