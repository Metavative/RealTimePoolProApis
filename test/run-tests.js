import assert from "node:assert/strict";

import { sign, verify } from "../src/services/jwtService.js";
import { generateOtp } from "../src/services/OTPService.js";

let failures = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(e);
  }
}

await runTest("jwtService sign/verify roundtrip", () => {
  process.env.JWT_SECRET = "test_secret_for_jwt_service";
  process.env.JWT_EXPIRES = "1h";

  const token = sign({ id: "user_123", role: "USER" });
  assert.equal(typeof token, "string");
  assert.ok(token.length > 20);

  const payload = verify(token);
  assert.equal(payload.id, "user_123");
  assert.equal(payload.role, "USER");
});

await runTest("jwtService verify rejects invalid token", () => {
  process.env.JWT_SECRET = "test_secret_for_jwt_service";
  assert.throws(() => verify("invalid.token.value"));
});

await runTest("generateOtp default length is 6 digits", () => {
  const otp = generateOtp();
  assert.equal(otp.length, 6);
  assert.match(otp, /^\d{6}$/);
});

await runTest("generateOtp respects requested length", () => {
  const otp = generateOtp(8);
  assert.equal(otp.length, 8);
  assert.match(otp, /^\d{8}$/);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}

console.log("\nAll tests passed.");

