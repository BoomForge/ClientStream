import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Simulate a real DOM submit event: currentTarget is available during dispatch,
// but becomes null as soon as an async handler yields to a Promise.
const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

for (const [id, endpoint] of [
  ["login-form", "/api/auth/login"],
  ["register-form", "/api/auth/register"]
]) {
  const marker = '$("#' + id + '").addEventListener("submit", ';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, id + " submit handler is missing");
  const bodyStart = start + marker.length;
  const bodyEnd = source.indexOf("\n});", bodyStart);
  assert.ok(bodyEnd >= 0, id + " submit handler has no closing line");

  const submitted = [];
  const messages = [];
  let resets = 0;
  let shown = 0;
  let prevented = false;
  const element = {
    fields: {
      email: "owner@example.test",
      password: "SamplePassword123!",
      displayName: "Owner",
      businessName: "Example Business"
    },
    reset() { resets += 1; }
  };
  const state = { me: null };
  class MockFormData {
    constructor(node) {
      assert.equal(node, element);
      this.fields = { ...node.fields };
    }
    get(key) { return this.fields[key] ?? null; }
  }
  const sandbox = {
    FormData: MockFormData,
    JSON,
    state,
    api: async (path, options) => {
      submitted.push(path);
      if (path === endpoint) {
        const body = JSON.parse(options.body);
        assert.equal(body.email, element.fields.email);
        return {};
      }
      if (path === "/api/me") {
        return { user: { email: element.fields.email }, business: { name: "Example Business" } };
      }
      throw new Error("Unexpected request: " + path);
    },
    showApp: async () => { shown += 1; },
    toast: (message, isError) => { messages.push({ message, isError }); }
  };
  const expression = source.slice(bodyStart, bodyEnd + 2);
  const handler = runInNewContext("(" + expression + ")", sandbox);
  const event = {
    currentTarget: element,
    preventDefault() { prevented = true; }
  };

  const pending = handler(event);
  event.currentTarget = null; // Browser behavior immediately after listener returns.
  await pending;

  assert.ok(prevented, id + " did not prevent default form submit");
  assert.deepEqual(submitted, [endpoint, "/api/me"], id + " did not authenticate");
  assert.equal(resets, 1, id + " did not reset its saved form element");
  assert.equal(shown, 1, id + " did not open the app");
  assert.equal(messages.some(({ isError }) => isError), false, id + " emitted an error");
  assert.ok(state.me?.user, id + " did not retain authenticated user");
  console.log(id + " works after submit event.currentTarget becomes null");
}
