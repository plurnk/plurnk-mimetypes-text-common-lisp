import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeSymbol, SymbolKind } from "@plurnk/plurnk-mimetypes";

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
