import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeRef, MimeSymbol, SymbolKind } from "@plurnk/plurnk-mimetypes";

// text/x-common-lisp handler. Hand-rolled S-expression scanner.
//
// The grammars-v4 `lisp` grammar is a McCarthy-1960 toy (can't tokenize
// `+`, hyphens, or uppercase). We bypass ANTLR entirely and implement a
// minimal scanner that handles real Common Lisp syntax:
//   - parens, atoms, strings, char literals (#\...)
//   - quote, backquote, comma, comma-at (',`,,@) — opaque
//   - line comments (;) and block comments (#| ... |#)
//   - reader macros (#', #(, #+, #-, etc.) — best-effort handling
//
// We don't build a full AST. We walk top-level forms, record their head
// atom (defun / defmacro / defclass / etc.), and use it to dispatch a
// symbol emission with the second atom as the declared name.
export default class TextCommonLisp extends BaseHandler {
    override extractRaw(content: HandlerContent): MimeSymbol[] {
        if (typeof content !== "string") return [];
        try {
            return extractCommonLisp(content);
        } catch {
            return [];
        }
    }

    // Deep-channel (issue #10). For an S-expression language, the natural
    // deep-tree is one node per top-level form carrying its head atom (defun,
    // defmacro, etc.), declared name, and source range. Coarser than a full
    // S-expression AST (Common Lisp's sub-form structure isn't navigable
    // anyway — macros transform it freely) but enough for jsonpath like
    // \$.children[?(@.head=='defun')] to find all function definitions.
    override deepJson(content: HandlerContent): unknown {
        if (typeof content !== "string") return null;
        try {
            const children = extractForms(content);
            return { type: "program", line: 1, endLine: children.length > 0
                ? (children[children.length - 1] as { endLine: number }).endLine
                : 1, children };
        } catch {
            return null;
        }
    }

    // References channel (SPEC §16). The head of a list form is a function
    // invocation → `call`. We harvest call heads ONLY inside top-level
    // (defun ...) / (defmacro ...) bodies — those are the only forms whose
    // emitted symbol is a single, unambiguously-named container (the @>
    // join key). Special operators and the common macros that introduce
    // binding/control structure (let, if, loop, …) are noise, not edges, and
    // are excluded via SPECIAL_OPERATORS. PRECISION OVER RECALL: a call that
    // resolves to a local defun joins; an external call is a dead row.
    override references(content: HandlerContent): MimeRef[] {
        if (typeof content !== "string") return [];
        try {
            return collectCallRefs(content);
        } catch {
            return [];
        }
    }
}

function extractForms(src: string): unknown[] {
    const out: unknown[] = [];
    const scanner = new Scanner(src);
    while (!scanner.eof()) {
        const form = scanner.readTopLevelForm();
        if (!form) break;
        if (form.head) {
            const node: Record<string, unknown> = {
                type: form.head,
                line: form.line,
                endLine: form.endLine,
            };
            if (form.secondAtom !== null) node.name = form.secondAtom;
            if (form.paramAtoms.length > 0) node.params = form.paramAtoms;
            out.push(node);
        }
    }
    return out;
}

// SPEC §3 mapping:
//   (defun name (args) body)          → function
//   (defmacro name (args) body)       → function
//   (defmethod name (args) body)      → method
//   (defgeneric name (args) ...)      → function (interface-ish)
//   (defparameter name expr)          → variable
//   (defvar name expr)                → variable
//   (defconstant name expr)           → constant
//   (defclass name (super) slots)     → class
//   (defstruct name slots)            → class
//   (deftype name (args) body)        → type
//   (defpackage name ...)             → module
//   (in-package name)                 → not surfaced (just a directive)

interface FormSig {
    head: string;
    secondAtom: string | null;
    line: number;
    endLine: number;
    paramAtoms: string[];
}

function extractCommonLisp(src: string): MimeSymbol[] {
    const symbols: MimeSymbol[] = [];
    const scanner = new Scanner(src);
    while (!scanner.eof()) {
        const form = scanner.readTopLevelForm();
        if (!form) break;
        if (form.head) emit(symbols, form);
    }
    return symbols;
}

function emit(out: MimeSymbol[], form: FormSig): void {
    const dispatch = (kind: SymbolKind, withParams = false): void => {
        if (!form.secondAtom) return;
        const sym: MimeSymbol = {
            name: form.secondAtom,
            kind,
            line: form.line,
            endLine: form.endLine,
        };
        if (withParams) sym.params = form.paramAtoms;
        out.push(sym);
    };

    switch (form.head.toLowerCase()) {
        case "defun":
        case "defmacro":
            dispatch("function", true);
            return;
        case "defgeneric":
            dispatch("function", true);
            return;
        case "defmethod":
            dispatch("method", true);
            return;
        case "defparameter":
        case "defvar":
            dispatch("variable");
            return;
        case "defconstant":
            dispatch("constant");
            return;
        case "defclass":
        case "defstruct":
            dispatch("class");
            return;
        case "deftype":
            dispatch("type");
            return;
        case "defpackage":
            dispatch("module");
            return;
        default:
            return;
    }
}

// Special operators + the pervasive macros that are control/binding structure,
// not function calls. A list whose head is in this set is NOT an edge — these
// are syntax, and harvesting them would be leaf-harvest noise (SPEC §16). The
// set is curated, not exhaustive: an external function call we fail to exclude
// is a dead row (harmless), but a special operator we wrongly include is noise.
const SPECIAL_OPERATORS: ReadonlySet<string> = new Set([
    // CLHS special operators
    "block", "catch", "eval-when", "flet", "function", "go", "if", "labels",
    "let", "let*", "load-time-value", "locally", "macrolet", "multiple-value-call",
    "multiple-value-prog1", "progn", "progv", "quote", "return-from", "setq",
    "symbol-macrolet", "tagbody", "the", "throw", "unwind-protect",
    // Pervasive standard macros (binding / control / iteration / definition)
    "and", "or", "not", "when", "unless", "cond", "case", "ccase", "ecase",
    "typecase", "ctypecase", "etypecase", "loop", "do", "do*", "dolist",
    "dotimes", "lambda", "prog", "prog*", "prog1", "prog2", "return",
    "destructuring-bind", "multiple-value-bind", "multiple-value-setq",
    "setf", "psetf", "psetq", "incf", "decf", "push", "pushnew", "pop",
    "rotatef", "shiftf", "with-slots", "with-accessors", "with-open-file",
    "with-output-to-string", "with-input-from-string", "handler-case",
    "handler-bind", "restart-case", "restart-bind", "ignore-errors",
    "check-type", "assert", "declare", "declaim", "proclaim", "in-package",
    "defun", "defmacro", "defmethod", "defgeneric", "defvar", "defparameter",
    "defconstant", "defclass", "defstruct", "deftype", "defpackage", "defsetf",
    "define-condition", "define-symbol-macro", "define-compiler-macro",
]);

// Binding-introducing operators whose FIRST argument is a binding list
// (`((x 1) (y 2))` or, for flet/labels, `((f (a) ...) ...)`) — the heads of
// those sub-lists are binding names, never calls. When the body walk meets one
// of these we skip its binding sub-list outright so those heads never surface.
const BINDING_FORMS: ReadonlySet<string> = new Set([
    "let", "let*", "flet", "labels", "macrolet", "symbol-macrolet",
    "do", "do*", "prog", "prog*", "destructuring-bind", "multiple-value-bind",
    "with-slots", "with-accessors", "dolist", "dotimes", "do-symbols",
    "do-external-symbols", "do-all-symbols",
]);

// A call head must look like a function name: not a keyword (:foo), not a
// lambda-list marker (&body), not a quote/sharp form, not numeric, non-empty.
function isCallName(name: string): boolean {
    if (!name) return false;
    const c = name[0]!;
    if (c === ":" || c === "&" || c === "'" || c === "`" || c === "," || c === "#") return false;
    if (c === '"') return false;
    if (/^[+-]?[0-9.]/.test(name) && name !== "+" && name !== "-") return false;
    return true;
}

function collectCallRefs(src: string): MimeRef[] {
    const refs: MimeRef[] = [];
    const scanner = new Scanner(src);
    scanner.collectCallRefs(refs);
    refs.sort((a, b) => a.line - b.line || a.column - b.column);
    return refs;
}

// Scanner — minimal S-expression reader. Tracks position + line numbers.
// We don't care about expression VALUES — we care about the SHAPE: where
// each top-level form starts/ends and what its first two atoms are.
class Scanner {
    #src: string;
    #i = 0;
    #line = 1;

    constructor(src: string) {
        this.#src = src;
    }

    eof(): boolean {
        this.skipWhitespaceAndComments();
        return this.#i >= this.#src.length;
    }

    // 1-indexed (line, column) for a source index. Derived by counting from
    // the start of the line rather than the streaming #line so it is correct
    // for any index regardless of scan state.
    private posAt(index: number): { line: number; column: number } {
        let line = 1;
        let lineStart = 0;
        for (let i = 0; i < index && i < this.#src.length; i += 1) {
            if (this.#src[i] === "\n") {
                line += 1;
                lineStart = i + 1;
            }
        }
        return { line, column: index - lineStart + 1 };
    }

    // References walk (SPEC §16). Find every top-level (defun …)/(defmacro …),
    // then harvest call heads inside its body with container = the defun's
    // name. Other top-level forms are skipped wholesale — their bodies are not
    // joinable to a single emitted container.
    collectCallRefs(out: MimeRef[]): void {
        while (!this.eof()) {
            this.skipWhitespaceAndComments();
            if (this.#i >= this.#src.length) break;
            this.skipReaderMacroPrefix();
            if (this.#src[this.#i] !== "(") {
                this.skipAtom();
                continue;
            }
            this.#i += 1; // consume (
            const head = this.readNextAtomInList();
            if (head === "defun" || head === "defmacro") {
                const name = this.readNextAtomInList();
                // Skip the lambda-list, then harvest call heads in the body.
                this.skipNextForm();
                if (name) this.harvestCalls(name, out);
                else this.skipToMatchingClose();
            } else {
                this.skipToMatchingClose();
            }
        }
    }

    // Inside a (defun NAME (lambda-list) BODY...) — walk BODY, recording the
    // head of every list form that is a real call (not a special operator,
    // not a binding name). Stops at the defun's matching close paren.
    private harvestCalls(container: string, out: MimeRef[]): void {
        let depth = 1; // we are inside the defun's open paren
        while (this.#i < this.#src.length && depth > 0) {
            this.skipWhitespaceAndComments();
            const ch = this.#src[this.#i];
            if (ch === undefined) break;
            if (ch === ")") {
                depth -= 1;
                this.#i += 1;
                continue;
            }
            if (ch === '"') {
                this.skipString();
                continue;
            }
            if (ch === "'" || ch === "`" || ch === ",") {
                // Quoted data — opaque, harvest nothing inside it.
                this.skipReaderMacroPrefix();
                this.skipNextForm();
                continue;
            }
            if (ch === "#") {
                // #'fn is a function ref, not a call site; #(…), #+/#- etc.
                // are opaque data/directives. Consume the prefixed form.
                this.skipReaderMacroPrefix();
                if (this.#src[this.#i] === "(") { this.#i += 1; this.skipToMatchingClose(); }
                else this.skipAtom();
                continue;
            }
            if (ch === "(") {
                this.#i += 1; // consume (
                depth += 1;
                const headStart = this.#i;
                const headSkip = this.skipWhitespaceLeading();
                const innerCh = this.#src[this.#i];
                if (innerCh === "(" || innerCh === ")" || innerCh === undefined) continue;
                const head = this.readAtom();
                if (isCallName(head) && !SPECIAL_OPERATORS.has(head.toLowerCase())) {
                    const start = this.posAt(headStart + headSkip);
                    const end = this.posAt(this.#i - 1);
                    const ref: MimeRef = {
                        name: head,
                        kind: "call",
                        line: start.line,
                        column: start.column,
                        endLine: end.line,
                        endColumn: end.column + 1,
                        container,
                    };
                    out.push(ref);
                }
                if (BINDING_FORMS.has(head.toLowerCase())) {
                    // Skip the binding list so binding names aren't harvested
                    // as calls; the body after it is walked normally.
                    this.skipNextForm();
                }
                continue;
            }
            // A bare atom in argument position (variable read) — not a call.
            this.skipAtom();
        }
    }

    // Skip leading whitespace/comments WITHOUT consuming reader macros, and
    // report how many chars were skipped (so callers can recover the atom's
    // true start index).
    private skipWhitespaceLeading(): number {
        const before = this.#i;
        this.skipWhitespaceAndComments();
        return this.#i - before;
    }

    // Skip one whole form (atom or parenthesized list, with any reader-macro
    // prefix) at the current position.
    private skipNextForm(): void {
        this.skipWhitespaceAndComments();
        this.skipReaderMacroPrefix();
        this.skipWhitespaceAndComments();
        if (this.#src[this.#i] === "(") {
            this.#i += 1;
            this.skipToMatchingClose();
        } else if (this.#src[this.#i] === '"') {
            this.skipString();
        } else {
            this.skipAtom();
        }
    }

    readTopLevelForm(): FormSig | null {
        this.skipWhitespaceAndComments();
        if (this.#i >= this.#src.length) return null;

        const startLine = this.#line;
        // Top-level reader macros like #+feature (form ...) — we treat them
        // as the form's prefix: skip the #+/-feature directive, then read.
        this.skipReaderMacroPrefix();

        const ch = this.#src[this.#i];
        if (ch !== "(") {
            // A bare atom at top level (unusual). Skip it.
            this.skipAtom();
            return { head: "", secondAtom: null, line: startLine, endLine: this.#line, paramAtoms: [] };
        }

        // Open paren: read the head atom (or skip if a nested list comes
        // first), then collect the second atom and a parameter vector if
        // the third form is a list.
        this.#i += 1; // consume (

        const head = this.readNextAtomInList();
        const secondAtom = head !== "" ? this.readNextAtomInList() : null;
        const paramAtoms = this.tryReadParamList();
        this.skipToMatchingClose();
        const endLine = this.#line;
        return { head, secondAtom, line: startLine, endLine, paramAtoms };
    }

    // Read the next atom in the current list context. Stops at ')' or
    // before a nested '(' (returning ""). Consumes the atom on success.
    private readNextAtomInList(): string {
        this.skipWhitespaceAndCommentsAndReaderMacros();
        if (this.#i >= this.#src.length) return "";
        const ch = this.#src[this.#i];
        if (ch === ")" || ch === "(" || ch === undefined) return "";
        return this.readAtom();
    }

    // After the head + name, the next form is often a parameter list:
    //   (defun foo (a b c) body) — list of param atoms.
    // For defmethod: (defmethod foo ((x type) y) body) — params are mixed
    // typed/untyped specifiers; we emit each first element.
    // Returns [] if the next form isn't a list.
    private tryReadParamList(): string[] {
        this.skipWhitespaceAndCommentsAndReaderMacros();
        if (this.#src[this.#i] !== "(") return [];
        this.#i += 1; // consume (
        const params: string[] = [];
        // Common Lisp lambda-list keywords mark the boundary between
        // "real" required params and special collectors. We stop adding
        // params at the first `&` keyword so the outline shows only the
        // canonical positional names.
        let stopped = false;
        while (this.#i < this.#src.length) {
            this.skipWhitespaceAndCommentsAndReaderMacros();
            const ch = this.#src[this.#i];
            if (ch === ")" || ch === undefined) {
                if (ch === ")") this.#i += 1;
                break;
            }
            if (ch === "(") {
                this.#i += 1;
                const inner = this.readNextAtomInList();
                this.skipToMatchingClose();
                if (!stopped && inner && !inner.startsWith("&")) params.push(inner);
                continue;
            }
            const atom = this.readAtom();
            if (atom.startsWith("&")) {
                stopped = true;
                continue;
            }
            if (!stopped && atom) params.push(atom);
        }
        return params;
    }

    // Skip from current position to the matching close paren, tracking
    // nesting and string/comment context. Used after we've extracted what
    // we need from the head of a form.
    private skipToMatchingClose(): void {
        let depth = 1; // we're inside one open paren
        while (this.#i < this.#src.length && depth > 0) {
            this.skipWhitespaceAndCommentsAndReaderMacros();
            const ch = this.#src[this.#i];
            if (ch === undefined) break;
            if (ch === "(") {
                depth += 1;
                this.#i += 1;
            } else if (ch === ")") {
                depth -= 1;
                this.#i += 1;
            } else if (ch === '"') {
                this.skipString();
            } else {
                this.skipAtom();
            }
        }
    }

    private readAtom(): string {
        const start = this.#i;
        while (this.#i < this.#src.length) {
            const c = this.#src[this.#i]!;
            if (this.isAtomTerminator(c)) break;
            // Char literal #\x — consume the char and stop.
            if (c === "#" && this.#src[this.#i + 1] === "\\") {
                this.#i += 2;
                if (this.#i < this.#src.length) {
                    // Read named char (Space, Newline, etc.) — a span of letters.
                    while (this.#i < this.#src.length && /[A-Za-z0-9_-]/.test(this.#src[this.#i]!)) {
                        this.#i += 1;
                    }
                }
                continue;
            }
            // String mid-atom: shouldn't happen in well-formed code; bail.
            if (c === '"') break;
            this.#i += 1;
        }
        return this.#src.slice(start, this.#i);
    }

    private skipAtom(): void {
        this.readAtom();
    }

    private skipString(): void {
        if (this.#src[this.#i] !== '"') return;
        this.#i += 1; // consume opening
        while (this.#i < this.#src.length) {
            const c = this.#src[this.#i]!;
            if (c === "\\" && this.#i + 1 < this.#src.length) {
                if (this.#src[this.#i + 1] === "\n") this.#line += 1;
                this.#i += 2;
                continue;
            }
            if (c === '"') {
                this.#i += 1;
                return;
            }
            if (c === "\n") this.#line += 1;
            this.#i += 1;
        }
    }

    private skipWhitespaceAndComments(): void {
        while (this.#i < this.#src.length) {
            const c = this.#src[this.#i]!;
            if (c === " " || c === "\t" || c === "\r") {
                this.#i += 1;
            } else if (c === "\n") {
                this.#line += 1;
                this.#i += 1;
            } else if (c === ";") {
                while (this.#i < this.#src.length && this.#src[this.#i] !== "\n") this.#i += 1;
            } else if (c === "#" && this.#src[this.#i + 1] === "|") {
                this.skipBlockComment();
            } else {
                return;
            }
        }
    }

    private skipWhitespaceAndCommentsAndReaderMacros(): void {
        for (;;) {
            const before = this.#i;
            this.skipWhitespaceAndComments();
            this.skipReaderMacroPrefix();
            if (this.#i === before) return;
        }
    }

    // Skip reader macros that PREFIX a form, not consume the form itself:
    //   ' ` , ,@ #' #+feat #-feat #. #s(...)
    // For #+/-feature we consume the feature expression (an atom or a
    // parenthesized expression).
    private skipReaderMacroPrefix(): void {
        const c = this.#src[this.#i];
        if (c === "'" || c === "`") {
            this.#i += 1;
            return;
        }
        if (c === ",") {
            this.#i += 1;
            if (this.#src[this.#i] === "@") this.#i += 1;
            return;
        }
        if (c === "#") {
            const n = this.#src[this.#i + 1];
            if (n === "'" || n === "." || n === ":") {
                this.#i += 2;
                return;
            }
            if (n === "+" || n === "-") {
                this.#i += 2;
                this.skipWhitespaceAndComments();
                // Skip the feature expression (atom or parenthesized).
                if (this.#src[this.#i] === "(") {
                    this.#i += 1;
                    this.skipToMatchingClose();
                } else {
                    this.skipAtom();
                }
                return;
            }
            if (n === "(") {
                // #( vector literal — leave the '(' for the caller.
                this.#i += 1;
                return;
            }
            // Other dispatch: best-effort consume the # and let caller
            // handle the rest.
        }
    }

    private skipBlockComment(): void {
        // Already at #|. Consume and find matching |# (nested-aware).
        this.#i += 2;
        let depth = 1;
        while (this.#i < this.#src.length && depth > 0) {
            const c = this.#src[this.#i]!;
            if (c === "#" && this.#src[this.#i + 1] === "|") {
                depth += 1;
                this.#i += 2;
            } else if (c === "|" && this.#src[this.#i + 1] === "#") {
                depth -= 1;
                this.#i += 2;
            } else {
                if (c === "\n") this.#line += 1;
                this.#i += 1;
            }
        }
    }

    private isAtomTerminator(c: string): boolean {
        return c === " " || c === "\t" || c === "\r" || c === "\n"
            || c === "(" || c === ")" || c === ";";
    }
}
