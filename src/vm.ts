// V 언어 VM (트리 워킹 인터프리터)
// FreeLang의 스택 VM 대신, AST를 직접 순회하는 방식
// (단순하고 디버깅이 쉬움)

import * as A from './ast.js'

// ── 런타임 값 타입 ────────────────────────────────────────

export type VVal =
  | { v: 'int';    n: bigint }
  | { v: 'float';  f: number }
  | { v: 'bool';   b: boolean }
  | { v: 'string'; s: string }
  | { v: 'char';   c: string }
  | { v: 'array';  elems: VVal[] }
  | { v: 'map';    entries: Map<string, VVal> }
  | { v: 'struct'; name: string; fields: Map<string, VVal> }
  | { v: 'fn';     decl: A.FnDecl | A.AnonFn; closure: Scope }
  | { v: 'bound_method'; recv: Extract<VVal, { v: 'struct' }>; decl: A.FnDecl; closure: Scope }
  | { v: 'builtin'; name: string }
  | { v: 'none' }
  | { v: 'option'; inner: VVal }
  | { v: 'void' }

// 정수/문자열로 변환하는 헬퍼
function toString(val: VVal): string {
  switch (val.v) {
    case 'int':    return val.n.toString()
    case 'float':  return val.f.toString()
    case 'bool':   return val.b ? 'true' : 'false'
    case 'string': return val.s
    case 'char':   return val.c
    case 'none':   return 'none'
    case 'void':   return ''
    case 'option': return toString(val.inner)
    case 'array':  return '[' + val.elems.map(toString).join(', ') + ']'
    case 'map': {
      const parts: string[] = []
      val.entries.forEach((v, k) => parts.push(`${k}: ${toString(v)}`))
      return '{' + parts.join(', ') + '}'
    }
    case 'struct': {
      const parts: string[] = []
      val.fields.forEach((v, k) => parts.push(`${k}: ${toString(v)}`))
      return `${val.name}{${parts.join(', ')}}`
    }
    case 'fn':           return `fn(${(val.decl as A.FnDecl).name ?? 'anon'})`
    case 'bound_method': return `method(${val.decl.name})`
    case 'builtin':      return `builtin(${val.name})`
  }
}

function isTruthy(val: VVal): boolean {
  switch (val.v) {
    case 'bool':   return val.b
    case 'int':    return val.n !== 0n
    case 'float':  return val.f !== 0
    case 'string': return val.s !== ''
    case 'none':   return false
    case 'void':   return false
    default:       return true
  }
}

// ── 제어 흐름 시그널 ──────────────────────────────────────

class ReturnSignal { constructor(public val: VVal) {} }
class BreakSignal  { constructor(public label: string | null) {} }
class ContinueSignal { constructor(public label: string | null) {} }

// ── 스코프 (변수 저장소) ──────────────────────────────────

class Scope {
  private vars = new Map<string, { val: VVal; isMut: boolean }>()
  constructor(public parent: Scope | null = null) {}

  get(name: string): VVal | undefined {
    const entry = this.vars.get(name)
    if (entry) return entry.val
    return this.parent?.get(name)
  }

  set(name: string, val: VVal, isMut = true): void {
    // 이미 있는 변수면 상위 스코프까지 탐색해서 업데이트
    if (this.vars.has(name)) {
      const entry = this.vars.get(name)!
      if (!entry.isMut) throw new VError(`'${name}' 는 불변 변수입니다 (mut 선언 필요)`)
      entry.val = val
      return
    }
    if (this.parent?.has(name)) {
      this.parent.set(name, val, isMut)
      return
    }
    // 새 변수 선언
    this.vars.set(name, { val, isMut })
  }

  declare(name: string, val: VVal, isMut: boolean): void {
    this.vars.set(name, { val, isMut })
  }

  has(name: string): boolean {
    return this.vars.has(name) || (this.parent?.has(name) ?? false)
  }
}

// ── V 런타임 에러 ─────────────────────────────────────────

export class VError extends Error {
  constructor(msg: string, public pos?: A.Pos) {
    super(msg)
    this.name = 'VError'
  }
}

// ══════════════════════════════════════════════════════════
//  VM 메인 클래스
// ══════════════════════════════════════════════════════════

export class VM {
  // 전역 스코프 (struct 정의, 함수 등록)
  private global: Scope
  // struct 타입 레지스트리
  private structs = new Map<string, A.StructDecl>()
  // 메서드 레지스트리: typeName → methodName → FnDecl
  private methods = new Map<string, Map<string, A.FnDecl>>()

  constructor() {
    this.global = new Scope()
    this.registerBuiltins()
  }

  // ──────────────────────────────────────────────────────
  //  파일 실행 진입점
  // ──────────────────────────────────────────────────────

  runFile(file: A.VFile): VVal {
    // 1패스: 모든 struct / fn 등록 (순서 자유)
    for (const stmt of file.stmts) {
      if (stmt.t === 'struct_decl')  this.structs.set(stmt.name, stmt)
      if (stmt.t === 'fn_decl') {
        if (stmt.receiver) {
          // 메서드: 타입별 메서드 맵에 등록
          const typeName = stmt.receiver.type
          if (!this.methods.has(typeName)) this.methods.set(typeName, new Map())
          this.methods.get(typeName)!.set(stmt.name, stmt)
        } else {
          this.global.declare(stmt.name, { v: 'fn', decl: stmt, closure: this.global }, false)
        }
      }
      if (stmt.t === 'const_decl')   this.global.declare(stmt.name, this.evalExpr(stmt.value, this.global), false)
      if (stmt.t === 'type_decl') { /* 타입 별칭 등록 (미래) */ }
      if (stmt.t === 'enum_decl') {
        // enum을 map 형태로 등록: Color.red → 0, Color.green → 1 ...
        const entries = new Map<string, VVal>()
        stmt.values.forEach(({ name, value }, i) => {
          const val: VVal = value ? this.evalExpr(value, this.global) : { v: 'int', n: BigInt(i) }
          entries.set(name, val)
        })
        this.global.declare(stmt.name, { v: 'map', entries }, false)
      }
    }

    // 2패스: main() 호출
    const mainFn = this.global.get('main')
    if (!mainFn) throw new VError("'main' 함수를 찾을 수 없습니다")
    if (mainFn.v !== 'fn') throw new VError("'main' 은 함수가 아닙니다")

    return this.callFn(mainFn.decl, [], this.global)
  }

  // ──────────────────────────────────────────────────────
  //  문장 실행
  // ──────────────────────────────────────────────────────

  private execStmt(stmt: A.Stmt, scope: Scope): void {
    switch (stmt.t) {

      case 'expr_stmt': {
        this.evalExpr(stmt.expr, scope)
        break
      }

      case 'assign': {
        const val = this.evalExpr(stmt.value, scope)
        this.assign(stmt.target, val, stmt.op, stmt.isMut, scope)
        break
      }

      case 'fn_decl': {
        scope.declare(stmt.name, { v: 'fn', decl: stmt, closure: scope }, false)
        break
      }

      case 'struct_decl': {
        this.structs.set(stmt.name, stmt)
        break
      }

      case 'const_decl': {
        const val = this.evalExpr(stmt.value, scope)
        scope.declare(stmt.name, val, false)
        break
      }

      case 'return': {
        const val = stmt.value ? this.evalExpr(stmt.value, scope) : { v: 'void' } as VVal
        throw new ReturnSignal(val)
      }

      case 'block': {
        const inner = new Scope(scope)
        this.execBlock(stmt, inner)
        break
      }

      case 'for': {
        this.execFor(stmt, scope)
        break
      }

      case 'for_c': {
        this.execForC(stmt, scope)
        break
      }

      case 'for_in': {
        this.execForIn(stmt, scope)
        break
      }

      case 'branch': {
        if (stmt.kind === 'break')    throw new BreakSignal(stmt.label)
        if (stmt.kind === 'continue') throw new ContinueSignal(stmt.label)
        break
      }

      case 'defer': {
        // TODO: defer는 함수 종료 시 실행
        // 간단한 버전: 즉시 등록만 (실제 defer 스택 구현은 Phase 2)
        break
      }

      case 'assert': {
        const cond = this.evalExpr(stmt.cond, scope)
        if (!isTruthy(cond)) {
          const msg = stmt.msg ? toString(this.evalExpr(stmt.msg, scope)) : 'assertion failed'
          throw new VError(`assert 실패: ${msg}`, stmt.pos)
        }
        break
      }

      case 'import':
      case 'module':
      case 'interface_decl':
      case 'enum_decl':
      case 'type_decl':
      case 'label':
      case 'goto':
        // TODO: 미래 구현
        break

      default:
        throw new VError(`알 수 없는 문장: ${(stmt as any).t}`)
    }
  }

  private execBlock(block: A.Block, scope: Scope): void {
    for (const stmt of block.stmts) {
      this.execStmt(stmt, scope)
    }
  }

  // 블록 마지막 표현식 값 반환 (match arm용)
  private execBlockValue(block: A.Block, scope: Scope): VVal {
    let last: VVal = { v: 'void' }
    for (const stmt of block.stmts) {
      if (stmt.t === 'expr_stmt') {
        last = this.evalExpr(stmt.expr, scope)
      } else {
        this.execStmt(stmt, scope)
      }
    }
    return last
  }

  // enum 변형 이름으로 값 조회 (모든 등록된 enum 탐색)
  private resolveEnumVariant(variantName: string, scope: Scope): VVal {
    // scope에서 맵 타입 값을 순회해서 해당 키를 찾음
    for (const [, val] of (this.global as any).vars) {
      if (val.val.v === 'map') {
        const found = (val.val as Extract<VVal, { v: 'map' }>).entries.get(variantName)
        if (found !== undefined) return found
      }
    }
    throw new VError(`enum 변형 '${variantName}' 을 찾을 수 없습니다`)
  }

  // ──────────────────────────────────────────────────────
  //  for 루프들
  // ──────────────────────────────────────────────────────

  private execFor(stmt: A.ForStmt, scope: Scope): void {
    while (true) {
      if (stmt.cond) {
        const cond = this.evalExpr(stmt.cond, scope)
        if (!isTruthy(cond)) break
      }
      try {
        const inner = new Scope(scope)
        this.execBlock(stmt.body, inner)
      } catch (e) {
        if (e instanceof BreakSignal)    break
        if (e instanceof ContinueSignal) continue
        throw e
      }
    }
  }

  private execForC(stmt: A.ForCStmt, scope: Scope): void {
    const inner = new Scope(scope)

    // init: for 루프 변수는 항상 mutable (i++, i += 1 등)
    if (stmt.init) {
      const init = { ...stmt.init, isMut: true }
      this.execStmt(init, inner)
    }

    while (true) {
      // cond
      if (stmt.cond) {
        const cond = this.evalExpr(stmt.cond, inner)
        if (!isTruthy(cond)) break
      }

      // body
      try {
        const bodyScope = new Scope(inner)
        this.execBlock(stmt.body, bodyScope)
      } catch (e) {
        if (e instanceof BreakSignal)    break
        if (e instanceof ContinueSignal) { /* post 실행 후 continue */ }
        else throw e
      }

      // post (i++, i += 2 등)
      if (stmt.post) this.execStmt(stmt.post, inner)
    }
  }

  private execForIn(stmt: A.ForInStmt, scope: Scope): void {
    const iterable = this.evalExpr(stmt.iterable, scope)
    const items = this.toIterable(iterable)

    for (let i = 0; i < items.length; i++) {
      try {
        const inner = new Scope(scope)
        if (stmt.keyVar) inner.declare(stmt.keyVar, { v: 'int', n: BigInt(i) }, false)
        inner.declare(stmt.valVar, items[i], false)
        this.execBlock(stmt.body, inner)
      } catch (e) {
        if (e instanceof BreakSignal)    break
        if (e instanceof ContinueSignal) continue
        throw e
      }
    }
  }

  private toIterable(val: VVal): VVal[] {
    if (val.v === 'array')  return val.elems
    if (val.v === 'string') return [...val.s].map(c => ({ v: 'char', c } as VVal))
    if (val.v === 'map') {
      const result: VVal[] = []
      val.entries.forEach((v, k) => result.push({ v: 'string', s: k }))
      return result
    }
    // 범위 RangeExpr은 evalExpr에서 배열로 변환됨
    throw new VError(`반복 불가능한 값: ${toString(val)}`)
  }

  // ──────────────────────────────────────────────────────
  //  대입 처리 (=, :=, +=, ...)
  // ──────────────────────────────────────────────────────

  private assign(target: A.Expr, val: VVal, op: string, isMut: boolean, scope: Scope): void {
    // 복합 대입 처리 (+=, -= 등)
    if (op !== '=' && op !== ':=') {
      const cur = this.evalExpr(target, scope)
      val = this.applyBinOp(op.replace('=', ''), cur, val)
    }

    if (target.t === 'ident') {
      if (op === ':=') {
        scope.declare(target.name, val, isMut)
      } else {
        scope.set(target.name, val)
      }
    } else if (target.t === 'index') {
      const arr = this.evalExpr(target.obj, scope)
      const idx = this.evalExpr(target.index, scope)
      if (arr.v === 'array') {
        const i = Number(this.toInt(idx))
        if (i < 0 || i >= arr.elems.length) throw new VError(`인덱스 ${i} 범위 초과`)
        arr.elems[i] = val
      } else if (arr.v === 'map') {
        arr.entries.set(toString(idx), val)
      } else {
        throw new VError('인덱싱 대상이 배열/맵이 아닙니다')
      }
    } else if (target.t === 'selector') {
      const obj = this.evalExpr(target.obj, scope)
      if (obj.v !== 'struct') throw new VError('필드 접근 대상이 구조체가 아닙니다')
      obj.fields.set(target.field, val)
    } else {
      throw new VError('대입 대상이 유효하지 않습니다')
    }
  }

  // ──────────────────────────────────────────────────────
  //  표현식 평가 (핵심)
  // ──────────────────────────────────────────────────────

  evalExpr(expr: A.Expr, scope: Scope): VVal {
    switch (expr.t) {

      // ── 리터럴 ────────────────────────────────────────
      case 'int':   return { v: 'int',   n: expr.val }
      case 'float': return { v: 'float', f: expr.val }
      case 'bool':  return { v: 'bool',  b: expr.val }
      case 'char':  return { v: 'char',  c: expr.val }
      case 'none':  return { v: 'none' }
      case 'paren': return this.evalExpr(expr.expr, scope)

      // ── 문자열 (보간 처리) ───────────────────────────
      case 'string': {
        let result = ''
        for (const seg of expr.segments) {
          if (seg.kind === 'text')   result += seg.text
          else result += toString(this.evalExpr(seg.expr, scope))
        }
        return { v: 'string', s: result }
      }

      // ── 식별자 ─────────────────────────────────────
      case 'ident': {
        const val = scope.get(expr.name)
        if (val === undefined) throw new VError(`'${expr.name}' 는 선언되지 않았습니다`, expr.pos)
        return val
      }

      // ── 이항 연산 ──────────────────────────────────
      case 'infix': {
        // 단락 평가 (short-circuit)
        if (expr.op === '&&') {
          const l = this.evalExpr(expr.left, scope)
          return isTruthy(l) ? this.evalExpr(expr.right, scope) : l
        }
        if (expr.op === '||') {
          const l = this.evalExpr(expr.left, scope)
          return isTruthy(l) ? l : this.evalExpr(expr.right, scope)
        }
        const left  = this.evalExpr(expr.left,  scope)
        const right = this.evalExpr(expr.right, scope)
        return this.applyBinOp(expr.op, left, right)
      }

      // ── 단항 연산 ──────────────────────────────────
      case 'prefix': {
        const v = this.evalExpr(expr.expr, scope)
        switch (expr.op) {
          case '-':
            if (v.v === 'int')   return { v: 'int',   n: -v.n }
            if (v.v === 'float') return { v: 'float', f: -v.f }
            throw new VError(`'-' 는 숫자에만 사용 가능`)
          case '!': return { v: 'bool', b: !isTruthy(v) }
          case '~':
            if (v.v === 'int') return { v: 'int', n: ~v.n }
            throw new VError(`'~' 는 정수에만 사용 가능`)
          case '&': return v  // 참조 (단순화: 값 그대로)
          case '*': return v  // 역참조 (단순화)
          default: throw new VError(`알 수 없는 단항 연산자: ${expr.op}`)
        }
      }

      // ── 후위 ++/-- ─────────────────────────────────
      case 'postfix': {
        const cur = this.evalExpr(expr.expr, scope)
        let next: VVal
        if (expr.op === '++') {
          next = cur.v === 'int' ? { v: 'int', n: cur.n + 1n }
               : cur.v === 'float' ? { v: 'float', f: cur.f + 1 }
               : (() => { throw new VError(`'++'는 숫자에만 사용 가능`) })()
        } else {
          next = cur.v === 'int' ? { v: 'int', n: cur.n - 1n }
               : cur.v === 'float' ? { v: 'float', f: cur.f - 1 }
               : (() => { throw new VError(`'--'는 숫자에만 사용 가능`) })()
        }
        this.assign(expr.expr, next, '=', false, scope)
        return cur  // 후위: 이전 값 반환
      }

      // ── 함수 호출 ──────────────────────────────────
      case 'call': {
        const callee = this.evalExpr(expr.callee, scope)
        const args   = expr.args.map(a => this.evalExpr(a, scope))

        if (callee.v === 'builtin')      return this.callBuiltin(callee.name, args, expr)
        if (callee.v === 'fn')           return this.callFn(callee.decl, args, callee.closure)
        if (callee.v === 'bound_method') {
          // 리시버를 첫 번째 인자로 넣어서 callFn 호출
          return this.callMethod(callee.decl, callee.recv, args, callee.closure)
        }

        throw new VError(`호출 대상이 함수가 아닙니다: ${toString(callee)}`, expr.pos)
      }

      // ── 배열 인덱싱 ────────────────────────────────
      case 'index': {
        const obj = this.evalExpr(expr.obj, scope)
        const idx = this.evalExpr(expr.index, scope)

        if (obj.v === 'array') {
          const i = Number(this.toInt(idx))
          if (i < 0 || i >= obj.elems.length)
            throw new VError(`인덱스 ${i} 범위 초과 (크기: ${obj.elems.length})`, expr.pos)
          return obj.elems[i]
        }
        if (obj.v === 'map') {
          const key = toString(idx)
          return obj.entries.get(key) ?? { v: 'none' }
        }
        if (obj.v === 'string') {
          const i = Number(this.toInt(idx))
          if (i < 0 || i >= obj.s.length)
            throw new VError(`인덱스 ${i} 범위 초과`)
          return { v: 'char', c: obj.s[i] }
        }
        throw new VError(`인덱싱 불가: ${toString(obj)}`, expr.pos)
      }

      // ── 필드 접근 ──────────────────────────────────
      case 'selector': {
        const obj = this.evalExpr(expr.obj, scope)

        if (obj.v === 'struct') {
          // 필드 조회
          const val = obj.fields.get(expr.field)
          if (val !== undefined) return val
          // 메서드 조회
          const methodDecl = this.methods.get(obj.name)?.get(expr.field)
          if (methodDecl) {
            // 바운드 메서드: 리시버를 클로저로 캡처
            return { v: 'bound_method', recv: obj, decl: methodDecl, closure: this.global } as any
          }
          throw new VError(`필드 '${expr.field}' 없음`, expr.pos)
        }
        if (obj.v === 'array') {
          // 배열 메서드
          return this.arrayMethod(obj, expr.field, expr.pos)
        }
        if (obj.v === 'map') {
          // enum 또는 namespace 접근: Color.red
          const val = obj.entries.get(expr.field)
          if (val !== undefined) return val
          throw new VError(`'${expr.field}' 키 없음`, expr.pos)
        }
        if (obj.v === 'string') {
          if (expr.field === 'len') return { v: 'int', n: BigInt(obj.s.length) }
        }
        throw new VError(`'${expr.field}' 필드 접근 불가: ${toString(obj)}`, expr.pos)
      }

      // ── 배열 리터럴 ────────────────────────────────
      case 'array': {
        const elems = expr.elems.map(e => this.evalExpr(e, scope))
        return { v: 'array', elems }
      }

      // ── 맵 리터럴 ──────────────────────────────────
      case 'map': {
        const entries = new Map<string, VVal>()
        for (const { key, val } of expr.pairs) {
          const k = toString(this.evalExpr(key, scope))
          const v = this.evalExpr(val, scope)
          entries.set(k, v)
        }
        return { v: 'map', entries }
      }

      // ── 구조체 초기화 ──────────────────────────────
      case 'struct_init': {
        const decl = this.structs.get(expr.name)
        const fields = new Map<string, VVal>()

        // 기본값 먼저 채우기
        if (decl) {
          for (const f of decl.fields) {
            if (f.default) fields.set(f.name, this.evalExpr(f.default, scope))
          }
        }

        // 제공된 필드 덮어쓰기
        for (const { name, val } of expr.fields) {
          fields.set(name, this.evalExpr(val, scope))
        }

        return { v: 'struct', name: expr.name, fields }
      }

      // ── if 표현식 ──────────────────────────────────
      case 'if': {
        for (const branch of expr.branches) {
          let taken = false

          if (!branch.cond && !branch.guard) {
            // else 브랜치
            taken = true
          } else if (branch.guard) {
            // if x := opt_fn()
            const val = this.evalExpr(branch.guard.expr, scope)
            if (val.v !== 'none') {
              const inner = new Scope(scope)
              inner.declare(branch.guard.varName, val.v === 'option' ? val.inner : val, false)
              this.execBlock(branch.body, inner)
              return { v: 'void' }
            }
            continue
          } else if (branch.cond) {
            const cond = this.evalExpr(branch.cond, scope)
            taken = isTruthy(cond)
          }

          if (taken) {
            const inner = new Scope(scope)
            this.execBlock(branch.body, inner)
            return { v: 'void' }
          }
        }
        return { v: 'void' }
      }

      // ── match 표현식 ────────────────────────────────
      case 'match': {
        const subject = this.evalExpr(expr.subject, scope)
        for (const arm of expr.arms) {
          // else 브랜치
          if (arm.patterns.length === 0) {
            const inner = new Scope(scope)
            const last = this.execBlockValue(arm.body, inner)
            return last
          }
          // 패턴 매칭
          for (const pat of arm.patterns) {
            let patVal: VVal
            // .variant 단축 형태 처리
            if (pat.t === 'ident' && pat.name.startsWith('__enum__.')) {
              const variantName = pat.name.slice(9)
              patVal = this.resolveEnumVariant(variantName, scope)
            } else {
              patVal = this.evalExpr(pat, scope)
            }
            if (this.valEqual(subject, patVal)) {
              const inner = new Scope(scope)
              const last = this.execBlockValue(arm.body, inner)
              return last
            }
          }
        }
        return { v: 'void' }
      }

      // ── or 표현식 (Option 언박싱) ──────────────────
      case 'or': {
        const val = this.evalExpr(expr.expr, scope)
        if (val.v === 'none') {
          const inner = new Scope(scope)
          this.execBlock(expr.body, inner)
          return { v: 'void' }
        }
        return val.v === 'option' ? val.inner : val
      }

      // ── 타입 변환 ──────────────────────────────────
      case 'cast': {
        const val = this.evalExpr(expr.expr, scope)
        return this.castTo(expr.to, val)
      }

      // ── 범위 표현식 (배열로 변환) ──────────────────
      case 'range': {
        const low  = this.evalExpr(expr.low,  scope)
        const high = this.evalExpr(expr.high, scope)
        const lo = this.toInt(low)
        const hi = this.toInt(high) + (expr.inclusive ? 1n : 0n)
        const elems: VVal[] = []
        for (let i = lo; i < hi; i++) elems.push({ v: 'int', n: i })
        return { v: 'array', elems }
      }

      // ── 익명 함수 ──────────────────────────────────
      case 'anon_fn': {
        return { v: 'fn', decl: expr, closure: scope }
      }

      default:
        throw new VError(`미지원 표현식: ${(expr as any).t}`)
    }
  }

  // ──────────────────────────────────────────────────────
  //  이항 연산자 적용
  // ──────────────────────────────────────────────────────

  private applyBinOp(op: string, l: VVal, r: VVal): VVal {
    // 배열 push: arr << elem
    if (l.v === 'array' && op === '<<') {
      l.elems.push(r)
      return l
    }

    // 문자열 연산
    if (l.v === 'string' && op === '+')
      return { v: 'string', s: l.s + toString(r) }
    if (l.v === 'string' && op === '==')
      return { v: 'bool', b: l.s === toString(r) }
    if (l.v === 'string' && op === '!=')
      return { v: 'bool', b: l.s !== toString(r) }

    // int 연산
    if (l.v === 'int' && r.v === 'int') {
      switch (op) {
        case '+':  return { v: 'int', n: l.n + r.n }
        case '-':  return { v: 'int', n: l.n - r.n }
        case '*':  return { v: 'int', n: l.n * r.n }
        case '/':  if (r.n === 0n) throw new VError('0으로 나눌 수 없습니다')
                   return { v: 'int', n: l.n / r.n }
        case '%':  return { v: 'int', n: l.n % r.n }
        case '&':  return { v: 'int', n: l.n & r.n }
        case '|':  return { v: 'int', n: l.n | r.n }
        case '^':  return { v: 'int', n: l.n ^ r.n }
        case '<<': return { v: 'int', n: l.n << r.n }
        case '>>': return { v: 'int', n: l.n >> r.n }
        case '==': return { v: 'bool', b: l.n === r.n }
        case '!=': return { v: 'bool', b: l.n !== r.n }
        case '<':  return { v: 'bool', b: l.n < r.n }
        case '>':  return { v: 'bool', b: l.n > r.n }
        case '<=': return { v: 'bool', b: l.n <= r.n }
        case '>=': return { v: 'bool', b: l.n >= r.n }
      }
    }

    // float 연산 (int + float 자동 변환)
    const lf = l.v === 'float' ? l.f : l.v === 'int' ? Number(l.n) : NaN
    const rf = r.v === 'float' ? r.f : r.v === 'int' ? Number(r.n) : NaN
    if (!isNaN(lf) && !isNaN(rf)) {
      switch (op) {
        case '+':  return { v: 'float', f: lf + rf }
        case '-':  return { v: 'float', f: lf - rf }
        case '*':  return { v: 'float', f: lf * rf }
        case '/':  return { v: 'float', f: lf / rf }
        case '%':  return { v: 'float', f: lf % rf }
        case '==': return { v: 'bool', b: lf === rf }
        case '!=': return { v: 'bool', b: lf !== rf }
        case '<':  return { v: 'bool', b: lf <  rf }
        case '>':  return { v: 'bool', b: lf >  rf }
        case '<=': return { v: 'bool', b: lf <= rf }
        case '>=': return { v: 'bool', b: lf >= rf }
      }
    }

    // bool 연산
    if (l.v === 'bool' && r.v === 'bool') {
      switch (op) {
        case '==': return { v: 'bool', b: l.b === r.b }
        case '!=': return { v: 'bool', b: l.b !== r.b }
      }
    }

    throw new VError(`연산 불가: ${toString(l)} ${op} ${toString(r)}`)
  }

  // ──────────────────────────────────────────────────────
  //  함수 호출
  // ──────────────────────────────────────────────────────

  callFn(decl: A.FnDecl | A.AnonFn, args: VVal[], closure: Scope): VVal {
    const scope = new Scope(closure)
    const params = decl.params

    for (let i = 0; i < params.length; i++) {
      scope.declare(params[i].name, args[i] ?? { v: 'none' }, params[i].isMut)
    }

    try {
      this.execBlock(decl.body, scope)
      return { v: 'void' }
    } catch (e) {
      if (e instanceof ReturnSignal) return e.val
      throw e
    }
  }

  // ──────────────────────────────────────────────────────
  //  메서드 호출 (리시버 바인딩)
  // ──────────────────────────────────────────────────────

  private callMethod(
    decl: A.FnDecl,
    recv: Extract<VVal, { v: 'struct' }>,
    args: VVal[],
    closure: Scope
  ): VVal {
    const scope = new Scope(closure)
    // 리시버 바인딩: fn (p Point) → 'p' 변수로 등록
    if (decl.receiver) {
      scope.declare(decl.receiver.name, recv, decl.receiver.isMut)
    }
    // 일반 파라미터
    for (let i = 0; i < decl.params.length; i++) {
      scope.declare(decl.params[i].name, args[i] ?? { v: 'none' }, decl.params[i].isMut)
    }
    try {
      this.execBlock(decl.body, scope)
      return { v: 'void' }
    } catch (e) {
      if (e instanceof ReturnSignal) return e.val
      throw e
    }
  }

  // ──────────────────────────────────────────────────────
  //  배열 메서드 (obj.len, obj.filter 등)
  // ──────────────────────────────────────────────────────

  private arrayMethod(arr: Extract<VVal, { v: 'array' }>, method: string, pos: A.Pos): VVal {
    switch (method) {
      case 'len':     return { v: 'int', n: BigInt(arr.elems.length) }
      case 'filter':  return { v: 'builtin', name: `_arr_filter_${method}` }
      case 'map':     return { v: 'builtin', name: `_arr_map` }
      case 'first':   return arr.elems[0] ?? { v: 'none' }
      case 'last':    return arr.elems[arr.elems.length - 1] ?? { v: 'none' }
      case 'reverse': return { v: 'array', elems: [...arr.elems].reverse() }
      case 'sorted':  return { v: 'array', elems: [...arr.elems].sort((a, b) => {
        const av = a.v === 'int' ? a.n : a.v === 'float' ? BigInt(Math.floor(a.f)) : 0n
        const bv = b.v === 'int' ? b.n : b.v === 'float' ? BigInt(Math.floor(b.f)) : 0n
        return av < bv ? -1 : av > bv ? 1 : 0
      })}
      default:
        throw new VError(`배열 메서드 없음: '${method}'`, pos)
    }
  }

  // ──────────────────────────────────────────────────────
  //  타입 변환
  // ──────────────────────────────────────────────────────

  private castTo(to: string, val: VVal): VVal {
    switch (to) {
      case 'int': case 'i8': case 'i16': case 'i32': case 'i64':
      case 'u8': case 'u16': case 'u32': case 'u64': case 'byte':
        if (val.v === 'int')   return { v: 'int', n: val.n }
        if (val.v === 'float') return { v: 'int', n: BigInt(Math.trunc(val.f)) }
        if (val.v === 'bool')  return { v: 'int', n: val.b ? 1n : 0n }
        if (val.v === 'char')  return { v: 'int', n: BigInt(val.c.charCodeAt(0)) }
        if (val.v === 'string') return { v: 'int', n: BigInt(parseInt(val.s) || 0) }
        break
      case 'f32': case 'f64':
        if (val.v === 'float') return { v: 'float', f: val.f }
        if (val.v === 'int')   return { v: 'float', f: Number(val.n) }
        if (val.v === 'string') return { v: 'float', f: parseFloat(val.s) || 0 }
        break
      case 'string':
        return { v: 'string', s: toString(val) }
      case 'bool':
        return { v: 'bool', b: isTruthy(val) }
      case 'rune':
        if (val.v === 'int') return { v: 'char', c: String.fromCharCode(Number(val.n)) }
        break
    }
    return val
  }

  // ──────────────────────────────────────────────────────
  //  값 비교 (match 패턴 매칭용)
  // ──────────────────────────────────────────────────────

  private valEqual(a: VVal, b: VVal): boolean {
    if (a.v !== b.v) return false
    switch (a.v) {
      case 'int':    return a.n === (b as any).n
      case 'float':  return a.f === (b as any).f
      case 'bool':   return a.b === (b as any).b
      case 'string': return a.s === (b as any).s
      case 'char':   return a.c === (b as any).c
      case 'none':   return true
      default:       return false
    }
  }

  private toInt(val: VVal): bigint {
    if (val.v === 'int')   return val.n
    if (val.v === 'float') return BigInt(Math.trunc(val.f))
    if (val.v === 'bool')  return val.b ? 1n : 0n
    throw new VError(`정수로 변환 불가: ${toString(val)}`)
  }

  // ──────────────────────────────────────────────────────
  //  내장 함수 등록
  // ──────────────────────────────────────────────────────

  private registerBuiltins(): void {
    const reg = (name: string) =>
      this.global.declare(name, { v: 'builtin', name }, false)

    // I/O
    reg('println'); reg('print'); reg('eprintln'); reg('eprint')
    // 타입 변환
    reg('int'); reg('i64'); reg('f32'); reg('f64')
    reg('str'); reg('string'); reg('bool'); reg('rune')
    // 배열
    reg('len'); reg('cap')
    // 수학
    reg('abs'); reg('min'); reg('max')
    // 문자열
    reg('sizeof'); reg('typeof')
    // OS
    reg('exit')
    // 입력
    reg('input')
  }

  private callBuiltin(name: string, args: VVal[], expr: A.CallExpr): VVal {
    switch (name) {

      // ── I/O ───────────────────────────────────────
      case 'println': {
        const line = args.map(toString).join(' ')
        process.stdout.write(line + '\n')
        return { v: 'void' }
      }
      case 'print': {
        const line = args.map(toString).join(' ')
        process.stdout.write(line)
        return { v: 'void' }
      }
      case 'eprintln': {
        process.stderr.write(args.map(toString).join(' ') + '\n')
        return { v: 'void' }
      }
      case 'eprint': {
        process.stderr.write(args.map(toString).join(' '))
        return { v: 'void' }
      }

      // ── 타입 변환 ─────────────────────────────────
      case 'int': case 'i64':
        if (args[0]) return this.castTo('int', args[0])
        return { v: 'int', n: 0n }
      case 'f32': case 'f64':
        if (args[0]) return this.castTo('f64', args[0])
        return { v: 'float', f: 0 }
      case 'str': case 'string':
        if (args[0]) return { v: 'string', s: toString(args[0]) }
        return { v: 'string', s: '' }
      case 'bool':
        if (args[0]) return { v: 'bool', b: isTruthy(args[0]) }
        return { v: 'bool', b: false }
      case 'rune':
        if (args[0]) return this.castTo('rune', args[0])
        return { v: 'char', c: '\0' }

      // ── len / cap ─────────────────────────────────
      case 'len': {
        const v = args[0]
        if (!v) return { v: 'int', n: 0n }
        if (v.v === 'array')  return { v: 'int', n: BigInt(v.elems.length) }
        if (v.v === 'string') return { v: 'int', n: BigInt(v.s.length) }
        if (v.v === 'map')    return { v: 'int', n: BigInt(v.entries.size) }
        throw new VError(`len(): 지원하지 않는 타입`)
      }
      case 'cap': {
        // 간단히 len과 동일하게 처리
        const v = args[0]
        if (!v) return { v: 'int', n: 0n }
        if (v.v === 'array') return { v: 'int', n: BigInt(v.elems.length) }
        return { v: 'int', n: 0n }
      }

      // ── 수학 ─────────────────────────────────────
      case 'abs': {
        const v = args[0]
        if (v?.v === 'int')   return { v: 'int',   n: v.n < 0n ? -v.n : v.n }
        if (v?.v === 'float') return { v: 'float', f: Math.abs(v.f) }
        throw new VError(`abs(): 숫자 타입 필요`)
      }
      case 'min': {
        const a = args[0], b = args[1]
        if (a?.v === 'int' && b?.v === 'int')
          return a.n < b.n ? a : b
        if ((a?.v === 'float' || a?.v === 'int') && (b?.v === 'float' || b?.v === 'int')) {
          const af = a.v === 'float' ? a.f : Number(a.n)
          const bf = b.v === 'float' ? b.f : Number(b.n)
          return af < bf ? a : b
        }
        throw new VError(`min(): 숫자 타입 필요`)
      }
      case 'max': {
        const a = args[0], b = args[1]
        if (a?.v === 'int' && b?.v === 'int')
          return a.n > b.n ? a : b
        if ((a?.v === 'float' || a?.v === 'int') && (b?.v === 'float' || b?.v === 'int')) {
          const af = a.v === 'float' ? a.f : Number(a.n)
          const bf = b.v === 'float' ? b.f : Number(b.n)
          return af > bf ? a : b
        }
        throw new VError(`max(): 숫자 타입 필요`)
      }

      // ── typeof / sizeof ───────────────────────────
      case 'typeof': {
        const v = args[0]
        const typeName = v ? v.v : 'void'
        return { v: 'string', s: typeName }
      }
      case 'sizeof': {
        // 단순화: 고정 크기 반환
        return { v: 'int', n: 8n }
      }

      // ── exit ──────────────────────────────────────
      case 'exit': {
        const code = args[0]?.v === 'int' ? Number(args[0].n) : 0
        process.exit(code)
      }

      default:
        throw new VError(`내장 함수 없음: '${name}'`, expr.pos)
    }
  }
}
