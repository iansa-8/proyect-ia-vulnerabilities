const SECRET_KEY_PATTERN = /TOKEN|PASSWORD|SECRET|API_KEY|AUTHORIZATION/i;
const SECRET_ARG_PATTERN = /^-Dsonar\.(?:token|login|password)=(.*)$/i;

export function isSecretEnvKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Redacts env values whose keys look like secrets.
 * Never log the raw env map returned by callers without this.
 */
export function redactSecretsInEnv(
  env: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = isSecretEnvKey(key) ? '[REDACTED]' : value;
  }
  return out;
}

/**
 * Replaces known secret values in free-form text (e.g. before persisting logs).
 * Collect secret values from env entries whose keys match isSecretEnvKey.
 */
export function redactSecretsInText(
  text: string,
  secretValues: readonly string[],
): string {
  let result = text;
  for (const secret of [...new Set(secretValues)].sort((a, b) => b.length - a.length)) {
    if (!secret) {
      continue;
    }
    result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

/** Collect non-empty secret values from an env map for text redaction. */
export function collectSecretValues(env: Record<string, string | undefined>, args: readonly string[] = []): string[] {
  return [...new Set([
    ...Object.entries(env)
      .filter(([key, value]) => isSecretEnvKey(key) && Boolean(value))
      .map(([, value]) => value!),
    ...args.flatMap((arg) => {
      const match = SECRET_ARG_PATTERN.exec(arg);
      return match?.[1] ? [match[1]] : [];
    }),
  ])];
}

/**
 * Redacts secret-bearing CLI args (e.g. -Dsonar.token=…, -Dsonar.login=…).
 * Safe to persist / log after this transform.
 */
export function redactSecretArgs(
  args: readonly string[],
  secretValues: readonly string[] = [],
): string[] {
  return args.map((arg) => {
    if (/^-Dsonar\.(token|login|password)=/i.test(arg)) {
      const eq = arg.indexOf('=');
      return eq >= 0 ? `${arg.slice(0, eq + 1)}[REDACTED]` : arg;
    }
    return redactSecretsInText(arg, secretValues);
  });
}
