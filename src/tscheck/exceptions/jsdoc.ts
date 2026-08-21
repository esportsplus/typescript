import * as ts from "~/tscheck/adapter";

import type { FunctionLike } from "../kernel/types";
import { bottom, join, single, top, TOP_KEY, typeRef, type ExceptionsValue } from "./value";

// Parse `@throws {TypeName}` / `@throws TypeName` (and `@exception`) tags on a
// function, resolving each named type to a canonical key at the function's scope.
// `declared` is true when at least one throws tag is present (opt-in checked
// exceptions); `value` is the union of the declared types.
export function declaredThrows(
  node: FunctionLike,
  checker: ts.TypeChecker,
): { value: ExceptionsValue; declared: boolean } {
  let value = bottom();
  let declared = false;
  for (const tag of ts.getJSDocTags(node)) {
    const name = tag.tagName.text;
    if (name !== "throws" && name !== "exception") continue;
    declared = true;
    const typeExpr = (tag as { typeExpression?: ts.JSDocTypeExpression }).typeExpression;
    if (typeExpr && typeExpr.type) {
      // `@throws {Foo}` — resolve the type node against the checker.
      const t = checker.getTypeAtLocation(typeExpr.type);
      if (t) value = join(value, refsToValue(typeRef(checker, t)));
      continue;
    }
    // `@throws Foo` — take the first identifier-ish token from the comment; we
    // have no node to resolve, so use the name as both key and display.
    const text = typeof tag.comment === "string" ? tag.comment : ts.getTextOfJSDocComment(tag.comment);
    const bare = (text ?? "").trim().split(/[\s,|]+/)[0];
    if (bare) value = join(value, single(bare, bare));
  }
  return { value, declared };
}

function refsToValue(refs: ReadonlyArray<{ key: string; display: string }>): ExceptionsValue {
  let v = bottom();
  for (const r of refs) v = join(v, r.key === TOP_KEY ? top() : single(r.key, r.display));
  return v;
}
