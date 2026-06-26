import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextCommonLisp.ts";

// #41: BOTH dialects carry real source lines.
const h = new Handler({"mimetype":"text/x-common-lisp","glyph":"λ","extensions":[".lisp",".lsp",".cl",".asd"]});
const src = "(defun g () 1)\n";

describe("#41 query-line conformance (both dialects)", () => {
    it("jsonpath", async () => { await assertQueryLineConformance(h, [{ source: src, dialect: "jsonpath", pattern: "$..*" }]); });
    it("xpath", async () => { await assertQueryLineConformance(h, [{ source: src, dialect: "xpath", pattern: "//*" }]); });
});
