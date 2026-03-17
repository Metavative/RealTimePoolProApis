import test from "node:test";
import assert from "node:assert/strict";

import { generateOtp } from "../src/services/OTPService.js";

test("generateOtp default length is 6 digits", () => {
  const otp = generateOtp();
  assert.equal(otp.length, 6);
  assert.match(otp, /^\d{6}$/);
});

test("generateOtp respects requested length", () => {
  const otp = generateOtp(8);
  assert.equal(otp.length, 8);
  assert.match(otp, /^\d{8}$/);
});

