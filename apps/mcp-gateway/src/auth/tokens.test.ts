import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  generateToken,
  sha256hex,
  safeEqualHex,
  verifyPkceS256,
  parseBearer,
  hashPassword,
  verifyPassword,
  parseCookies,
  TOKEN_PREFIX
} from "./tokens.js";

function pkcePair() {
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

test("generateToken prefixes and is unique", () => {
  const a = generateToken(TOKEN_PREFIX.access);
  const b = generateToken(TOKEN_PREFIX.access);
  assert.ok(a.startsWith("amcp_at_"));
  assert.notEqual(a, b);
});

test("sha256hex stable + safeEqualHex", () => {
  assert.equal(sha256hex("x"), sha256hex("x"));
  assert.ok(safeEqualHex(sha256hex("x"), sha256hex("x")));
  assert.ok(!safeEqualHex(sha256hex("x"), sha256hex("y")));
});

test("verifyPkceS256 accepts matching, rejects wrong", () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifyPkceS256(verifier, challenge));
  assert.ok(!verifyPkceS256("wrong-verifier", challenge));
  assert.ok(!verifyPkceS256(verifier, "wrong-challenge"));
  assert.ok(!verifyPkceS256("", challenge));
});

test("password hash roundtrip", () => {
  const stored = hashPassword("hunter2");
  assert.ok(stored.includes(":"));
  assert.ok(verifyPassword("hunter2", stored));
  assert.ok(!verifyPassword("wrong", stored));
  assert.ok(!verifyPassword("hunter2", "garbage"));
});

test("parseBearer", () => {
  assert.equal(parseBearer("Bearer abc.def"), "abc.def");
  assert.equal(parseBearer("bearer xyz"), "xyz");
  assert.equal(parseBearer("Basic abc"), null);
  assert.equal(parseBearer(undefined), null);
});

test("parseCookies", () => {
  const c = parseCookies("a=1; b=two%20words; c=3");
  assert.equal(c.a, "1");
  assert.equal(c.b, "two words");
  assert.equal(c.c, "3");
  assert.deepEqual(parseCookies(undefined), {});
});
