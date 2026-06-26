import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextCommonLisp.ts";

// #41: structural matches carry source-line spans (coverage gate).
const h = new Handler({"mimetype":"text/x-common-lisp","glyph":"λ","extensions":[".lisp",".lsp",".cl",".asd"]});

describe("#41 query-line conformance", () => {
    it("every structural match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: "(defun g () 1)\n", dialect: "jsonpath", pattern: "$..*" }]);
    });
});
