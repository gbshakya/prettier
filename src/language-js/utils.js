"use strict";

const isIdentifierName = require("esutils").keyword.isIdentifierNameES5;
const {
  getLast,
  hasNewline,
  hasNewlineInRange,
  skipWhitespace,
} = require("../common/util");
const { locStart, locEnd, hasSameLocStart } = require("./loc");

/**
 * @typedef {import("./types/estree").Node} Node
 * @typedef {import("./types/estree").TemplateLiteral} TemplateLiteral
 * @typedef {import("./types/estree").Comment} Comment
 * @typedef {import("./types/estree").MemberExpression} MemberExpression
 * @typedef {import("./types/estree").OptionalMemberExpression} OptionalMemberExpression
 * @typedef {import("./types/estree").CallExpression} CallExpression
 * @typedef {import("./types/estree").OptionalCallExpression} OptionalCallExpression
 * @typedef {import("./types/estree").Expression} Expression
 * @typedef {import("./types/estree").Property} Property
 * @typedef {import("./types/estree").ObjectTypeProperty} ObjectTypeProperty
 * @typedef {import("./types/estree").JSXElement} JSXElement
 * @typedef {import("./types/estree").TaggedTemplateExpression} TaggedTemplateExpression
 * @typedef {import("./types/estree").Literal} Literal
 *
 * @typedef {import("../common/fast-path")} FastPath
 */

// We match any whitespace except line terminators because
// Flow annotation comments cannot be split across lines. For example:
//
// (this /*
// : any */).foo = 5;
//
// is not picked up by Flow (see https://github.com/facebook/flow/issues/7050), so
// removing the newline would create a type annotation that the user did not intend
// to create.
const NON_LINE_TERMINATING_WHITE_SPACE = "(?:(?=.)\\s)";
const FLOW_SHORTHAND_ANNOTATION = new RegExp(
  `^${NON_LINE_TERMINATING_WHITE_SPACE}*:`
);
const FLOW_ANNOTATION = new RegExp(`^${NON_LINE_TERMINATING_WHITE_SPACE}*::`);

/**
 * @param {Node} node
 * @returns {boolean}
 */
function hasFlowShorthandAnnotationComment(node) {
  // https://flow.org/en/docs/types/comments/
  // Syntax example: const r = new (window.Request /*: Class<Request> */)("");

  return (
    node.extra &&
    node.extra.parenthesized &&
    node.trailingComments &&
    isBlockComment(node.trailingComments[0]) &&
    FLOW_SHORTHAND_ANNOTATION.test(node.trailingComments[0].value)
  );
}

/**
 * @param {Comment[]} comments
 * @returns {boolean}
 */
function hasFlowAnnotationComment(comments) {
  return (
    comments &&
    isBlockComment(comments[0]) &&
    FLOW_ANNOTATION.test(comments[0].value)
  );
}

/**
 * @param {Node} node
 * @param {(Node) => boolean} fn
 * @returns {boolean}
 */
function hasNode(node, fn) {
  if (!node || typeof node !== "object") {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((value) => hasNode(value, fn));
  }
  const result = fn(node);
  return typeof result === "boolean"
    ? result
    : Object.keys(node).some((key) => hasNode(node[key], fn));
}

/**
 * @param {Node} node
 * @returns {boolean}
 */
function hasNakedLeftSide(node) {
  return (
    node.type === "AssignmentExpression" ||
    node.type === "BinaryExpression" ||
    node.type === "LogicalExpression" ||
    node.type === "NGPipeExpression" ||
    node.type === "ConditionalExpression" ||
    node.type === "CallExpression" ||
    node.type === "OptionalCallExpression" ||
    node.type === "MemberExpression" ||
    node.type === "OptionalMemberExpression" ||
    node.type === "SequenceExpression" ||
    node.type === "TaggedTemplateExpression" ||
    node.type === "BindExpression" ||
    (node.type === "UpdateExpression" && !node.prefix) ||
    node.type === "TSAsExpression" ||
    node.type === "TSNonNullExpression"
  );
}

function getLeftSide(node) {
  if (node.expressions) {
    return node.expressions[0];
  }
  return (
    node.left ||
    node.test ||
    node.callee ||
    node.object ||
    node.tag ||
    node.argument ||
    node.expression
  );
}

function getLeftSidePathName(path, node) {
  if (node.expressions) {
    return ["expressions", 0];
  }
  if (node.left) {
    return ["left"];
  }
  if (node.test) {
    return ["test"];
  }
  if (node.object) {
    return ["object"];
  }
  if (node.callee) {
    return ["callee"];
  }
  if (node.tag) {
    return ["tag"];
  }
  if (node.argument) {
    return ["argument"];
  }
  if (node.expression) {
    return ["expression"];
  }
  throw new Error("Unexpected node has no left side.");
}

/**
 * @param {Comment} comment
 * @returns {boolean}
 */
function isBlockComment(comment) {
  return (
    comment.type === "Block" ||
    comment.type === "CommentBlock" ||
    // `meriyah`
    comment.type === "MultiLine"
  );
}

/**
 * @param {Comment} comment
 * @returns {boolean}
 */
function isLineComment(comment) {
  return (
    comment.type === "Line" ||
    comment.type === "CommentLine" ||
    // `meriyah` has `SingleLine`, `HashbangComment`, `HTMLOpen`, and `HTMLClose`
    comment.type === "SingleLine" ||
    comment.type === "HashbangComment" ||
    comment.type === "HTMLOpen" ||
    comment.type === "HTMLClose"
  );
}

const exportDeclarationTypes = new Set([
  "ExportDefaultDeclaration",
  "ExportDefaultSpecifier",
  "DeclareExportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
]);

/**
 * @param {Node} node
 * @returns {boolean}
 */
function isExportDeclaration(node) {
  return node && exportDeclarationTypes.has(node.type);
}

/**
 * @param {FastPath} path
 * @returns {Node | null}
 */
function getParentExportDeclaration(path) {
  const parentNode = path.getParentNode();
  if (path.getName() === "declaration" && isExportDeclaration(parentNode)) {
    return parentNode;
  }

  return null;
}

/**
 * @param {Node} node
 * @returns {boolean}
 */
function isLiteral(node) {
  return (
    node.type === "BooleanLiteral" ||
    node.type === "DirectiveLiteral" ||
    node.type === "Literal" ||
    node.type === "NullLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "BigIntLiteral" ||
    node.type === "DecimalLiteral" ||
    node.type === "RegExpLiteral" ||
    node.type === "StringLiteral" ||
    node.type === "TemplateLiteral" ||
    node.type === "TSTypeLiteral" ||
    node.type === "JSXText"
  );
}

/**
 * @param {Node} node
 * @returns {boolean}
 */
function isNumericLiteral(node) {
  return (
    node.type === "NumericLiteral" ||
    (node.type === "Literal" && typeof node.value === "number")
  );
}

/**
 * @param {Node} node
 * @returns {boolean}
 */
function isStringLiteral(node) {
  return (
    node.type === "StringLiteral" ||
    (node.type === "Literal" && typeof node.value === "string")
  );
}

/**
 * @param {Node} node
 * @returns {boolean}
 */
function isObjectType(node) {
  return node.type === "ObjectTypeAnnotation" || node.type === "TSTypeLiteral";
}

/**
 * @param {Node} node
 * @returns {boolean}
 */
function isFunctionOrArrowExpression(node) {
  return (
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/**
 * @param {Node} node
 * @returns {boolean}
 */
function isFunctionOrArrowExpressionWithBody(node) {
  return (
    node.type === "FunctionExpression" ||
    (node.type === "ArrowFunctionExpression" &&
      node.body.type === "BlockStatement")
  );
}

/**
 * @param {Node} node
 * @returns {boolean}
 */
function isTemplateLiteral(node) {
  return node.type === "TemplateLiteral";
}

/**
 * Note: `inject` is used in AngularJS 1.x, `async` in Angular 2+
 * example: https://docs.angularjs.org/guide/unit-testing#using-beforeall-
 *
 * @param {Node} node
 * @returns {boolean}
 */
function isAngularTestWrapper(node) {
  return (
    (node.type === "CallExpression" ||
      node.type === "OptionalCallExpression") &&
    node.callee.type === "Identifier" &&
    (node.callee.name === "async" ||
      node.callee.name === "inject" ||
      node.callee.name === "fakeAsync")
  );
}

/**
 * @param {Node} node
 * @returns {boolean}
 */
function isJsxNode(node) {
  return node.type === "JSXElement" || node.type === "JSXFragment";
}

function isTheOnlyJsxElementInMarkdown(options, path) {
  if (options.parentParser !== "markdown" && options.parentParser !== "mdx") {
    return false;
  }

  const node = path.getNode();

  if (!node.expression || !isJsxNode(node.expression)) {
    return false;
  }

  const parent = path.getParentNode();

  return parent.type === "Program" && parent.body.length === 1;
}

// Detect an expression node representing `{" "}`
function isJsxWhitespaceExpression(node) {
  return (
    node.type === "JSXExpressionContainer" &&
    isLiteral(node.expression) &&
    node.expression.value === " " &&
    !hasComment(node.expression)
  );
}

/**
 * @param {Node} node
 * @returns {boolean}
 */
function isMemberExpressionChain(node) {
  if (
    node.type !== "MemberExpression" &&
    node.type !== "OptionalMemberExpression"
  ) {
    return false;
  }
  if (node.object.type === "Identifier") {
    return true;
  }
  return isMemberExpressionChain(node.object);
}

function isGetterOrSetter(node) {
  return node.kind === "get" || node.kind === "set";
}

// TODO: This is a bad hack and we need a better way to distinguish between
// arrow functions and otherwise
function isFunctionNotation(node) {
  return isGetterOrSetter(node) || hasSameLocStart(node, node.value);
}

// Hack to differentiate between the following two which have the same ast
// type T = { method: () => void };
// type T = { method(): void };
/**
 * @param {Node} node
 * @returns {boolean}
 */
function isObjectTypePropertyAFunction(node) {
  return (
    (node.type === "ObjectTypeProperty" ||
      node.type === "ObjectTypeInternalSlot") &&
    node.value.type === "FunctionTypeAnnotation" &&
    !node.static &&
    !isFunctionNotation(node)
  );
}

// Hack to differentiate between the following two which have the same ast
// declare function f(a): void;
// var f: (a) => void;
function isTypeAnnotationAFunction(node) {
  return (
    (node.type === "TypeAnnotation" || node.type === "TSTypeAnnotation") &&
    node.typeAnnotation.type === "FunctionTypeAnnotation" &&
    !node.static &&
    !hasSameLocStart(node, node.typeAnnotation)
  );
}

const binaryishNodeTypes = new Set([
  "BinaryExpression",
  "LogicalExpression",
  "NGPipeExpression",
]);

/**
 * @param {Node} node
 * @returns {boolean}
 */
function isBinaryish(node) {
  return binaryishNodeTypes.has(node.type);
}

/**
 * @param {Node} node
 * @returns {boolean}
 */
function isMemberish(node) {
  return (
    node.type === "MemberExpression" ||
    node.type === "OptionalMemberExpression" ||
    (node.type === "BindExpression" && Boolean(node.object))
  );
}

const simpleTypeAnnotations = new Set([
  // `any`
  "AnyTypeAnnotation",
  "TSAnyKeyword",
  // `null`
  "NullLiteralTypeAnnotation",
  "TSNullKeyword",
  // `this`
  "ThisTypeAnnotation",
  "TSThisType",
  // `number`
  "NumberTypeAnnotation",
  "TSNumberKeyword",
  // `void`
  "VoidTypeAnnotation",
  "TSVoidKeyword",
  // `boolean`
  "BooleanTypeAnnotation",
  "TSBooleanKeyword",
  // `bigint`
  "BigIntTypeAnnotation",
  "TSBigIntKeyword",
  // `symbol`
  "SymbolTypeAnnotation",
  "TSSymbolKeyword",
  // `string`
  "StringTypeAnnotation",
  "TSStringKeyword",
  // literals
  "BooleanLiteralTypeAnnotation",
  "StringLiteralTypeAnnotation",
  "BigIntLiteralTypeAnnotation",
  "NumberLiteralTypeAnnotation",
  "TSLiteralType",
  "TSTemplateLiteralType",
  // flow only, `empty`, `mixed`
  "EmptyTypeAnnotation",
  "MixedTypeAnnotation",
  // typescript only, `never`, `object`, `undefined`, `unknown`
  "TSNeverKeyword",
  "TSObjectKeyword",
  "TSUndefinedKeyword",
  "TSUnknownKeyword",
]);
/**
 * @param {Node} node
 * @returns {boolean}
 */
function isSimpleType(node) {
  if (!node) {
    return false;
  }

  if (
    (node.type === "GenericTypeAnnotation" ||
      node.type === "TSTypeReference") &&
    !node.typeParameters
  ) {
    return true;
  }

  if (simpleTypeAnnotations.has(node.type)) {
    return true;
  }

  return false;
}

const unitTestRe = /^(skip|[fx]?(it|describe|test))$/;

/**
 * @param {CallExpression} node
 * @returns {boolean}
 */
function isSkipOrOnlyBlock(node) {
  return (
    (node.callee.type === "MemberExpression" ||
      node.callee.type === "OptionalMemberExpression") &&
    node.callee.object.type === "Identifier" &&
    node.callee.property.type === "Identifier" &&
    unitTestRe.test(node.callee.object.name) &&
    (node.callee.property.name === "only" ||
      node.callee.property.name === "skip")
  );
}

/**
 * @param {CallExpression} node
 * @returns {boolean}
 */
function isUnitTestSetUp(node) {
  const unitTestSetUpRe = /^(before|after)(Each|All)$/;
  return (
    node.callee.type === "Identifier" &&
    unitTestSetUpRe.test(node.callee.name) &&
    node.arguments.length === 1
  );
}

// eg; `describe("some string", (done) => {})`
function isTestCall(n, parent) {
  if (n.type !== "CallExpression") {
    return false;
  }
  if (n.arguments.length === 1) {
    if (isAngularTestWrapper(n) && parent && isTestCall(parent)) {
      return isFunctionOrArrowExpression(n.arguments[0]);
    }

    if (isUnitTestSetUp(n)) {
      return isAngularTestWrapper(n.arguments[0]);
    }
  } else if (n.arguments.length === 2 || n.arguments.length === 3) {
    if (
      ((n.callee.type === "Identifier" && unitTestRe.test(n.callee.name)) ||
        isSkipOrOnlyBlock(n)) &&
      (isTemplateLiteral(n.arguments[0]) || isStringLiteral(n.arguments[0]))
    ) {
      // it("name", () => { ... }, 2500)
      if (n.arguments[2] && !isNumericLiteral(n.arguments[2])) {
        return false;
      }
      return (
        (n.arguments.length === 2
          ? isFunctionOrArrowExpression(n.arguments[1])
          : isFunctionOrArrowExpressionWithBody(n.arguments[1]) &&
            getFunctionParameters(n.arguments[1]).length <= 1) ||
        isAngularTestWrapper(n.arguments[1])
      );
    }
  }
  return false;
}

/**
 * @param {CallExpression | OptionalCallExpression} node
 * @returns {boolean}
 */
function isCallOrOptionalCallExpression(node) {
  return (
    node.type === "CallExpression" || node.type === "OptionalCallExpression"
  );
}

/**
 *
 * @param {any} node
 * @returns {boolean}
 */
function isSimpleTemplateLiteral(node) {
  let expressionsKey = "expressions";
  if (node.type === "TSTemplateLiteralType") {
    expressionsKey = "types";
  }
  const expressions = node[expressionsKey];

  if (expressions.length === 0) {
    return false;
  }

  return expressions.every((expr) => {
    // Disallow comments since printDocToString can't print them here
    if (hasComment(expr)) {
      return false;
    }

    // Allow `x` and `this`
    if (expr.type === "Identifier" || expr.type === "ThisExpression") {
      return true;
    }

    // Allow `a.b.c`, `a.b[c]`, and `this.x.y`
    if (
      expr.type === "MemberExpression" ||
      expr.type === "OptionalMemberExpression"
    ) {
      let head = expr;
      while (
        head.type === "MemberExpression" ||
        head.type === "OptionalMemberExpression"
      ) {
        if (
          head.property.type !== "Identifier" &&
          head.property.type !== "Literal" &&
          head.property.type !== "StringLiteral" &&
          head.property.type !== "NumericLiteral"
        ) {
          return false;
        }
        head = head.object;
        if (hasComment(head)) {
          return false;
        }
      }

      if (head.type === "Identifier" || head.type === "ThisExpression") {
        return true;
      }

      return false;
    }

    return false;
  });
}

/**
 * @param {FastPath} path
 * @returns {boolean}
 */
function classPropMayCauseASIProblems(path) {
  const node = path.getNode();

  if (node.type !== "ClassProperty" && node.type !== "FieldDefinition") {
    return false;
  }

  const name = node.key && node.key.name;

  // this isn't actually possible yet with most parsers available today
  // so isn't properly tested yet.
  if (
    (name === "static" || name === "get" || name === "set") &&
    !node.value &&
    !node.typeAnnotation
  ) {
    return true;
  }
}

function classChildNeedsASIProtection(node) {
  if (!node) {
    return;
  }

  if (
    node.static ||
    node.accessibility // TypeScript
  ) {
    return false;
  }

  if (!node.computed) {
    const name = node.key && node.key.name;
    if (name === "in" || name === "instanceof") {
      return true;
    }
  }
  switch (node.type) {
    case "ClassProperty":
    case "FieldDefinition":
    case "TSAbstractClassProperty":
      return node.computed;
    case "MethodDefinition": // Flow
    case "TSAbstractMethodDefinition": // TypeScript
    case "ClassMethod":
    case "ClassPrivateMethod": {
      // Babel
      const isAsync = node.value ? node.value.async : node.async;
      const isGenerator = node.value ? node.value.generator : node.generator;
      if (isAsync || node.kind === "get" || node.kind === "set") {
        return false;
      }
      if (node.computed || isGenerator) {
        return true;
      }
      return false;
    }
    case "TSIndexSignature":
      return true;
    default:
      /* istanbul ignore next */
      return false;
  }
}

/**
 * @param {string} tokenNode
 * @param {string} keyword
 * @returns {string}
 */
function getTypeScriptMappedTypeModifier(tokenNode, keyword) {
  if (tokenNode === "+") {
    return "+" + keyword;
  } else if (tokenNode === "-") {
    return "-" + keyword;
  }
  return keyword;
}

function hasNewlineBetweenOrAfterDecorators(node, options) {
  return (
    hasNewlineInRange(
      options.originalText,
      locStart(node.decorators[0]),
      locEnd(getLast(node.decorators))
    ) || hasNewline(options.originalText, locEnd(getLast(node.decorators)))
  );
}

// Only space, newline, carriage return, and tab are treated as whitespace
// inside JSX.
const jsxWhitespaceChars = " \n\r\t";
const matchJsxWhitespaceRegex = new RegExp("([" + jsxWhitespaceChars + "]+)");
const containsNonJsxWhitespaceRegex = new RegExp(
  "[^" + jsxWhitespaceChars + "]"
);
const trimJsxWhitespace = (text) =>
  text.replace(
    new RegExp(
      "(?:^" +
        matchJsxWhitespaceRegex.source +
        "|" +
        matchJsxWhitespaceRegex.source +
        "$)"
    ),
    ""
  );

// Meaningful if it contains non-whitespace characters,
// or it contains whitespace without a new line.
/**
 * @param {Node} node
 * @returns {boolean}
 */
function isMeaningfulJsxText(node) {
  return (
    isLiteral(node) &&
    (containsNonJsxWhitespaceRegex.test(rawText(node)) ||
      !/\n/.test(rawText(node)))
  );
}

/**
 * @param {FastPath} path
 * @returns {boolean}
 */
function hasJsxIgnoreComment(path) {
  const node = path.getValue();
  const parent = path.getParentNode();
  if (!parent || !node || !isJsxNode(node) || !isJsxNode(parent)) {
    return false;
  }

  // Lookup the previous sibling, ignoring any empty JSXText elements
  const index = parent.children.indexOf(node);
  let prevSibling = null;
  for (let i = index; i > 0; i--) {
    const candidate = parent.children[i - 1];
    if (candidate.type === "JSXText" && !isMeaningfulJsxText(candidate)) {
      continue;
    }
    prevSibling = candidate;
    break;
  }

  return (
    prevSibling &&
    prevSibling.type === "JSXExpressionContainer" &&
    prevSibling.expression.type === "JSXEmptyExpression" &&
    hasNodeIgnoreComment(prevSibling.expression)
  );
}

/**
 * @param {JSXElement} node
 * @returns {boolean}
 */
function isEmptyJsxElement(node) {
  if (node.children.length === 0) {
    return true;
  }
  if (node.children.length > 1) {
    return false;
  }

  // if there is one text child and does not contain any meaningful text
  // we can treat the element as empty.
  const child = node.children[0];
  return isLiteral(child) && !isMeaningfulJsxText(child);
}

/**
 * @param {FastPath} path
 * @returns {boolean}
 */
function hasPrettierIgnore(path) {
  return hasIgnoreComment(path) || hasJsxIgnoreComment(path);
}

/**
 * @param {FastPath} path
 * @returns {boolean}
 */
function isLastStatement(path) {
  const parent = path.getParentNode();
  if (!parent) {
    return true;
  }
  const node = path.getValue();
  const body = (parent.body || parent.consequent).filter(
    (stmt) => stmt.type !== "EmptyStatement"
  );
  return body[body.length - 1] === node;
}

/**
 * @param {string} text
 * @param {Node} typeAnnotation
 * @returns {boolean}
 */
function isFlowAnnotationComment(text, typeAnnotation) {
  const start = locStart(typeAnnotation);
  const end = skipWhitespace(text, locEnd(typeAnnotation));
  return (
    end !== false &&
    text.slice(start, start + 2) === "/*" &&
    text.slice(end, end + 2) === "*/"
  );
}

/**
 * @param {string} text
 * @param {Node} node
 * @returns {boolean}
 */
function hasLeadingOwnLineComment(text, node) {
  if (isJsxNode(node)) {
    return hasNodeIgnoreComment(node);
  }

  return hasComment(node, CommentCheckFlags.Leading, (comment) =>
    hasNewline(text, locEnd(comment))
  );
}

// This recurses the return argument, looking for the first token
// (the leftmost leaf node) and, if it (or its parents) has any
// leadingComments, returns true (so it can be wrapped in parens).
function returnArgumentHasLeadingComment(options, argument) {
  if (hasLeadingOwnLineComment(options.originalText, argument)) {
    return true;
  }

  if (hasNakedLeftSide(argument)) {
    let leftMost = argument;
    let newLeftMost;
    while ((newLeftMost = getLeftSide(leftMost))) {
      leftMost = newLeftMost;

      if (hasLeadingOwnLineComment(options.originalText, leftMost)) {
        return true;
      }
    }
  }

  return false;
}

// Note: Quoting/unquoting numbers in TypeScript is not safe.
//
// let a = { 1: 1, 2: 2 }
// let b = { '1': 1, '2': 2 }
//
// declare let aa: keyof typeof a;
// declare let bb: keyof typeof b;
//
// aa = bb;
// ^^
// Type '"1" | "2"' is not assignable to type '1 | 2'.
//   Type '"1"' is not assignable to type '1 | 2'.(2322)
//
// And in Flow, you get:
//
// const x = {
//   0: 1
//   ^ Non-string literal property keys not supported. [unsupported-syntax]
// }
//
// Angular does not support unquoted numbers in expressions.
//
// So we play it safe and only unquote numbers for the JavaScript parsers.
// (Vue supports unquoted numbers in expressions, but let’s keep it simple.)
//
// Identifiers can be unquoted in more circumstances, though.
function isStringPropSafeToUnquote(node, options) {
  return (
    options.parser !== "json" &&
    isStringLiteral(node.key) &&
    rawText(node.key).slice(1, -1) === node.key.value &&
    ((isIdentifierName(node.key.value) &&
      // With `--strictPropertyInitialization`, TS treats properties with quoted names differently than unquoted ones.
      // See https://github.com/microsoft/TypeScript/pull/20075
      !(
        (options.parser === "typescript" || options.parser === "babel-ts") &&
        node.type === "ClassProperty"
      )) ||
      (isSimpleNumber(node.key.value) &&
        String(Number(node.key.value)) === node.key.value &&
        (options.parser === "babel" ||
          options.parser === "espree" ||
          options.parser === "meriyah")))
  );
}

// Matches “simple” numbers like `123` and `2.5` but not `1_000`, `1e+100` or `0b10`.
function isSimpleNumber(numberString) {
  return /^(\d+|\d+\.\d+)$/.test(numberString);
}

/**
 * @param {Node} node
 * @param {Node} parentNode
 * @returns {boolean}
 */
function isJestEachTemplateLiteral(node, parentNode) {
  /**
   * describe.each`table`(name, fn)
   * describe.only.each`table`(name, fn)
   * describe.skip.each`table`(name, fn)
   * test.each`table`(name, fn)
   * test.only.each`table`(name, fn)
   * test.skip.each`table`(name, fn)
   *
   * Ref: https://github.com/facebook/jest/pull/6102
   */
  const jestEachTriggerRegex = /^[fx]?(describe|it|test)$/;
  return (
    parentNode.type === "TaggedTemplateExpression" &&
    parentNode.quasi === node &&
    parentNode.tag.type === "MemberExpression" &&
    parentNode.tag.property.type === "Identifier" &&
    parentNode.tag.property.name === "each" &&
    ((parentNode.tag.object.type === "Identifier" &&
      jestEachTriggerRegex.test(parentNode.tag.object.name)) ||
      (parentNode.tag.object.type === "MemberExpression" &&
        parentNode.tag.object.property.type === "Identifier" &&
        (parentNode.tag.object.property.name === "only" ||
          parentNode.tag.object.property.name === "skip") &&
        parentNode.tag.object.object.type === "Identifier" &&
        jestEachTriggerRegex.test(parentNode.tag.object.object.name)))
  );
}

/**
 * @param {TemplateLiteral} template
 * @returns {boolean}
 */
function templateLiteralHasNewLines(template) {
  return template.quasis.some((quasi) => quasi.value.raw.includes("\n"));
}

/**
 * @param {TemplateLiteral | TaggedTemplateExpression} n
 * @param {string} text
 * @returns {boolean}
 */
function isTemplateOnItsOwnLine(n, text) {
  return (
    ((n.type === "TemplateLiteral" && templateLiteralHasNewLines(n)) ||
      (n.type === "TaggedTemplateExpression" &&
        templateLiteralHasNewLines(n.quasi))) &&
    !hasNewline(text, locStart(n), { backwards: true })
  );
}

/**
 * @param {Node} node
 * @returns {boolean}
 */
function needsHardlineAfterDanglingComment(node) {
  if (!hasComment(node)) {
    return false;
  }
  const lastDanglingComment = getLast(
    getComments(node, CommentCheckFlags.Dangling)
  );
  return lastDanglingComment && !isBlockComment(lastDanglingComment);
}

// Logic to check for args with multiple anonymous functions. For instance,
// the following call should be split on multiple lines for readability:
// source.pipe(map((x) => x + x), filter((x) => x % 2 === 0))
function isFunctionCompositionArgs(args) {
  if (args.length <= 1) {
    return false;
  }
  let count = 0;
  for (const arg of args) {
    if (arg) {
      if (isFunctionOrArrowExpression(arg)) {
        count += 1;
        if (count > 1) {
          return true;
        }
      } else if (isCallOrOptionalCallExpression(arg)) {
        for (const childArg of arg.arguments) {
          if (isFunctionOrArrowExpression(childArg)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

// Logic to determine if a call is a “long curried function call”.
// See https://github.com/prettier/prettier/issues/1420.
//
// `connect(a, b, c)(d)`
// In the above call expression, the second call is the parent node and the
// first call is the current node.
/**
 * @param {FastPath} path
 * @returns {boolean}
 */
function isLongCurriedCallExpression(path) {
  const node = path.getValue();
  const parent = path.getParentNode();
  return (
    isCallOrOptionalCallExpression(node) &&
    isCallOrOptionalCallExpression(parent) &&
    parent.callee === node &&
    node.arguments.length > parent.arguments.length &&
    parent.arguments.length > 0
  );
}

/**
 * @param {any} node
 * @param {number} depth
 * @returns {boolean}
 */
function isSimpleCallArgument(node, depth) {
  if (depth >= 2) {
    return false;
  }

  const isChildSimple = (child) => isSimpleCallArgument(child, depth + 1);

  const regexpPattern =
    (node.type === "Literal" && "regex" in node && node.regex.pattern) ||
    (node.type === "RegExpLiteral" && node.pattern);

  if (regexpPattern && regexpPattern.length > 5) {
    return false;
  }

  if (
    node.type === "Literal" ||
    node.type === "BigIntLiteral" ||
    node.type === "DecimalLiteral" ||
    node.type === "BooleanLiteral" ||
    node.type === "NullLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "RegExpLiteral" ||
    node.type === "StringLiteral" ||
    node.type === "Identifier" ||
    node.type === "ThisExpression" ||
    node.type === "Super" ||
    node.type === "PrivateName" ||
    node.type === "ArgumentPlaceholder" ||
    node.type === "Import"
  ) {
    return true;
  }

  if (node.type === "TemplateLiteral") {
    return node.expressions.every(isChildSimple);
  }

  if (node.type === "ObjectExpression") {
    return node.properties.every(
      (p) => !p.computed && (p.shorthand || (p.value && isChildSimple(p.value)))
    );
  }

  if (node.type === "ArrayExpression") {
    return node.elements.every((x) => x === null || isChildSimple(x));
  }

  if (node.type === "ImportExpression") {
    return isChildSimple(node.source);
  }

  if (
    node.type === "CallExpression" ||
    node.type === "OptionalCallExpression" ||
    node.type === "NewExpression"
  ) {
    return (
      isSimpleCallArgument(node.callee, depth) &&
      node.arguments.every(isChildSimple)
    );
  }

  if (
    node.type === "MemberExpression" ||
    node.type === "OptionalMemberExpression"
  ) {
    return (
      isSimpleCallArgument(node.object, depth) &&
      isSimpleCallArgument(node.property, depth)
    );
  }

  if (
    node.type === "UnaryExpression" &&
    (node.operator === "!" || node.operator === "-")
  ) {
    return isSimpleCallArgument(node.argument, depth);
  }

  if (node.type === "TSNonNullExpression") {
    return isSimpleCallArgument(node.expression, depth);
  }

  return false;
}

function rawText(node) {
  return node.extra ? node.extra.raw : node.raw;
}

function identity(x) {
  return x;
}

function isTSXFile(options) {
  return options.filepath && /\.tsx$/i.test(options.filepath);
}

/**
 * @param {any} options
 * @param {("es5" | "all")} [level]
 * @returns {boolean}
 */
function shouldPrintComma(options, level = "es5") {
  return (
    (options.trailingComma === "es5" && level === "es5") ||
    (options.trailingComma === "all" && (level === "all" || level === "es5"))
  );
}

/**
 * Tests if an expression starts with `{`, or (if forbidFunctionClassAndDoExpr
 * holds) `function`, `class`, or `do {}`. Will be overzealous if there's
 * already necessary grouping parentheses.
 *
 * @param {Node} node
 * @param {boolean} forbidFunctionClassAndDoExpr
 * @returns {boolean}
 */
function startsWithNoLookaheadToken(node, forbidFunctionClassAndDoExpr) {
  node = getLeftMost(node);
  switch (node.type) {
    case "FunctionExpression":
    case "ClassExpression":
    case "DoExpression":
      return forbidFunctionClassAndDoExpr;
    case "ObjectExpression":
      return true;
    case "MemberExpression":
    case "OptionalMemberExpression":
      return startsWithNoLookaheadToken(
        node.object,
        forbidFunctionClassAndDoExpr
      );
    case "TaggedTemplateExpression":
      if (node.tag.type === "FunctionExpression") {
        // IIFEs are always already parenthesized
        return false;
      }
      return startsWithNoLookaheadToken(node.tag, forbidFunctionClassAndDoExpr);
    case "CallExpression":
    case "OptionalCallExpression":
      if (node.callee.type === "FunctionExpression") {
        // IIFEs are always already parenthesized
        return false;
      }
      return startsWithNoLookaheadToken(
        node.callee,
        forbidFunctionClassAndDoExpr
      );
    case "ConditionalExpression":
      return startsWithNoLookaheadToken(
        node.test,
        forbidFunctionClassAndDoExpr
      );
    case "UpdateExpression":
      return (
        !node.prefix &&
        startsWithNoLookaheadToken(node.argument, forbidFunctionClassAndDoExpr)
      );
    case "BindExpression":
      return (
        node.object &&
        startsWithNoLookaheadToken(node.object, forbidFunctionClassAndDoExpr)
      );
    case "SequenceExpression":
      return startsWithNoLookaheadToken(
        node.expressions[0],
        forbidFunctionClassAndDoExpr
      );
    case "TSAsExpression":
      return startsWithNoLookaheadToken(
        node.expression,
        forbidFunctionClassAndDoExpr
      );
    default:
      return false;
  }
}

const equalityOperators = {
  "==": true,
  "!=": true,
  "===": true,
  "!==": true,
};
const multiplicativeOperators = {
  "*": true,
  "/": true,
  "%": true,
};
const bitshiftOperators = {
  ">>": true,
  ">>>": true,
  "<<": true,
};

function shouldFlatten(parentOp, nodeOp) {
  if (getPrecedence(nodeOp) !== getPrecedence(parentOp)) {
    return false;
  }

  // ** is right-associative
  // x ** y ** z --> x ** (y ** z)
  if (parentOp === "**") {
    return false;
  }

  // x == y == z --> (x == y) == z
  if (equalityOperators[parentOp] && equalityOperators[nodeOp]) {
    return false;
  }

  // x * y % z --> (x * y) % z
  if (
    (nodeOp === "%" && multiplicativeOperators[parentOp]) ||
    (parentOp === "%" && multiplicativeOperators[nodeOp])
  ) {
    return false;
  }

  // x * y / z --> (x * y) / z
  // x / y * z --> (x / y) * z
  if (
    nodeOp !== parentOp &&
    multiplicativeOperators[nodeOp] &&
    multiplicativeOperators[parentOp]
  ) {
    return false;
  }

  // x << y << z --> (x << y) << z
  if (bitshiftOperators[parentOp] && bitshiftOperators[nodeOp]) {
    return false;
  }

  return true;
}

const PRECEDENCE = {};
[
  ["|>"],
  ["??"],
  ["||"],
  ["&&"],
  ["|"],
  ["^"],
  ["&"],
  ["==", "===", "!=", "!=="],
  ["<", ">", "<=", ">=", "in", "instanceof"],
  [">>", "<<", ">>>"],
  ["+", "-"],
  ["*", "/", "%"],
  ["**"],
].forEach((tier, i) => {
  tier.forEach((op) => {
    PRECEDENCE[op] = i;
  });
});

function getPrecedence(op) {
  return PRECEDENCE[op];
}

function getLeftMost(node) {
  while (node.left) {
    node = node.left;
  }
  return node;
}

function isBitwiseOperator(operator) {
  return (
    !!bitshiftOperators[operator] ||
    operator === "|" ||
    operator === "^" ||
    operator === "&"
  );
}

function hasRestParameter(node) {
  if (node.rest) {
    return true;
  }
  const parameters = getFunctionParameters(node);
  return parameters.length > 0 && getLast(parameters).type === "RestElement";
}

const functionParametersCache = new WeakMap();
function getFunctionParameters(node) {
  if (functionParametersCache.has(node)) {
    return functionParametersCache.get(node);
  }
  const parameters = [];
  if (node.this) {
    parameters.push(node.this);
  }
  // `params` vs `parameters` - see https://github.com/babel/babel/issues/9231
  if (Array.isArray(node.parameters)) {
    parameters.push(...node.parameters);
  } else if (Array.isArray(node.params)) {
    parameters.push(...node.params);
  }
  if (node.rest) {
    parameters.push(node.rest);
  }
  functionParametersCache.set(node, parameters);
  return parameters;
}

function iterateFunctionParametersPath(path, iteratee) {
  const node = path.getValue();
  let index = 0;
  const callback = (childPath) => iteratee(childPath, index++);
  if (node.this) {
    path.call(callback, "this");
  }
  if (Array.isArray(node.parameters)) {
    path.each(callback, "parameters");
  } else if (Array.isArray(node.params)) {
    path.each(callback, "params");
  }
  if (node.rest) {
    path.call(callback, "rest");
  }
}

const callArgumentsCache = new WeakMap();
function getCallArguments(node) {
  if (callArgumentsCache.has(node)) {
    return callArgumentsCache.get(node);
  }
  const args =
    node.type === "ImportExpression"
      ? // No parser except `babel` supports `import("./foo.json", { assert: { type: "json" } })` yet,
        // And `babel` parser it as `CallExpression`
        // We need add the second argument here
        [node.source]
      : node.arguments;

  callArgumentsCache.set(node, args);
  return args;
}

function iterateCallArgumentsPath(path, iteratee) {
  const node = path.getValue();
  // See comment in `getCallArguments`
  if (node.type === "ImportExpression") {
    path.call((sourcePath) => iteratee(sourcePath, 0), "source");
  } else {
    path.each(iteratee, "arguments");
  }
}

function isPrettierIgnoreComment(comment) {
  return comment.value.trim() === "prettier-ignore" && !comment.unignore;
}

function hasNodeIgnoreComment(node) {
  return (
    node &&
    (node.prettierIgnore || hasComment(node, CommentCheckFlags.PrettierIgnore))
  );
}

function hasIgnoreComment(path) {
  const node = path.getValue();
  return hasNodeIgnoreComment(node);
}

const CommentCheckFlags = {
  /** @type {number} Check comment is a leading comment */
  Leading: 1 << 1,
  /** @type {number} Check comment is a trailing comment */
  Trailing: 1 << 2,
  /** @type {number} Check comment is a dangling comment */
  Dangling: 1 << 3,
  /** @type {number} Check comment is a block comment */
  Block: 1 << 4,
  /** @type {number} Check comment is a line comment */
  Line: 1 << 5,
  /** @type {number} Check comment is a `prettier-ignore` comment */
  PrettierIgnore: 1 << 6,
  /** @type {number} Check comment is the first attched comment */
  First: 1 << 7,
  /** @type {number} Check comment is the last attched comment */
  Last: 1 << 8,
};

/**
 * @returns {function}
 */
const getCommentTestFunction = (flags, fn) => {
  if (typeof flags === "function") {
    fn = flags;
    flags = 0;
  }
  if (flags || fn) {
    return (comment, index, comments) =>
      !(
        (flags & CommentCheckFlags.Leading && !comment.leading) ||
        (flags & CommentCheckFlags.Trailing && !comment.trailing) ||
        (flags & CommentCheckFlags.Dangling &&
          (comment.leading || comment.trailing)) ||
        (flags & CommentCheckFlags.Block && !isBlockComment(comment)) ||
        (flags & CommentCheckFlags.Line && !isLineComment(comment)) ||
        (flags & CommentCheckFlags.First && index !== 0) ||
        (flags & CommentCheckFlags.Last && index !== comments.length - 1) ||
        (flags & CommentCheckFlags.PrettierIgnore &&
          !isPrettierIgnoreComment(comment)) ||
        (fn && !fn(comment))
      );
  }
};
/**
 * @param {Node} node
 * @param {number | function} [flags]
 * @param {function} [fn]
 * @returns {boolean}
 */
function hasComment(node, flags, fn) {
  if (!node || !Array.isArray(node.comments) || node.comments.length === 0) {
    return false;
  }
  const test = getCommentTestFunction(flags, fn);
  return test
    ? node.comments.some((comment, index, comments) =>
        test(comment, index, comments)
      )
    : true;
}

/**
 * @param {Node} node
 * @param {number | function} [flags]
 * @param {function} [fn]
 * @returns {Comment[]}
 */
function getComments(node, flags, fn) {
  if (!node || !Array.isArray(node.comments)) {
    return [];
  }
  const test = getCommentTestFunction(flags, fn);
  return test
    ? node.comments.filter((comment, index, comments) =>
        test(comment, index, comments)
      )
    : node.comments;
}

module.exports = {
  classChildNeedsASIProtection,
  classPropMayCauseASIProblems,
  getFunctionParameters,
  iterateFunctionParametersPath,
  getCallArguments,
  iterateCallArgumentsPath,
  hasRestParameter,
  getLeftSidePathName,
  getParentExportDeclaration,
  getTypeScriptMappedTypeModifier,
  hasFlowAnnotationComment,
  hasFlowShorthandAnnotationComment,
  hasLeadingOwnLineComment,
  hasNakedLeftSide,
  hasNewlineBetweenOrAfterDecorators,
  hasNode,
  hasPrettierIgnore,
  hasIgnoreComment,
  identity,
  isBinaryish,
  isBlockComment,
  isLineComment,
  isPrettierIgnoreComment,
  isCallOrOptionalCallExpression,
  isEmptyJsxElement,
  isExportDeclaration,
  isFlowAnnotationComment,
  isFunctionCompositionArgs,
  isFunctionNotation,
  isFunctionOrArrowExpression,
  isGetterOrSetter,
  isJestEachTemplateLiteral,
  isJsxNode,
  isJsxWhitespaceExpression,
  isLastStatement,
  isLiteral,
  isLongCurriedCallExpression,
  isSimpleCallArgument,
  isMeaningfulJsxText,
  isMemberExpressionChain,
  isMemberish,
  isNumericLiteral,
  isObjectType,
  isObjectTypePropertyAFunction,
  isSimpleType,
  isSimpleNumber,
  isSimpleTemplateLiteral,
  isStringLiteral,
  isStringPropSafeToUnquote,
  isTemplateOnItsOwnLine,
  isTestCall,
  isTheOnlyJsxElementInMarkdown,
  isTSXFile,
  isTypeAnnotationAFunction,
  matchJsxWhitespaceRegex,
  needsHardlineAfterDanglingComment,
  rawText,
  returnArgumentHasLeadingComment,
  shouldPrintComma,
  isBitwiseOperator,
  shouldFlatten,
  startsWithNoLookaheadToken,
  getPrecedence,
  hasComment,
  getComments,
  CommentCheckFlags,
  trimJsxWhitespace,
};
