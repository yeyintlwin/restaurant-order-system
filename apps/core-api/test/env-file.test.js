const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadDotEnv } = require("../env-file");

function writeEnvFile(lines, newline = "\n") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "core-api-env-"));
  const file = path.join(directory, ".env");
  fs.writeFileSync(file, lines.join(newline), "utf8");
  return file;
}

test("loadDotEnv fills only the names the environment does not already have", () => {
  const file = writeEnvFile([
    "# a comment line is ignored",
    "",
    "PORT=3200",
    "HOST=127.0.0.1",
    "POSTGRES_PASSWORD=devpassword"
  ]);
  const environment = { PORT: "9999" };

  loadDotEnv(file, environment);

  // A real environment variable -- from Compose, from CI, from the shell -- always
  // beats the file. Reversing this would let a stale local .env silently override
  // the secrets file on the box.
  assert.equal(environment.PORT, "9999");
  assert.equal(environment.HOST, "127.0.0.1");
  assert.equal(environment.POSTGRES_PASSWORD, "devpassword");
});

test("loadDotEnv strips one layer of surrounding quotes and ignores non-assignments", () => {
  const file = writeEnvFile([
    'API_PUBLIC_ORIGIN="http://localhost:3200"',
    "DATABASE_URL='postgres://core_api_app:pw@127.0.0.1:5433/core'",
    "TERMINAL_ALLOWED_ORIGINS=",
    "NOT A KEY",
    "SPACED KEY=value"
  ]);
  const environment = {};

  loadDotEnv(file, environment);

  assert.equal(environment.API_PUBLIC_ORIGIN, "http://localhost:3200");
  assert.equal(environment.DATABASE_URL, "postgres://core_api_app:pw@127.0.0.1:5433/core");
  assert.equal(environment.TERMINAL_ALLOWED_ORIGINS, "");
  assert.deepEqual(
    Object.keys(environment).sort(),
    ["API_PUBLIC_ORIGIN", "DATABASE_URL", "TERMINAL_ALLOWED_ORIGINS"]
  );
});

test("loadDotEnv reads a CRLF file and treats a missing file as a no-op", () => {
  // Every editor on this win32 machine writes CRLF, and a parser splitting on "\n"
  // alone would leave a trailing "\r" on every value -- turning a correct password
  // into an authentication failure that is invisible in the file.
  const file = writeEnvFile(["PORT=3200", "HOST=0.0.0.0"], "\r\n");
  const environment = {};

  loadDotEnv(file, environment);
  assert.equal(environment.PORT, "3200");
  assert.equal(environment.HOST, "0.0.0.0");

  const missing = path.join(path.dirname(file), "does-not-exist.env");
  assert.doesNotThrow(() => loadDotEnv(missing, environment));
  assert.deepEqual(Object.keys(environment).sort(), ["HOST", "PORT"]);
});
