import { createHmac, randomBytes } from "node:crypto";

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJwt(payload, secret) {
  const header = {
    alg: "HS256",
    typ: "JWT",
  };

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput, "utf8")
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${signingInput}.${signature}`;
}

const now = Math.floor(Date.now() / 1000);
const tenYearsFromNow = now + 60 * 60 * 24 * 365 * 10;
const jwtSecret = process.env.JWT_SECRET || randomBytes(48).toString("base64url");
const issuer = process.env.JWT_ISSUER || "supabase-demo";

const anonKey = signJwt(
  {
    role: "anon",
    iss: issuer,
    iat: now,
    exp: tenYearsFromNow,
  },
  jwtSecret,
);

const serviceRoleKey = signJwt(
  {
    role: "service_role",
    iss: issuer,
    iat: now,
    exp: tenYearsFromNow,
  },
  jwtSecret,
);

console.log("JWT_SECRET=" + jwtSecret);
console.log("ANON_KEY=" + anonKey);
console.log("SERVICE_ROLE_KEY=" + serviceRoleKey);
