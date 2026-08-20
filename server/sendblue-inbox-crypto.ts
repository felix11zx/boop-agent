import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

const INBOX_KEY_CONTEXT = "boop-sendblue-inbox-v1";

export type SendblueInboxPayload = {
  content: string;
  fromNumber: string;
  rawUrls: string[];
};

function configuredInboxSecret(explicit?: string): string | undefined {
  return explicit ?? process.env.SENDBLUE_INBOX_KEY ?? process.env.SENDBLUE_API_SECRET;
}

function inboxKey(secret: string): Buffer {
  return createHash("sha256").update(INBOX_KEY_CONTEXT).update("\0").update(secret).digest();
}

function inboxAad(handle: string): Buffer {
  return Buffer.from(`${INBOX_KEY_CONTEXT}\0${handle}`, "utf8");
}

export function deriveSendblueInboxCapability(
  explicitSecret?: string,
): string {
  const secret = configuredInboxSecret(explicitSecret);
  if (!secret) {
    throw new Error("SENDBLUE_INBOX_KEY or SENDBLUE_API_SECRET is required for the inbox capability");
  }
  return createHash("sha256")
    .update(INBOX_KEY_CONTEXT)
    .update("\0capability\0")
    .update(secret)
    .digest("hex");
}

export function encryptSendblueInboxPayload(
  payload: SendblueInboxPayload,
  handle: string,
  explicitSecret?: string,
): string {
  const secret = configuredInboxSecret(explicitSecret);
  if (!secret) throw new Error("SENDBLUE_INBOX_KEY or SENDBLUE_API_SECRET is required for inbox encryption");
  if (!handle) throw new Error("Sendblue message handle is required for inbox encryption");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", inboxKey(secret), iv);
  cipher.setAAD(inboxAad(handle));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return ["v2", iv, cipher.getAuthTag(), encrypted]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function decryptSendblueInboxPayload(
  value: string,
  handle: string,
  explicitSecret?: string,
): SendblueInboxPayload {
  const secret = configuredInboxSecret(explicitSecret);
  if (!secret) throw new Error("SENDBLUE_INBOX_KEY or SENDBLUE_API_SECRET is required for inbox decryption");
  if (!handle) throw new Error("Sendblue message handle is required for inbox decryption");
  const parts = value.split(".");
  const isV2 = parts.length === 4 && parts[0] === "v2";
  if (!isV2 && parts.length !== 3) throw new Error("Invalid Sendblue inbox payload");
  const [ivText, tagText, encryptedText] = (isV2 ? parts.slice(1) : parts) as [
    string,
    string,
    string,
  ];
  const decipher = createDecipheriv(
    "aes-256-gcm",
    inboxKey(secret),
    Buffer.from(ivText, "base64url"),
  );
  if (isV2) decipher.setAAD(inboxAad(handle));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const decoded = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const payload = JSON.parse(decoded) as unknown;
  if (
    payload === null ||
    typeof payload !== "object" ||
    typeof (payload as SendblueInboxPayload).content !== "string" ||
    typeof (payload as SendblueInboxPayload).fromNumber !== "string" ||
    !Array.isArray((payload as SendblueInboxPayload).rawUrls) ||
    !(payload as SendblueInboxPayload).rawUrls.every((url) => typeof url === "string")
  ) {
    throw new Error("Invalid Sendblue inbox payload contents");
  }
  return payload as SendblueInboxPayload;
}

export function digestSendblueInboxPayload(
  payload: SendblueInboxPayload,
  handle: string,
  explicitSecret?: string,
): string {
  const secret = configuredInboxSecret(explicitSecret);
  if (!secret) throw new Error("SENDBLUE_INBOX_KEY or SENDBLUE_API_SECRET is required for inbox digest");
  return createHmac("sha256", inboxKey(secret))
    .update(handle)
    .update("\0")
    .update(JSON.stringify(payload))
    .digest("hex");
}
