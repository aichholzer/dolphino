import test from "node:test";
import assert from "node:assert/strict";
import {
  currencyDigits,
  money,
  decimalToMinor,
  minorToDecimal,
} from "../../frontend/src/money.js";

test("currency exponents are used for AUD, JPY and KWD", () => {
  assert.equal(currencyDigits("AUD"), 2);
  assert.equal(currencyDigits("JPY"), 0);
  assert.equal(currencyDigits("KWD"), 3);
  assert.equal(decimalToMinor("123.45", "AUD"), "12345");
  assert.equal(decimalToMinor("12345", "JPY"), "12345");
  assert.equal(decimalToMinor("12.345", "KWD"), "12345");
  assert.equal(minorToDecimal("-5", "AUD"), "-0.05");
  assert.equal(minorToDecimal("-5", "JPY"), "-5");
  assert.equal(minorToDecimal("-5", "KWD"), "-0.005");
  assert.match(money("12345", "JPY"), /12,345$/);
  assert.match(money("12345", "KWD"), /12\.345$/);
  assert.equal(money(null, "AUD"), "—");
});
test("money beyond Number precision round trips and formats exactly", () => {
  for (const currency of ["AUD", "JPY", "KWD"]) {
    for (const value of ["900719925474099312345", "-900719925474099312345"]) {
      assert.equal(
        decimalToMinor(minorToDecimal(value, currency), currency),
        value,
      );
    }
  }
  assert.match(
    money("900719925474099312345", "AUD"),
    /9,007,199,254,740,993,123\.45$/,
  );
  assert.match(
    money("-900719925474099312345", "KWD"),
    /^−.*900,719,925,474,099,312\.345$/,
  );
});
test("fractional minor units and malformed decimal inputs are rejected", () => {
  assert.throws(() => decimalToMinor("1.1", "JPY"));
  assert.throws(() => decimalToMinor("1.001", "AUD"));
  assert.throws(() => decimalToMinor("1.0001", "KWD"));
  for (const value of ["1e3", "NaN", " 2", "2.", "--2", ""])
    assert.throws(() => decimalToMinor(value, "AUD"));
});
