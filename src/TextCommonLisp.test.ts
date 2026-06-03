import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextCommonLisp from "./TextCommonLisp.ts";

const metadata = {
    mimetype: "text/x-common-lisp",
    glyph: "λ",
    extensions: [".lisp", ".lsp", ".cl", ".asd"] as const,
};

describe("TextCommonLisp — instantiation", () => {
    it("instantiates with metadata", () => {
        const h = new TextCommonLisp(metadata);
        assert.equal(h.mimetype, "text/x-common-lisp");
        assert.equal(h.glyph, "λ");
    });
});

describe("TextCommonLisp — extract", () => {
    it("extracts defun with params", () => {
        const h = new TextCommonLisp(metadata);
        const src = "(defun add (a b) (+ a b))";
        const syms = h.extractRaw(src);
        const add = syms.find((s) => s.name === "add");
        assert.ok(add);
        assert.equal(add.kind, "function");
        assert.deepEqual(add.params, ["a", "b"]);
    });

    it("extracts hyphenated identifiers (a real Common Lisp idiom)", () => {
        const h = new TextCommonLisp(metadata);
        const src = "(defun frobnicate-the-foozle (whatsit-list)\n  (mapcar #'process whatsit-list))";
        const syms = h.extractRaw(src);
        const f = syms.find((s) => s.name === "frobnicate-the-foozle");
        assert.ok(f);
        assert.equal(f.kind, "function");
        assert.deepEqual(f.params, ["whatsit-list"]);
    });

    it("extracts uppercase / mixed-case identifiers", () => {
        const h = new TextCommonLisp(metadata);
        const src = "(defclass Vehicle () ((wheels :initarg :wheels)))";
        const syms = h.extractRaw(src);
        const v = syms.find((s) => s.name === "Vehicle");
        assert.ok(v);
        assert.equal(v.kind, "class");
    });

    it("extracts operator-style identifiers (e.g. +, -, *, /)", () => {
        const h = new TextCommonLisp(metadata);
        const src = "(defun my+ (x y) (+ x y))";
        const syms = h.extractRaw(src);
        const f = syms.find((s) => s.name === "my+");
        assert.ok(f);
    });

    it("extracts defmacro as function", () => {
        const h = new TextCommonLisp(metadata);
        const src = "(defmacro unless (test &body body) `(if (not ,test) (progn ,@body)))";
        const syms = h.extractRaw(src);
        const m = syms.find((s) => s.name === "unless");
        assert.ok(m);
        assert.equal(m.kind, "function");
        // &body is excluded from params.
        assert.deepEqual(m.params, ["test"]);
    });

    it("extracts defmethod with typed parameter specifiers", () => {
        const h = new TextCommonLisp(metadata);
        const src = "(defmethod area ((s circle)) (* pi (radius s) (radius s)))";
        const syms = h.extractRaw(src);
        const m = syms.find((s) => s.name === "area");
        assert.ok(m);
        assert.equal(m.kind, "method");
        // Typed specifier (s circle) → emit `s` (first atom inside).
        assert.deepEqual(m.params, ["s"]);
    });

    it("extracts defgeneric", () => {
        const h = new TextCommonLisp(metadata);
        const src = "(defgeneric area (shape) (:documentation \"compute area\"))";
        const syms = h.extractRaw(src);
        const g = syms.find((s) => s.name === "area");
        assert.ok(g);
        assert.equal(g.kind, "function");
    });

    it("extracts defparameter / defvar as variable", () => {
        const h = new TextCommonLisp(metadata);
        const src = [
            "(defparameter *config* (make-hash-table))",
            "(defvar *cache* nil)",
        ].join("\n");
        const syms = h.extractRaw(src);
        const c = syms.find((s) => s.name === "*config*");
        assert.ok(c);
        assert.equal(c.kind, "variable");
        const cc = syms.find((s) => s.name === "*cache*");
        assert.ok(cc);
        assert.equal(cc.kind, "variable");
    });

    it("extracts defconstant as constant", () => {
        const h = new TextCommonLisp(metadata);
        const src = "(defconstant +max-retries+ 3)";
        const syms = h.extractRaw(src);
        const c = syms.find((s) => s.name === "+max-retries+");
        assert.ok(c);
        assert.equal(c.kind, "constant");
    });

    it("extracts defclass + defstruct as class", () => {
        const h = new TextCommonLisp(metadata);
        const src = [
            "(defclass Animal () ((name :initarg :name)))",
            "(defstruct Point x y)",
        ].join("\n");
        const syms = h.extractRaw(src);
        assert.ok(syms.find((s) => s.name === "Animal" && s.kind === "class"));
        assert.ok(syms.find((s) => s.name === "Point" && s.kind === "class"));
    });

    it("extracts deftype as type", () => {
        const h = new TextCommonLisp(metadata);
        const src = "(deftype nat () '(integer 0 *))";
        const syms = h.extractRaw(src);
        const t = syms.find((s) => s.name === "nat");
        assert.ok(t);
        assert.equal(t.kind, "type");
    });

    it("extracts defpackage as module", () => {
        const h = new TextCommonLisp(metadata);
        const src = [
            "(defpackage :my-app",
            "  (:use :cl :alexandria)",
            "  (:export #:run))",
        ].join("\n");
        const syms = h.extractRaw(src);
        const p = syms.find((s) => s.name === ":my-app");
        assert.ok(p);
        assert.equal(p.kind, "module");
    });

    it("skips line comments (;) and block comments (#| ... |#)", () => {
        const h = new TextCommonLisp(metadata);
        const src = [
            "; This is a line comment",
            "(defun foo () 1)  ; trailing comment",
            "#| block comment",
            "   spanning lines |#",
            "(defun bar () 2)",
        ].join("\n");
        const syms = h.extractRaw(src);
        assert.ok(syms.find((s) => s.name === "foo"));
        assert.ok(syms.find((s) => s.name === "bar"));
    });

    it("handles strings containing parens and semicolons", () => {
        const h = new TextCommonLisp(metadata);
        const src = "(defun greet () \"Hello (world); how are you?\")";
        const syms = h.extractRaw(src);
        const g = syms.find((s) => s.name === "greet");
        assert.ok(g);
    });

    it("excludes in-package and other directives", () => {
        const h = new TextCommonLisp(metadata);
        const src = [
            "(in-package :my-app)",
            "(declaim (optimize speed))",
            "(defun real-thing () 1)",
        ].join("\n");
        const syms = h.extractRaw(src);
        const names = syms.map((s) => s.name);
        assert.deepEqual(names, ["real-thing"]);
    });

    it("handles #+/#- conditional reader macros", () => {
        const h = new TextCommonLisp(metadata);
        const src = [
            "#+sbcl",
            "(defun sbcl-only () 1)",
            "#-sbcl",
            "(defun fallback () 2)",
        ].join("\n");
        const syms = h.extractRaw(src);
        // Both should surface — the reader-macro prefix is consumed.
        assert.ok(syms.find((s) => s.name === "sbcl-only"));
        assert.ok(syms.find((s) => s.name === "fallback"));
    });

    it("returns empty array for empty input", () => {
        const h = new TextCommonLisp(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("does not throw on malformed source", () => {
        const h = new TextCommonLisp(metadata);
        assert.doesNotThrow(() => h.extractRaw("(((broken"));
        assert.doesNotThrow(() => h.extractRaw("(defun )"));
        assert.doesNotThrow(() => h.extractRaw("@@@@@"));
    });
});

describe("TextCommonLisp — framework integration", () => {
    it("renders extracted hierarchy via format()", async () => {
        const h = new TextCommonLisp(metadata);
        const out = await h.symbolsRaw("(defun answer () 42)");
        assert.ok(out.includes("function answer"));
    });

    it("jsonpath dispatches against the deep-json forms tree (issue #10)", async () => {
        const h = new TextCommonLisp(metadata);
        const src = "(defun foo () 1)\n(defmacro bar () 2)\n";
        const forms = await h.query(src, "jsonpath", "$.children[?(@.type=='defun')]");
        assert.equal(forms.length, 1);
        assert.equal((forms[0].matched as { name: string }).name, "foo");
    });
});

// Real-world smoke against a representative Common Lisp file.
describe("TextCommonLisp — real-world smoke (package + classes + methods)", () => {
    const SRC = [
        "(defpackage :plurnk.shapes",
        "  (:use :cl)",
        "  (:export #:area #:make-circle #:make-square))",
        "",
        "(in-package :plurnk.shapes)",
        "",
        "(defconstant +pi+ 3.14159)",
        "(defparameter *default-color* :black)",
        "(defvar *shape-counter* 0)",
        "",
        "(defclass shape ()",
        "  ((color :initarg :color :accessor shape-color)))",
        "",
        "(defclass circle (shape)",
        "  ((radius :initarg :radius :accessor circle-radius)))",
        "",
        "(defclass square (shape)",
        "  ((side :initarg :side :accessor square-side)))",
        "",
        "(defgeneric area (s)",
        "  (:documentation \"Compute the area of a shape.\"))",
        "",
        "(defmethod area ((s circle))",
        "  (* +pi+ (circle-radius s) (circle-radius s)))",
        "",
        "(defmethod area ((s square))",
        "  (let ((side (square-side s)))",
        "    (* side side)))",
        "",
        "(defun make-circle (radius)",
        "  (make-instance 'circle :radius radius))",
        "",
        "(defun make-square (side)",
        "  (make-instance 'square :side side))",
        "",
        "(defmacro with-shape-counter (&body body)",
        "  `(let ((*shape-counter* (1+ *shape-counter*)))",
        "     ,@body))",
    ].join("\n");

    it("surfaces package, defclasses, defgeneric, defmethods, defuns, defmacro, vars, constants", () => {
        const h = new TextCommonLisp(metadata);
        const syms = h.extractRaw(SRC);
        const names = new Set(syms.map((s) => s.name));

        assert.ok(names.has(":plurnk.shapes"));
        assert.ok(names.has("+pi+"));
        assert.ok(names.has("*default-color*"));
        assert.ok(names.has("*shape-counter*"));
        assert.ok(names.has("shape"));
        assert.ok(names.has("circle"));
        assert.ok(names.has("square"));
        assert.ok(names.has("area"));
        assert.ok(names.has("make-circle"));
        assert.ok(names.has("make-square"));
        assert.ok(names.has("with-shape-counter"));
    });

    it("kind discrimination", () => {
        const h = new TextCommonLisp(metadata);
        const syms = h.extractRaw(SRC);
        const byNameKind = new Map(syms.map((s) => [`${s.name}:${s.kind}`, s]));
        assert.ok(byNameKind.has(":plurnk.shapes:module"));
        assert.ok(byNameKind.has("+pi+:constant"));
        assert.ok(byNameKind.has("*default-color*:variable"));
        assert.ok(byNameKind.has("shape:class"));
        assert.ok(byNameKind.has("area:function"));   // defgeneric → function
        assert.ok(byNameKind.has("make-circle:function"));
        // defmethod also called "area" — emits a separate method symbol
        const methods = syms.filter((s) => s.name === "area" && s.kind === "method");
        assert.equal(methods.length, 2, "two defmethod area clauses, both surface");
    });
});
