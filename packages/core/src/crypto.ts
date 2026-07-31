import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const VERSION = "v1";

export class LocalFileKeyStore {
  private readonly keyPath: string;
  private key?: Buffer;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.keyPath = join(dataDir, "install.key");
  }

  private loadKey(): Buffer {
    if (this.key) return this.key;
    if (!existsSync(this.keyPath)) {
      const key = randomBytes(32);
      writeFileSync(this.keyPath, key, { mode: 0o600 });
      try { chmodSync(this.keyPath, 0o600); } catch { /* Windows uses the user profile ACL. */ }
      this.key = key;
      return key;
    }
    const key = readFileSync(this.keyPath);
    if (key.length !== 32) throw new Error("Invalid local encryption key");
    this.key = key;
    return key;
  }

  encrypt(value: string, aad = ""): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.loadKey(), iv);
    cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
  }

  decrypt(value: string, aad = ""): string {
    const [version, ivText, tagText, dataText] = value.split(".");
    if (version !== VERSION || !ivText || !tagText || !dataText) throw new Error("Invalid encrypted value");
    const decipher = createDecipheriv("aes-256-gcm", this.loadKey(), Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]).toString("utf8");
  }

  resolve(value: string | undefined, aad = ""): string | undefined {
    if (!value) return undefined;
    if (value.startsWith("env:")) return process.env[value.slice(4)];
    if (value.startsWith("encrypted:")) return this.decrypt(value.slice(10), aad);
    return value;
  }

  protect(value: string, aad = ""): string {
    return `encrypted:${this.encrypt(value, aad)}`;
  }
}
