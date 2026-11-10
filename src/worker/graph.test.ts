import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

test("production Worker import graph has no Fastify or Coolify bridge", () => {
  const workerEntry = fileURLToPath(new URL("./index.ts", import.meta.url));
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(path, "utf8");
    const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    for (const statement of parsed.statements) {
      let specifier: string | undefined;
      if (ts.isImportDeclaration(statement)) {
        if (statement.importClause?.isTypeOnly) continue;
        const named = statement.importClause?.namedBindings;
        if (named && ts.isNamedImports(named) && named.elements.every((entry) => entry.isTypeOnly)) continue;
        specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
        specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
      }
      if (!specifier) continue;
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(path), specifier.replace(/\.js$/, ".ts"));
        visit(target);
      } else {
        external.add(specifier);
      }
    }
  };
  visit(workerEntry);
  assert.equal([...external].filter((name) => name === "fastify" || name.startsWith("@fastify/")
    || name === "find-my-way" || name === "avvio").length, 0);
  assert.equal([...seen].some((path) => /[\\/]src[\\/](?:app|server)\.ts$/.test(path)), false);
  assert.equal([...seen].some((path) => /[\\/]plugins[\\/]cors\.ts$/.test(path)), false);
});
