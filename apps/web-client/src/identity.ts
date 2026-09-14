import { publicKeyFromPrivate, type KeyPair } from "@fiber-poker/protocol";
/** Accept only the poker signing identity, never a node config or auth token. */
export function parseAgentIdentity(text: string): KeyPair {
  if (text.length > 2048)
    throw new Error(
      "Choose the agent's small .session.json poker identity file.",
    );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The poker identity file must be JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid poker identity file.");
  const key = value as Record<string, unknown>;
  if (
    Object.keys(key).some((k) => k !== "privateKey" && k !== "publicKey") ||
    typeof key.privateKey !== "string" ||
    typeof key.publicKey !== "string" ||
    !/^[0-9a-f]{64}$/.test(key.privateKey) ||
    !/^(02|03)[0-9a-f]{64}$/.test(key.publicKey)
  )
    throw new Error(
      "Choose a poker .session.json file containing only privateKey and publicKey, not Fiber credentials.",
    );
  try {
    if (publicKeyFromPrivate(key.privateKey) !== key.publicKey)
      throw new Error();
  } catch {
    throw new Error(
      "The poker private key does not match its public identity.",
    );
  }
  return { privateKey: key.privateKey, publicKey: key.publicKey };
}
