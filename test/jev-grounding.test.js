// Unit tests for jev-grounding.js — the pure Jev decisions helper. Runs under `node --test`
// with no DOM / chrome / real network (fetch is injected). Covers request building, answer
// parsing, and the fail-open contract (no token / bad response / throw → null).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Jev = require("../jev-grounding.js");

test("buildDecisionRequest targets the decisions endpoint with the model + state + questions", () => {
  const q = { ok: { type: "noul", instructions: "Did it work?" } };
  const { url, options } = Jev.buildDecisionRequest("SNAP", q, { token: "sk-or-x" });
  assert.equal(url, Jev.JEV_ENDPOINT);
  assert.equal(options.method, "POST");
  assert.equal(options.headers["Authorization"], "Bearer sk-or-x");
  assert.equal(options.headers["Content-Type"], "application/json");
  const body = JSON.parse(options.body);
  assert.equal(body.model, Jev.JEV_MODEL);
  assert.equal(body.state, "SNAP");
  assert.deepEqual(body.questions, q); // `instructions` preserved verbatim
});

test("buildDecisionRequest omits Authorization when no token, coerces null state to ''", () => {
  const { options } = Jev.buildDecisionRequest(null, {}, {});
  assert.equal(options.headers["Authorization"], undefined);
  assert.equal(JSON.parse(options.body).state, "");
});

test("parseAnswers flattens noul / choice / score and tolerates garbage", () => {
  assert.deepEqual(
    Jev.parseAnswers({ answers: { a: { type: "noul", noul: 0.82 }, b: { type: "choice", choice: "e5" }, c: { type: "score", score: 3 } } }),
    { a: 0.82, b: "e5", c: 3 }
  );
  assert.deepEqual(Jev.parseAnswers({}), {});
  assert.deepEqual(Jev.parseAnswers(null), {});
  assert.deepEqual(Jev.parseAnswers({ answers: "nope" }), {});
});

test("evaluate returns null with no token (grounding disabled)", async () => {
  const answers = await Jev.evaluate("SNAP", { ok: { type: "noul", instructions: "?" } }, {});
  assert.equal(answers, null);
});

test("evaluate parses a successful decisions response", async () => {
  const fakeFetch = async (_url, _opts) => ({ ok: true, json: async () => ({ answers: { ok: { type: "noul", noul: 0.91 } } }) });
  const answers = await Jev.evaluate("SNAP", { ok: { type: "noul", instructions: "?" } }, { token: "t", fetch: fakeFetch });
  assert.equal(Jev.noul(answers, "ok"), 0.91);
});

test("evaluate fails open (null) on non-ok response and on throw", async () => {
  const notOk = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await Jev.evaluate("S", {}, { token: "t", fetch: notOk }), null);
  const boom = async () => { throw new Error("network"); };
  assert.equal(await Jev.evaluate("S", {}, { token: "t", fetch: boom }), null);
});

test("noul helper reads a probability or null", () => {
  assert.equal(Jev.noul({ ok: 0.5 }, "ok"), 0.5);
  assert.equal(Jev.noul({ ok: 0.5 }, "missing"), null);
  assert.equal(Jev.noul(null, "ok"), null);
});
