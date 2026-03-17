import test from "node:test";
import assert from "node:assert/strict";

import { sign, verify } from "../src/services/jwtService.js";

test("jwtService sign/verify roundtrip", () => {
  process.env.JWT_SECRET = "test_secret_for_jwt_service";
  process.env.JWT_EXPIRES = "1h";

  const token = sign({ id: "user_123", role: "USER" });
  assert.equal(typeof token, "string");
  assert.ok(token.length > 20);

  const payload = verify(token);
  assert.equal(payload.id, "user_123");
  assert.equal(payload.role, "USER");
});

test("jwtService verify rejects invalid token", () => {
  process.env.JWT_SECRET = "test_secret_for_jwt_service";
  assert.throws(() => verify("invalid.token.value"));
});

