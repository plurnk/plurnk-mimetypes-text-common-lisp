import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertHandlerConformance } from "@plurnk/plurnk-mimetypes/conformance";
import TextCommonLisp from "./TextCommonLisp.ts";

const metadata = {
    mimetype: "text/x-common-lisp",
    glyph: "λ",
    extensions: [".lisp", ".lsp", ".cl", ".asd"] as const,
};
const h = () => new TextCommonLisp(metadata);

// Real-world-shaped fixture: a defpackage, local defuns that call each other,
// external calls (format, +, make-instance) that become dead rows, and noise
// (let/dolist bindings, comments, strings, #'fn) that must NOT surface.
const SRC = `(defpackage :plurnk.shapes
  (:use :cl)
  (:export #:make-circle #:area-of))

(in-package :plurnk.shapes)

(defun area-of (radius)
  ;; multiply-the-frobnicate is only a comment word, never a ref
  (* +pi+ radius radius))

(defun describe-shape (radius)
  "render a widget summary; this string has (parens) and ; semicolons"
  (let ((a (area-of radius))
        (label "circle"))
    (dolist (line (list label a))
      (format t "~a~%" line))
    (area-of radius)))

(defun make-circle (radius)
  (make-instance 'circle :radius radius)
  (describe-shape radius)
  #'area-of)
`;

describe("TextCommonLisp — references (call graph)", () => {
    it("local defun calls are `call` edges scoped to the enclosing defun", () => {
        const refs = h().references(SRC);
        // area-of called inside describe-shape — twice (let-binding value is
        // skipped, body call surfaces) and once more in the body.
        assert.ok(refs.some((r) =>
            r.name === "area-of" && r.kind === "call" && r.container === "describe-shape"));
        assert.ok(refs.some((r) =>
            r.name === "describe-shape" && r.kind === "call" && r.container === "make-circle"));
    });

    it("special operators and binding macros do not surface (let, dolist)", () => {
        const refs = h().references(SRC);
        assert.ok(!refs.some((r) => r.name === "let"));
        assert.ok(!refs.some((r) => r.name === "dolist"));
        // dolist's binding var `line` and let's binding name `a` are bindings,
        // not calls — they must never appear.
        assert.ok(!refs.some((r) => r.name === "line"));
        assert.ok(!refs.some((r) => r.name === "a"));
    });

    it("a #'function ref is not a call site", () => {
        const refs = h().references(SRC);
        // area-of appears as a call elsewhere, but the #'area-of in make-circle
        // must not add a make-circle-scoped call ref for it.
        assert.ok(!refs.some((r) =>
            r.name === "area-of" && r.container === "make-circle"));
    });

    it("external calls are present as dead rows (format, make-instance)", () => {
        const refs = h().references(SRC);
        assert.ok(refs.some((r) => r.name === "format" && r.kind === "call"));
        assert.ok(refs.some((r) => r.name === "make-instance" && r.kind === "call"));
    });

    it("string/comment content never surfaces as a ref", () => {
        const refs = h().references(SRC);
        assert.ok(!refs.some((r) => r.name === "widget"));
        assert.ok(!refs.some((r) => r.name === "parens"));
        assert.ok(!refs.some((r) => r.name === "multiply-the-frobnicate"));
    });

    it("passes the SPEC §16 conformance invariants", async () => {
        await assertHandlerConformance(h(), {
            source: SRC,
            decoyNames: [
                "multiply-the-frobnicate", "widget", "parens", "semicolons",
                "circle", "line", "a", "label",
            ],
            expectJoins: [
                { refName: "area-of", container: "describe-shape" },
                { refName: "describe-shape", container: "make-circle" },
            ],
            expectRefs: [
                { name: "area-of", kind: "call", container: "describe-shape" },
                { name: "describe-shape", kind: "call", container: "make-circle" },
                { name: "format", kind: "call" },
            ],
        });
    });
});
