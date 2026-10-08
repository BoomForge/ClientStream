import { randomUUID } from "node:crypto";
const base = process.env.CLIENTSTREAM_TEST_URL || "http://127.0.0.1:8794";
const email = "security-test-" + randomUUID() + "@example.invalid";
let password = "Original-" + randomUUID() + "-Aa1!";
let active = "";
let created = false;
async function request(path, method = "GET", body, cookie = active) {
  const headers = { accept: "application/json", ...(cookie ? { cookie } : {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const newCookie = response.headers.get("set-cookie")?.split(";")[0];
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data, cookie: newCookie };
}
const expect = (result, status, label) => {
  if (result.status !== status) throw Error(label + ": expected " + status + ", received " + result.status + " " + JSON.stringify(result.data));
};
try {
  const signup = await request("/api/auth/register", "POST", {
    email, password, displayName: "Security Tester", businessName: "Auth Security " + randomUUID()
  });
  expect(signup, 201, "registration");
  created = true;
  const registrationSession = signup.cookie;
  active = registrationSession;
  const secondLogin = await request("/api/auth/login", "POST", { email, password });
  expect(secondLogin, 200, "second login");
  active = secondLogin.cookie;
  expect(await request("/api/me", "GET", undefined, registrationSession), 200, "first session before change");
  const nextPassword = "Updated-" + randomUUID() + "-Aa1!";
  expect(await request("/api/auth/change-password", "POST", { currentPassword: password, newPassword: nextPassword }), 200, "password change");
  password = nextPassword;
  expect(await request("/api/me", "GET", undefined, registrationSession), 401, "old session invalidation");
  expect(await request("/api/me"), 200, "current session retention");
  expect(await request("/api/auth/login", "POST", { email, password: "incorrect" }), 401, "incorrect password");
  const afterChange = await request("/api/auth/login", "POST", { email, password });
  expect(afterChange, 200, "login after change");
  active = afterChange.cookie;
  expect(await request("/api/auth/logout", "POST"), 200, "logout");
  active = "";
  expect(await request("/api/me", "GET", undefined, afterChange.cookie), 401, "logout invalidation");
  const resumed = await request("/api/auth/login", "POST", { email, password });
  expect(resumed, 200, "final login");
  active = resumed.cookie;
  console.log("Auth security passed: login, password change, other-session revocation and logout.");
} finally {
  if (created) {
    try {
      if (!active) {
        const login = await request("/api/auth/login", "POST", { email, password }, "");
        active = login.cookie || "";
      }
      if (!active) throw Error("no active session for account cleanup");
      const deletion = await request("/api/account/delete", "POST", { password, confirmation: "DELETE" });
      expect(deletion, 200, "cleanup");
    } catch (error) {
      console.error("Auth test cleanup failure:", error.message);
      process.exitCode = 1;
    }
  }
}
